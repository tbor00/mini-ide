import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalHandle } from "./Terminal";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface PlayBarProps {
  token: string;
  terminalRef: React.RefObject<TerminalHandle>;
  terminalSessionNames: string[];
  /**
   * The folder currently focused in the file explorer. Used as the
   * default cwd when the Play config modal opens for the first time,
   * so `npm run dev` runs in the user's project instead of wherever
   * the mini-ide server happens to be running.
   */
  defaultCwd: string;
  onRequestTerminalTab: () => void;
}

// Maximum time we wait for cloudflared to print its public URL before
// giving up and stopping the poller. If the user's port never opened,
// cloudflared retries forever — we shouldn't.
const TUNNEL_POLL_TIMEOUT_MS = 45_000;

interface PlayConfig {
  command: string;
  port: number;
  tunnel: "cloudflared" | "none";
  cwd: string;
}

const STORAGE_KEY = "ide_play_config_v1";
// Single log path — cloudflared tees its output here and the UI polls it
// to extract the public trycloudflare.com URL.
const TUNNEL_LOG_PATH = "/tmp/mini-ide-play-tunnel.log";
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const PLAY_TERMINAL_NAME = "Play";

function loadConfig(): PlayConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.command === "string" && typeof parsed?.port === "number") {
      return {
        command: parsed.command,
        port: parsed.port,
        tunnel: parsed.tunnel === "none" ? "none" : "cloudflared",
        cwd: typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : "/",
      };
    }
  } catch {}
  return null;
}

// Escape a path for safe inclusion inside a bash double-quoted string.
function bashDoubleQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function saveConfig(cfg: PlayConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// Dev servers (Next, Vite, etc.) bind to localhost only by default,
// which means cloudflared's tunnel either can't reach the origin or
// serves assets that point back to "localhost" — the browser loading
// the trycloudflare.com page then hangs. Prepending HOSTNAME/HOST env
// vars forces both Next (reads HOSTNAME) and Vite 5+ (reads HOST) to
// bind to 0.0.0.0 without caring about which framework it is or
// whether the command is `npm run dev`, `pnpm dev`, `next dev`, etc.
// We skip if the user already passed a host flag or set the env var.
function ensureExternalBind(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return command;

  const isDevCmd =
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/.test(trimmed) ||
    /\b(next|vite|remix|astro|nuxt)\s+dev\b/.test(trimmed) ||
    /\bvite\b/.test(trimmed);
  if (!isDevCmd) return command;

  const hasHostFlag = /(^|\s)(-H|--hostname|--host)(\s|=)/.test(trimmed);
  const hasHostEnv = /(^|\s)(HOST|HOSTNAME)=/.test(trimmed);
  if (hasHostFlag || hasHostEnv) return command;

  return `HOSTNAME=0.0.0.0 HOST=0.0.0.0 ${trimmed}`;
}

// Best-effort autodetect based on files in the chosen project folder.
async function detectPreset(token: string, cwd: string): Promise<Partial<PlayConfig>> {
  try {
    const res = await fetch(`/api/fs/list?path=${encodeURIComponent(cwd)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return {};
    const data = await res.json();
    const entries: Array<{ name: string }> = data?.entries || [];
    const names = new Set(entries.map((e) => e.name));
    if (names.has("next.config.js") || names.has("next.config.ts") || names.has("next.config.mjs")) {
      return { command: "npm run dev", port: 3000 };
    }
    if (names.has("vite.config.js") || names.has("vite.config.ts")) {
      return { command: "npm run dev", port: 5173 };
    }
    if (names.has("package.json")) {
      return { command: "npm run dev", port: 3000 };
    }
    if (names.has("manage.py")) {
      return { command: "python manage.py runserver 0.0.0.0:8000", port: 8000 };
    }
    if (names.has("pyproject.toml") || names.has("requirements.txt")) {
      return { command: "uvicorn main:app --host 0.0.0.0 --port 8000", port: 8000 };
    }
  } catch {}
  return {};
}

// Builds the command we type into the Play terminal. We do NOT wrap
// the user command in `bash -c '...'` because that requires escaping
// any single quote the user happens to include (e.g. `node -e 'x'`).
// Instead we send a subshell grouping — bash is already running in
// the pty, it parses the line itself, so quoting in the user command
// is handled naturally by the shell.
function buildPlayCommand(cfg: PlayConfig): string {
  const clearLog = `: > ${TUNNEL_LOG_PATH}`;
  const cdCmd = `cd ${bashDoubleQuote(cfg.cwd || "/")}`;
  // Kill anything still holding the port from a previous Play run.
  // When the user hits Detener, the dev server's child processes
  // sometimes take a second or two to actually release the port, so
  // the next run either fails to bind or silently falls back to the
  // next free port — and cloudflared ends up pointing at nothing.
  // `lsof -ti:PORT` prints pids; we SIGKILL them and swallow errors
  // so a clean slate doesn't cause the command to fail.
  // Aggressively clear anything left over from a previous Play run:
  // 1. Kill whatever is bound to the target port (dev server)
  // 2. Kill every cloudflared process this user owns — `pkill -x` on the
  //    exact name catches both `cloudflared` and subcommand invocations;
  //    add an `-f` fallback for platforms where pkill's -x is strict.
  // 3. Kill any orphan `next-server` process (Next spawns a worker that
  //    outlives the parent when signalled, so `lsof` on the port alone
  //    sometimes misses it).
  // 4. Give the kernel a beat to release the TCP socket.
  // Kill anything holding the port, then actively wait until the port
  // is actually FREE before proceeding. A fixed sleep isn't enough:
  // Next.js graceful shutdown can keep the socket in LISTEN for a
  // second or two, and if we start the new dev server (or the probe)
  // while the old one is still bound, either the new server fails to
  // bind, or the probe gets a 200 from the dying old process and hands
  // cloudflared a port that's about to go dark.
  const freePort = [
    `(lsof -ti tcp:${cfg.port} 2>/dev/null | xargs -r kill -9 2>/dev/null || true)`,
    `(pkill -9 -x cloudflared 2>/dev/null || true)`,
    `(pkill -9 -f next-server 2>/dev/null || true)`,
    // Wait up to ~5s for the port to be released.
    `for i in $(seq 1 50); do`,
    `  if ! lsof -i tcp:${cfg.port} -sTCP:LISTEN >/dev/null 2>&1; then break; fi`,
    `  sleep 0.1`,
    `done`,
  ].join("; ");
  if (cfg.tunnel === "none") {
    return `${clearLog}; ${freePort}; ${cdCmd} && ${cfg.command}`;
  }
  const port = cfg.port;
  // Wait until the dev server is actually answering on the loopback
  // before starting cloudflared. We try both IPv4 and IPv6 just to
  // detect readiness — Next.js 14 with turbopack on macOS sometimes
  // binds only to `::` (ignores HOSTNAME=0.0.0.0), so 127.0.0.1 may
  // never answer while [::1] does. The actual origin we hand to
  // cloudflared is `localhost` regardless — cloudflared's Go resolver
  // handles IPv4/IPv6 fallback via /etc/hosts, and passing an IPv6
  // literal like http://[::1]:PORT to cloudflared has known issues
  // where the tunnel registers fine but requests to the origin fail
  // silently.
  const probe = [
    `PLAY_READY=0`,
    `for i in $(seq 1 120); do`,
    `  if curl -sS -m 1 -o /dev/null "http://127.0.0.1:${port}" 2>/dev/null; then PLAY_READY=1; break; fi`,
    `  if curl -sS -m 1 -o /dev/null "http://[::1]:${port}" 2>/dev/null; then PLAY_READY=1; break; fi`,
    `  sleep 0.5`,
    `done`,
    `if [ "$PLAY_READY" = "1" ]; then echo "[play] dev server up on :${port}, starting tunnel"; else echo "[play] timed out waiting for :${port}, starting tunnel anyway"; fi`,
  ].join("; ");
  // --http-host-header rewrites the Host header cloudflared sends to
  // the origin. Without it, the dev server sees
  // `Host: xxx.trycloudflare.com` and Vite/Next/webpack-dev-server
  // block the request as a disallowed host.
  const tunnelCmd = `${probe}; cloudflared tunnel --url "http://localhost:${port}" --http-host-header "localhost:${port}" 2>&1 | tee -a ${TUNNEL_LOG_PATH}`;
  // Subshell + trap so Ctrl+C tears down the whole process group and
  // the trap doesn't leak into the user's interactive shell afterwards.
  return `${clearLog}; ${freePort}; ( ${cdCmd} && trap 'kill 0' INT TERM EXIT; (${cfg.command}) & ( ${tunnelCmd} ) & wait )`;
}

export function PlayBar({
  token,
  terminalRef,
  terminalSessionNames,
  defaultCwd,
  onRequestTerminalTab,
}: PlayBarProps) {
  const [config, setConfig] = useState<PlayConfig | null>(() => loadConfig());
  const [showModal, setShowModal] = useState(false);
  useEscapeKey(showModal, () => setShowModal(false));
  const [draft, setDraft] = useState<PlayConfig>({
    command: "",
    port: 3000,
    tunnel: "cloudflared",
    cwd: "/",
  });
  // `intent` = user clicked Play and we fired runInNewSession, but the
  // Terminal hasn't bubbled the session name back up to us yet. `running`
  // is derived from either the intent or the presence of the Play
  // session in the terminal's session list — whichever is true. This
  // avoids the race where setRunning(true) and the parent's
  // terminalSessionNames update happen in different renders, letting a
  // naive "reset if Play isn't in the list" effect flip us off instantly.
  const [intent, setIntent] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  // Cache-buster appended to the href we open in the browser so that a
  // second Play (new tunnel hostname) doesn't load stale HTML, service
  // workers, or other per-origin state left over from an earlier run.
  // We keep the bare `tunnelUrl` for display and copy-to-clipboard —
  // users sharing the URL shouldn't see a random `?t=...` query.
  const tunnelHref = useMemo(() => {
    if (!tunnelUrl) return null;
    const sep = tunnelUrl.includes("?") ? "&" : "?";
    return `${tunnelUrl}${sep}_t=${Date.now()}`;
  }, [tunnelUrl]);
  const [cwdWarning, setCwdWarning] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollTimeoutRef = useRef<number | null>(null);
  const playPresent = terminalSessionNames.includes(PLAY_TERMINAL_NAME);
  const running = intent || playPresent;
  // Track whether the Play session has ever actually appeared during
  // this intent — so we know to clear intent if it later disappears.
  const playSeenRef = useRef(false);

  // When the user is editing the draft, check that the chosen cwd
  // contains the files the command needs. Specifically, if the command
  // invokes a Node package manager we warn when there's no package.json
  // directly in that folder — npm will otherwise walk up the directory
  // tree and happily run a `dev` script from an unrelated project
  // (this is exactly how the mini-ide repo ended up being booted when
  // the user pointed Play at mini-ide/data/).
  useEffect(() => {
    if (!showModal) return;
    let cancelled = false;
    const cmd = draft.command.trim();
    const isNodeCmd = /^(npm|pnpm|yarn|bun)\b/.test(cmd);
    if (!isNodeCmd || !draft.cwd) {
      setCwdWarning(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(draft.cwd)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (!cancelled) setCwdWarning("No se pudo leer el directorio.");
          return;
        }
        const data = await res.json();
        const entries: Array<{ name: string }> = data?.entries || [];
        const hasPkg = entries.some((e) => e.name === "package.json");
        if (cancelled) return;
        setCwdWarning(
          hasPkg
            ? null
            : "Este directorio no tiene package.json — npm buscará uno en carpetas padre y puede ejecutar otro proyecto."
        );
      } catch {
        if (!cancelled) setCwdWarning(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.command, draft.cwd, showModal, token]);

  // When the user opens the modal, seed the draft from saved config or
  // autodetect. Autodetect only runs when there's no saved config.
  const openModal = useCallback(async () => {
    const seedCwd = (config?.cwd && config.cwd !== "/" ? config.cwd : defaultCwd) || "/";
    if (config) {
      setDraft({ ...config, cwd: seedCwd });
    } else {
      const preset = await detectPreset(token, seedCwd);
      setDraft({
        command: preset.command ?? "npm run dev",
        port: preset.port ?? 3000,
        tunnel: "cloudflared",
        cwd: seedCwd,
      });
    }
    setShowModal(true);
  }, [config, defaultCwd, token]);

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollTimeoutRef.current != null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/fs/read?path=${encodeURIComponent(TUNNEL_LOG_PATH)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const content: string = data?.content || "";
        // Prefer the *last* URL in the log — if a zombie cloudflared
        // from the previous run wrote its URL near the top before we
        // killed it, the new one will be below and we want that.
        const matches = content.match(TUNNEL_URL_REGEX);
        if (matches && matches.length > 0) {
          setTunnelUrl(matches[matches.length - 1]);
          stopPolling();
        }
      } catch {}
    }, 1000);
    pollTimeoutRef.current = window.setTimeout(() => {
      stopPolling();
    }, TUNNEL_POLL_TIMEOUT_MS);
  }, [stopPolling, token]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // If the Play terminal disappears (user closed the tab, process
  // crashed, server reaped the pty, etc.) reset local state. We only
  // act *after* we've actually seen it appear at least once, otherwise
  // the first render after clicking Play would reset intent before
  // the Terminal bubbles up its new session name.
  useEffect(() => {
    if (playPresent) {
      // First time we see the Play session during this lifetime —
      // if we don't already have a URL and polling isn't running,
      // kick off a poll to recover it from the tunnel log. This
      // handles the page-reload case where a Play session was left
      // running from a previous tab: playPresent is true immediately
      // on mount but component state starts empty.
      if (!playSeenRef.current) {
        const cfg = config ?? loadConfig();
        if (cfg?.tunnel === "cloudflared" && !tunnelUrl && pollRef.current == null) {
          startPolling();
        }
      }
      playSeenRef.current = true;
      return;
    }
    if (!playSeenRef.current) return;
    playSeenRef.current = false;
    setIntent(false);
    setTunnelUrl(null);
    stopPolling();
  }, [playPresent, stopPolling, startPolling, config, tunnelUrl]);

  const doPlay = useCallback(
    (rawCfg: PlayConfig) => {
      const cfg: PlayConfig = { ...rawCfg, command: ensureExternalBind(rawCfg.command) };
      saveConfig(cfg);
      setConfig(cfg);
      setTunnelUrl(null);
      onRequestTerminalTab();
      const cmd = buildPlayCommand(cfg);
      terminalRef.current?.runInNewSession(PLAY_TERMINAL_NAME, cmd);
      setIntent(true);
      if (cfg.tunnel === "cloudflared") {
        // Truncate the tunnel log *before* polling so we never pick up
        // the previous run's URL. The `: > LOG` in buildPlayCommand
        // also clears it, but that runs inside the pty which may still
        // be connecting — the poller can otherwise race and read the
        // old URL from disk before the shell has executed the redirect.
        fetch("/api/fs/write", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ path: TUNNEL_LOG_PATH, content: "" }),
        })
          .catch(() => {})
          .finally(() => startPolling());
      }
    },
    [onRequestTerminalTab, startPolling, terminalRef, token]
  );

  const handlePlayClick = useCallback(() => {
    if (running) {
      // Ctrl+C into the Play session — the trap in buildPlayCommand
      // tears down both the user command and cloudflared together.
      onRequestTerminalTab();
      terminalRef.current?.interruptSession(PLAY_TERMINAL_NAME);
      setIntent(false);
      setTunnelUrl(null);
      stopPolling();
      playSeenRef.current = false;
      return;
    }
    if (!config) {
      openModal();
      return;
    }
    doPlay(config);
  }, [config, doPlay, onRequestTerminalTab, openModal, running, stopPolling, terminalRef]);

  const submitModal = useCallback(() => {
    if (!draft.command.trim()) return;
    if (!Number.isFinite(draft.port) || draft.port <= 0) return;
    if (!draft.cwd.trim()) return;
    setShowModal(false);
    doPlay(draft);
  }, [doPlay, draft]);

  const copyUrl = useCallback(() => {
    if (!tunnelUrl) return;
    navigator.clipboard?.writeText(tunnelUrl).catch(() => {});
  }, [tunnelUrl]);

  const waitingForTunnel =
    running && !tunnelUrl && config?.tunnel === "cloudflared";
  const statusText = !running
    ? null
    : waitingForTunnel
    ? "Esperando URL pública…"
    : running && config?.tunnel === "none"
    ? "En vivo (sin tunnel)"
    : "En vivo";

  return (
    <>
      <div className="flex items-center gap-2">
        {!running ? (
          <>
            <button
              onClick={handlePlayClick}
              title="Levantar proyecto + tunnel"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play
            </button>
            <button
              onClick={openModal}
              title="Configurar comando y puerto"
              className="p-1 rounded ide-tab transition-colors"
              aria-label="Configurar Play"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </>
        ) : (
          <div className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/10">
            <span className="relative flex h-2 w-2" aria-hidden>
              {waitingForTunnel ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
                </>
              ) : (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </>
              )}
            </span>
            <button
              onClick={onRequestTerminalTab}
              title="Ver la terminal del Play"
              className="text-[11px] font-medium text-emerald-300 hover:text-emerald-200"
            >
              {statusText}
            </button>
            {tunnelUrl ? (
              <div className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-black/30 font-mono max-w-[280px]">
                <a
                  href={tunnelHref ?? tunnelUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={tunnelUrl}
                  className="truncate text-emerald-200 hover:text-white underline-offset-2 hover:underline"
                >
                  {tunnelUrl.replace(/^https?:\/\//, "")}
                </a>
                <button onClick={copyUrl} title="Copiar URL" className="p-0.5 hover:opacity-70 shrink-0">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15V5a2 2 0 012-2h10" />
                  </svg>
                </button>
                <a href={tunnelHref ?? tunnelUrl} target="_blank" rel="noreferrer" title="Abrir en nueva pestaña" className="p-0.5 hover:opacity-70 shrink-0">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
            ) : waitingForTunnel ? (
              <svg className="w-3.5 h-3.5 animate-spin text-amber-300" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : null}
            <button
              onClick={handlePlayClick}
              title="Detener Play"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
              Detener
            </button>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowModal(false)}>
          <div
            className="w-full max-w-md rounded-lg ide-panel border ide-border p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold mb-3">Configurar Play</h2>
            <label className="block text-xs mb-1 opacity-70">Directorio del proyecto</label>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={draft.cwd}
                onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                placeholder="/ruta/al/proyecto"
                className="flex-1 px-2 py-1.5 text-xs rounded ide-tab font-mono"
              />
              <button
                type="button"
                onClick={() => setDraft({ ...draft, cwd: defaultCwd || "/" })}
                title="Usar la carpeta seleccionada en el explorador"
                className="px-2 py-1 text-xs rounded ide-tab transition-colors"
              >
                Usar actual
              </button>
            </div>
            {cwdWarning && (
              <div className="mb-3 px-2 py-1.5 text-[11px] rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">
                ⚠ {cwdWarning}
              </div>
            )}
            <label className="block text-xs mb-1 opacity-70">Comando</label>
            <input
              type="text"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npm run dev"
              className="w-full px-2 py-1.5 text-xs rounded ide-tab mb-1 font-mono"
              autoFocus
            />
            {ensureExternalBind(draft.command) !== draft.command.trim() && draft.command.trim() && (
              <div className="mb-3 px-2 py-1.5 text-[11px] rounded bg-sky-500/10 border border-sky-500/40 text-sky-200">
                Se ejecutará como{" "}
                <span className="font-mono opacity-90">{ensureExternalBind(draft.command)}</span>{" "}
                para que el tunnel pueda alcanzar tu app (fuerza bind a <span className="font-mono">0.0.0.0</span>).
              </div>
            )}
            {ensureExternalBind(draft.command) === draft.command.trim() && <div className="mb-3" />}
            <label className="block text-xs mb-1 opacity-70">Puerto local</label>
            <input
              type="number"
              value={draft.port}
              onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
              className="w-full px-2 py-1.5 text-xs rounded ide-tab mb-3 font-mono"
            />
            <label className="block text-xs mb-1 opacity-70">Tunnel</label>
            <div className="flex gap-2 mb-4">
              {(["cloudflared", "none"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setDraft({ ...draft, tunnel: opt })}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    draft.tunnel === opt ? "ide-tab-active" : "ide-tab"
                  }`}
                >
                  {opt === "cloudflared" ? "Cloudflared (público)" : "Ninguno"}
                </button>
              ))}
            </div>
            <p className="text-[11px] opacity-60 mb-3">
              Se abrirá una terminal llamada <span className="font-mono">Play</span> con el comando y el tunnel. Podés detenerlo desde la barra superior.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-3 py-1 text-xs rounded ide-tab transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={submitModal}
                className="px-3 py-1 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
              >
                Guardar y ejecutar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
