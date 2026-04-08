import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalHandle } from "./Terminal";

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
const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
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
  if (cfg.tunnel === "none") {
    return `${clearLog}; ${cdCmd} && ${cfg.command}`;
  }
  const tunnelCmd = `cloudflared tunnel --url http://localhost:${cfg.port} 2>&1 | tee -a ${TUNNEL_LOG_PATH}`;
  // Subshell + trap so Ctrl+C tears down the whole process group and
  // the trap doesn't leak into the user's interactive shell afterwards.
  return `${clearLog}; ( ${cdCmd} && trap 'kill 0' INT TERM EXIT; (${cfg.command}) & (${tunnelCmd}) & wait )`;
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
  const [draft, setDraft] = useState<PlayConfig>({
    command: "",
    port: 3000,
    tunnel: "cloudflared",
    cwd: "/",
  });
  const [running, setRunning] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollTimeoutRef = useRef<number | null>(null);

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
        const match = TUNNEL_URL_REGEX.exec(data?.content || "");
        if (match) {
          setTunnelUrl(match[0]);
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
  // crashed and server reaped the pty, etc.) reset local state so the
  // button stops saying "Detener".
  useEffect(() => {
    if (!running) return;
    if (!terminalSessionNames.includes(PLAY_TERMINAL_NAME)) {
      setRunning(false);
      setTunnelUrl(null);
      stopPolling();
    }
  }, [running, stopPolling, terminalSessionNames]);

  const doPlay = useCallback(
    (cfg: PlayConfig) => {
      saveConfig(cfg);
      setConfig(cfg);
      setTunnelUrl(null);
      onRequestTerminalTab();
      const cmd = buildPlayCommand(cfg);
      terminalRef.current?.runInNewSession(PLAY_TERMINAL_NAME, cmd);
      setRunning(true);
      if (cfg.tunnel === "cloudflared") startPolling();
    },
    [onRequestTerminalTab, startPolling, terminalRef]
  );

  const handlePlayClick = useCallback(() => {
    if (running) {
      // Ctrl+C into the Play session — the trap in buildPlayCommand
      // tears down both the user command and cloudflared together.
      onRequestTerminalTab();
      terminalRef.current?.interruptSession(PLAY_TERMINAL_NAME);
      setRunning(false);
      setTunnelUrl(null);
      stopPolling();
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
  const label = running ? (waitingForTunnel ? "Iniciando…" : "Detener") : "Play";

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={handlePlayClick}
          title={running ? "Detener" : "Levantar proyecto + tunnel"}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors ${
            running ? "bg-red-600 hover:bg-red-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"
          }`}
        >
          {running ? (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
          {label}
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
        {tunnelUrl && (
          <div className="flex items-center gap-1 px-2 py-1 text-[11px] rounded ide-tab max-w-[320px]">
            <span className="truncate" title={tunnelUrl}>
              {tunnelUrl.replace(/^https?:\/\//, "")}
            </span>
            <button onClick={copyUrl} title="Copiar URL" className="p-0.5 hover:opacity-70">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15V5a2 2 0 012-2h10" />
              </svg>
            </button>
            <a href={tunnelUrl} target="_blank" rel="noreferrer" title="Abrir" className="p-0.5 hover:opacity-70">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
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
            <label className="block text-xs mb-1 opacity-70">Comando</label>
            <input
              type="text"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npm run dev"
              className="w-full px-2 py-1.5 text-xs rounded ide-tab mb-3 font-mono"
              autoFocus
            />
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
