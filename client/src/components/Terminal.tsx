import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { useEscapeKey } from "../hooks/useEscapeKey";

// Mobile detection: coarse pointer OR narrow viewport. We use it once
// at module load for xterm config (font/line-height) and again in the
// render to tweak padding and touch targets. A touch device reporting
// a desktop-wide viewport (iPad in landscape) still gets mobile-grade
// touch behavior, which is what we want.
const isMobileViewport = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches ||
    window.matchMedia?.("(max-width: 768px)").matches);

export interface TerminalProps {
  token: string;
  onSessionsChange?: (visibleNames: string[]) => void;
}

export interface TerminalHandle {
  sendCommand: (cmd: string) => void;
  runInNewSession: (name: string, command: string) => void;
  interruptSession: (name: string) => void;
}

interface TermSession {
  id: number;
  serverSessionId: string | null;
  name: string;
  term: XTerm;
  fitAddon: FitAddon;
  ws: WebSocket | null;
  connected: boolean;
  containerEl: HTMLDivElement;
  observer: ResizeObserver;
  onResizeEnd: (() => void) | null;
  reconnectTimer: number | null;
  shouldReconnect: boolean;
  closedLocally: boolean;
  deferredTeardown: boolean;
  pendingInitialCommand: string | null;
}

interface RemoteSessionInfo {
  id: string;
  name: string;
}

function isRemoteSessionInfo(item: unknown): item is RemoteSessionInfo {
  if (typeof item !== "object" || item === null) return false;
  const maybe = item as { id?: unknown; name?: unknown };
  return typeof maybe.id === "string" && typeof maybe.name === "string";
}

const TERM_THEME = {
  background: "#0a0a0b",
  foreground: "#f5f5f5",
  cursor: "#a1a1aa",
  selectionBackground: "#2a2a2f",
  black: "#0a0a0b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#71717a",
  magenta: "#a78bfa",
  cyan: "#a1a1aa",
  white: "#fafafa",
};

let nextId = 1;

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { token, onSessionsChange },
  ref
) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const overlayTextareaRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const sessionsRef = useRef<TermSession[]>([]);
  const [sessions, setSessions] = useState<{ id: number; name: string; connected: boolean }[]>([]);
  const onSessionsChangeRef = useRef(onSessionsChange);
  useEffect(() => {
    onSessionsChangeRef.current = onSessionsChange;
  }, [onSessionsChange]);
  useEffect(() => {
    onSessionsChangeRef.current?.(sessions.map((s) => s.name));
  }, [sessions]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const activeIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const [showInputOverlay, setShowInputOverlay] = useState(false);
  const [overlayText, setOverlayText] = useState("");
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEscapeKey(showShortcuts, () => setShowShortcuts(false));
  useEscapeKey(showRenameDialog, () => setShowRenameDialog(false));
  useEscapeKey(showInputOverlay, () => {
    setOverlayText("");
    setShowInputOverlay(false);
  });
  // True when the active terminal is scrolled up from the bottom. Used
  // to show a "jump to bottom" button on mobile, where dragging the
  // xterm viewport all the way down is frustratingly unreliable.
  const [scrolledUp, setScrolledUp] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileViewport);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse), (max-width: 768px)");
    const handler = () => setIsMobile(isMobileViewport());
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);
  const createSessionRef = useRef<
    ((
      name?: string,
      options?: { serverSessionId?: string | null; activate?: boolean; initialCommand?: string }
    ) => TermSession) | null
  >(null);
  const reconcileRemoteSessionsRef = useRef<((remoteSessions: RemoteSessionInfo[]) => void) | null>(null);
  // serverSessionIds the user closed locally but whose close hasn't been
  // acknowledged by the server yet. Skip reconcile-recreating them.
  const pendingClosedRef = useRef<Set<string>>(new Set());

  const updateSessionState = useCallback(() => {
    setSessions(
      sessionsRef.current
        .filter((s) => !s.closedLocally)
        .map((s) => ({ id: s.id, name: s.name, connected: s.connected }))
    );
  }, []);

  const connectSession = useCallback(
    (session: TermSession) => {
      if (!session.shouldReconnect) return;

      if (session.ws) {
        session.ws.onclose = null;
        session.ws.onerror = null;
        session.ws.close();
      }

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams();
      params.set("token", token);
      params.set("name", session.name);
      if (session.serverSessionId) params.set("sessionId", session.serverSessionId);
      const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal?${params.toString()}`);
      session.ws = ws;

      ws.onopen = () => {
        session.connected = true;
        updateSessionState();
        ws.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
        if (session.pendingInitialCommand) {
          // Small delay so the shell prompt is ready before we type.
          const cmd = session.pendingInitialCommand;
          session.pendingInitialCommand = null;
          setTimeout(() => {
            if (session.ws?.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify({ type: "input", data: cmd + "\n" }));
            }
          }, 250);
        }
      };

      ws.binaryType = "arraybuffer";
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") {
          // Binary frame = raw pty output (hot path, no JSON)
          const data = e.data instanceof ArrayBuffer ? e.data : null;
          if (data) session.term.write(new Uint8Array(data));
          return;
        }
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "session_meta") {
            if (typeof msg.sessionId === "string") session.serverSessionId = msg.sessionId;
            if (typeof msg.name === "string") session.name = msg.name;
            updateSessionState();
            // The user already hit close before the server assigned us
            // an id. Kill the orphan pty now so it doesn't show up in
            // the next sessions_sync and get recreated, and finish the
            // local teardown that closeSession deferred.
            if (session.closedLocally && typeof msg.sessionId === "string") {
              pendingClosedRef.current.add(msg.sessionId);
              try {
                ws.send(JSON.stringify({ type: "close_session" }));
              } catch {}
              try { ws.close(); } catch {}
              finalizeDeferredClose(session);
            }
            return;
          }
          if (msg.type === "sessions_sync") {
            if (Array.isArray(msg.sessions)) {
              const remoteSessions = (msg.sessions as unknown[]).filter(isRemoteSessionInfo);
              reconcileRemoteSessionsRef.current?.(remoteSessions);
            }
            return;
          }
          if (msg.type === "output") {
            session.term.write(msg.data || "");
            return;
          }
          if (msg.type === "session_closed") {
            session.connected = false;
            session.shouldReconnect = false;
            session.term.write("\r\n\x1b[91m[Sesion finalizada]\x1b[0m\r\n");
            updateSessionState();
            return;
          }
        } catch {
          session.term.write(e.data);
        }
      };

      ws.onclose = () => {
        session.ws = null;
        session.connected = false;
        updateSessionState();
        // Connection died before session_meta arrived on a session the
        // user already asked to close. Nothing to clean up on the server
        // (the pty never finished spawning, or we'll see it as orphan in
        // the next sync and pendingClosedRef will ignore it once we know
        // its id). Just finish the deferred local teardown.
        if (session.closedLocally && session.deferredTeardown) {
          finalizeDeferredClose(session);
          return;
        }
        if (!session.shouldReconnect) return;
        if (session.reconnectTimer != null) return;
        session.term.write("\r\n\x1b[93m[Conexion perdida. Reconectando...]\x1b[0m\r\n");
        session.reconnectTimer = window.setTimeout(() => {
          session.reconnectTimer = null;
          const stillExists = sessionsRef.current.some((s) => s.id === session.id);
          if (!stillExists || !session.shouldReconnect) return;
          connectSession(session);
        }, 1500);
      };

      ws.onerror = () => {
        session.connected = false;
        updateSessionState();
      };
    },
    [token, updateSessionState]
  );

  const createSession = useCallback(
    (
      name?: string,
      options?: { serverSessionId?: string | null; activate?: boolean; initialCommand?: string }
    ) => {
      const id = nextId++;
      const mobile = isMobileViewport();
      const containerEl = document.createElement("div");
      // Extra horizontal padding on mobile keeps characters away from
      // the edge of the viewport so the last column isn't clipped by
      // safe-area insets on notched phones.
      containerEl.style.cssText = `width:100%;height:100%;display:none;padding:${mobile ? "8px 10px" : "4px"};`;

      const term = new XTerm({
        cursorBlink: true,
        // Keep the same metrics on mobile as on desktop. Earlier we
        // bumped fontSize/lineHeight/letterSpacing for "readability",
        // but WebGL/Canvas renderers don't play well with non-unit
        // lineHeight and fractional letterSpacing — they end up
        // drawing characters 2x larger than requested and the first
        // line scrolls out of view. The extra breathing room on
        // mobile comes from the containerEl's padding instead.
        fontSize: 14,
        lineHeight: 1.0,
        letterSpacing: 0,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: TERM_THEME,
        // Crank up touch scroll so a single swipe actually moves a
        // useful amount of lines. The default (1) feels glued on a
        // phone where swipes are short.
        scrollSensitivity: mobile ? 3 : 1,
        fastScrollSensitivity: mobile ? 8 : 5,
        // Larger scrollback buffer — on a phone you can't open another
        // terminal side-by-side to keep context, so history matters.
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (wrapperRef.current) {
        wrapperRef.current.appendChild(containerEl);
      }

      term.open(containerEl);
      // Don't fit yet — containerEl is display:none so width is 0. The
      // activate effect will fit once the terminal becomes visible.

      // Try WebGL first (5-10x faster on mobile GPUs than the DOM
      // renderer), fall back to Canvas, fall back to DOM if both blow
      // up. IMPORTANT: both WebglAddon and CanvasAddon must be loaded
      // *after* `term.open()` — they attach to the rendering surface
      // that open() creates, and loading them before is a silent
      // no-op on some browsers and throws on others.
      // WebGL can lose its context (OS kills the GL context when the
      // tab goes background); dispose the addon so xterm falls back
      // to DOM rendering instead of freezing.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try { webgl.dispose(); } catch {}
        });
        term.loadAddon(webgl);
      } catch {
        try {
          term.loadAddon(new CanvasAddon());
        } catch {
          // Fall back to DOM renderer — nothing to do, it's the default.
        }
      }

      // On iOS/Android the xterm viewport element sometimes refuses
      // to scroll when the swipe starts on the canvas: browsers
      // require `touch-action` to be declared for panning to be
      // forwarded to the nearest scrollable ancestor reliably.
      // `-webkit-overflow-scrolling: touch` enables momentum scroll
      // on iOS. Applied to the viewport (xterm's internal scroller).
      const viewport = containerEl.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport) {
        viewport.style.touchAction = "pan-y";
        viewport.style.setProperty("-webkit-overflow-scrolling", "touch");
        viewport.style.overscrollBehavior = "contain";
      }

      // Track whether the user scrolled up from the bottom so the
      // mobile "jump to bottom" button can hide itself once they're
      // already at the tail. Only the *active* terminal drives this
      // state — we compare ids in the callback.
      term.onScroll(() => {
        const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY - 1;
        if (activeIdRef.current === id) {
          setScrolledUp(!atBottom);
        }
      });

      // fitAddon.fit() is expensive (layout math + resize message to
      // the pty + canvas re-create for WebGL). Two guards here:
      //
      // 1. Coalesce ResizeObserver bursts into 1 fit per animation
      //    frame so a window resize doesn't fire 30 fits.
      // 2. While the IDE divider is being dragged
      //    (document.body[data-ide-resizing]) skip fits ENTIRELY.
      //    Running fit() at 60Hz against a WebGL canvas causes a
      //    visible flicker as the canvas clears each frame. We
      //    catch up with a single fit on the "ide:resize-end" event
      //    once the user releases the mouse.
      let fitRafPending = false;
      const runFit = () => {
        if (containerEl.style.display === "none") return;
        if (containerEl.clientWidth === 0 || containerEl.clientHeight === 0) return;
        try { fitAddon.fit(); } catch {}
      };
      const scheduleFit = () => {
        if (fitRafPending) return;
        fitRafPending = true;
        requestAnimationFrame(() => {
          fitRafPending = false;
          runFit();
        });
      };
      const observer = new ResizeObserver(() => {
        if (containerEl.style.display === "none") return;
        if (containerEl.clientWidth === 0 || containerEl.clientHeight === 0) return;
        if (document.body.dataset.ideResizing === "1") return;
        scheduleFit();
      });
      observer.observe(containerEl);

      // Single catch-up fit once the divider drag ends. Stored on
      // the session so dropLocalSession / finalizeDeferredClose can
      // detach it when the terminal is disposed.
      const onResizeEnd = () => scheduleFit();
      window.addEventListener("ide:resize-end", onResizeEnd);

      const session: TermSession = {
        id,
        serverSessionId: options?.serverSessionId || null,
        name: name || (() => {
          const used = new Set<number>();
          for (const s of sessionsRef.current) {
            const m = /^Terminal (\d+)$/.exec(s.name);
            if (m) used.add(Number(m[1]));
          }
          let n = 1;
          while (used.has(n)) n++;
          return `Terminal ${n}`;
        })(),
        term,
        fitAddon,
        ws: null,
        connected: false,
        containerEl,
        observer,
        onResizeEnd,
        reconnectTimer: null,
        shouldReconnect: true,
        closedLocally: false,
        deferredTeardown: false,
        pendingInitialCommand: options?.initialCommand ?? null,
      };

      const textEncoder = new TextEncoder();
      term.onData((data) => {
        if (session.ws?.readyState === WebSocket.OPEN) {
          // Binary frame — server treats all binary WS messages as raw
          // pty input. Avoids JSON stringify/parse on the hot keystroke
          // path and keeps the frame as small as possible.
          session.ws.send(textEncoder.encode(data));
        }
      });

      term.onResize(({ cols, rows }) => {
        if (session.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      sessionsRef.current.push(session);
      connectSession(session);
      updateSessionState();

      if (options?.activate ?? true) {
        setActiveId(id);
      }

      return session;
    },
    [connectSession, updateSessionState]
  );

  useEffect(() => {
    createSessionRef.current = createSession;
  }, [createSession]);

  const dropLocalSession = useCallback(
    (id: number) => {
      const idx = sessionsRef.current.findIndex((s) => s.id === id);
      if (idx === -1) return;
      const session = sessionsRef.current[idx];
      session.shouldReconnect = false;
      if (session.reconnectTimer != null) {
        window.clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }
      session.ws?.close();
      session.observer.disconnect();
      if (session.onResizeEnd) {
        window.removeEventListener("ide:resize-end", session.onResizeEnd);
      }
      session.term.dispose();
      session.containerEl.remove();
      sessionsRef.current.splice(idx, 1);
      updateSessionState();
      setActiveId((current) => {
        if (current !== id) return current;
        const visible = sessionsRef.current.filter((s) => !s.closedLocally);
        const fallbackIdx = Math.min(idx, visible.length - 1);
        return visible[fallbackIdx]?.id ?? null;
      });
    },
    [updateSessionState]
  );

  const reconcileRemoteSessions = useCallback(
    (remoteSessions: RemoteSessionInfo[]) => {
      const localByRemoteId = new Map<string, TermSession>();
      for (const local of sessionsRef.current) {
        if (local.serverSessionId) {
          localByRemoteId.set(local.serverSessionId, local);
        }
      }

      const remoteIds = new Set<string>();
      const hasPendingLocal = sessionsRef.current.some((s) => !s.serverSessionId);
      for (const remote of remoteSessions) {
        remoteIds.add(remote.id);
        // Ignore remotes we're in the middle of closing locally — the
        // server just hasn't finished processing the close yet.
        if (pendingClosedRef.current.has(remote.id)) continue;
        const existing = localByRemoteId.get(remote.id);
        if (existing) {
          if (existing.name !== remote.name) {
            existing.name = remote.name;
            updateSessionState();
          }
          continue;
        }
        // Skip creating a local if we already have a just-created local
        // session waiting for its session_meta — it will claim this remote
        // once its own ws receives the assignment. Prevents duplicate tabs
        // on "add terminal".
        if (hasPendingLocal) continue;
        createSessionRef.current?.(remote.name, { serverSessionId: remote.id, activate: false });
      }

      const staleLocalIds: number[] = [];
      for (const local of sessionsRef.current) {
        if (local.serverSessionId && !remoteIds.has(local.serverSessionId)) {
          staleLocalIds.push(local.id);
        }
      }
      for (const staleId of staleLocalIds) {
        dropLocalSession(staleId);
      }
      // Any pendingClosed ids that are no longer in the remote list have
      // been confirmed closed — forget them.
      for (const id of Array.from(pendingClosedRef.current)) {
        if (!remoteIds.has(id)) pendingClosedRef.current.delete(id);
      }
    },
    [dropLocalSession, updateSessionState]
  );

  useEffect(() => {
    reconcileRemoteSessionsRef.current = reconcileRemoteSessions;
  }, [reconcileRemoteSessions]);

  const finalizeDeferredClose = useCallback((session: TermSession) => {
    if (!session.deferredTeardown) return;
    session.deferredTeardown = false;
    try { session.observer.disconnect(); } catch {}
    if (session.onResizeEnd) {
      try { window.removeEventListener("ide:resize-end", session.onResizeEnd); } catch {}
    }
    try { session.term.dispose(); } catch {}
    try { session.containerEl.remove(); } catch {}
    const idx = sessionsRef.current.findIndex((s) => s.id === session.id);
    if (idx !== -1) sessionsRef.current.splice(idx, 1);
  }, []);

  const closeSession = useCallback(
    (id: number) => {
      const idx = sessionsRef.current.findIndex((s) => s.id === id);
      if (idx === -1) return;
      const visibleCount = sessionsRef.current.filter((s) => !s.closedLocally).length;
      if (visibleCount <= 1) return;

      const session = sessionsRef.current[idx];
      session.closedLocally = true;
      if (session.serverSessionId) {
        pendingClosedRef.current.add(session.serverSessionId);
      }
      session.shouldReconnect = false;
      if (session.reconnectTimer != null) {
        window.clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }

      // If the ws is still connecting we don't yet know the serverSessionId,
      // so we can't tell the server to kill the pty and we can't add it to
      // pendingClosedRef. Closing the ws now would abort the upgrade — the
      // server would still spawn the pty and broadcast it to other tabs,
      // which would then recreate the terminal. Defer the teardown: hide
      // the UI, and let the session_meta handler (or onclose) finish the
      // cleanup once we know the id.
      const isConnecting = session.ws?.readyState === WebSocket.CONNECTING;
      if (isConnecting) {
        // Keep the session in sessionsRef so reconcileRemoteSessions sees
        // hasPendingLocal=true and other tabs don't recreate this terminal
        // when the server broadcasts sessions_sync. It's hidden from the UI
        // via updateSessionState's closedLocally filter. finalizeDeferredClose
        // will splice it out once session_meta arrives (or the ws errors).
        session.deferredTeardown = true;
        session.containerEl.style.display = "none";
        updateSessionState();
        setActiveId((current) => {
          if (current !== id) return current;
          const visible = sessionsRef.current.filter((s) => !s.closedLocally);
          const fallbackIdx = Math.min(idx, visible.length - 1);
          return visible[fallbackIdx]?.id ?? null;
        });
        return;
      }

      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: "close_session" }));
      } else if (session.serverSessionId) {
        fetch(`/api/terminal/sessions/${encodeURIComponent(session.serverSessionId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      session.ws?.close();
      session.observer.disconnect();
      if (session.onResizeEnd) {
        window.removeEventListener("ide:resize-end", session.onResizeEnd);
      }
      session.term.dispose();
      session.containerEl.remove();

      sessionsRef.current.splice(idx, 1);
      updateSessionState();

      setActiveId((current) => {
        if (current !== id) return current;
        // Skip deferred-close "ghost" sessions still sitting in sessionsRef
        // waiting for their session_meta — activating one would show an
        // empty pane.
        const visible = sessionsRef.current.filter((s) => !s.closedLocally);
        const fallbackIdx = Math.min(idx, visible.length - 1);
        return visible[fallbackIdx]?.id ?? null;
      });
    },
    [token, updateSessionState]
  );

  const sendToActive = useCallback(
    (data: string) => {
      const session = sessionsRef.current.find((s) => s.id === activeId);
      if (session?.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: "input", data }));
      }
    },
    [activeId]
  );

  useImperativeHandle(ref, () => ({
    sendCommand: (cmd: string) => {
      sendToActive(cmd + "\n");
    },
    runInNewSession: (name: string, command: string) => {
      // If a session with this name already exists, reuse the slot so
      // repeated Play clicks don't stack "Play (1)", "Play (2)", etc.
      const existing = sessionsRef.current.find((s) => s.name === name && !s.closedLocally);
      if (existing) {
        setActiveId(existing.id);
        if (existing.ws?.readyState === WebSocket.OPEN) {
          // Ctrl+C first to interrupt whatever was running, then run the
          // new command once the shell has a fresh prompt.
          existing.ws.send(JSON.stringify({ type: "input", data: "\x03" }));
          setTimeout(() => {
            if (existing.ws?.readyState === WebSocket.OPEN) {
              existing.ws.send(JSON.stringify({ type: "input", data: command + "\n" }));
            }
          }, 150);
        } else {
          // ws not open yet — queue the command for when it connects.
          existing.pendingInitialCommand = command;
        }
        return;
      }
      createSession(name, { initialCommand: command, activate: true });
    },
    interruptSession: (name: string) => {
      const existing = sessionsRef.current.find((s) => s.name === name && !s.closedLocally);
      if (!existing) return;
      setActiveId(existing.id);
      if (existing.ws?.readyState === WebSocket.OPEN) {
        // Ctrl+C to kill the foreground process group, then destroy
        // the pty outright so the session disappears from the terminal
        // list. Sending just Ctrl+C leaves bash alive and the "Play"
        // session sticks around forever, which keeps the PlayBar in
        // the "running" state because it derives running from the
        // session list. close_session is handled server-side by
        // destroySession, which broadcasts session_closed and reaps
        // the pty.
        try {
          existing.ws.send(JSON.stringify({ type: "input", data: "\x03" }));
        } catch {}
        const ws = existing.ws;
        if (existing.serverSessionId) {
          pendingClosedRef.current.add(existing.serverSessionId);
        }
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "close_session" }));
            } catch {}
          }
        }, 150);
      }
    },
  }));

  useEffect(() => {
    if (!showInputOverlay) return;
    requestAnimationFrame(() => {
      overlayTextareaRef.current?.focus();
    });
  }, [showInputOverlay]);

  useEffect(() => {
    if (!showRenameDialog) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [showRenameDialog]);

  const submitOverlayText = useCallback(() => {
    if (!overlayText.trim()) {
      setShowInputOverlay(false);
      return;
    }
    sendToActive(overlayText);
    setOverlayText("");
    setShowInputOverlay(false);
  }, [overlayText, sendToActive]);

  const openRenameDialog = useCallback(() => {
    const session = sessionsRef.current.find((s) => s.id === activeId);
    if (!session) return;
    setRenameValue(session.name);
    setShowRenameDialog(true);
  }, [activeId]);

  const submitRename = useCallback(() => {
    const nextName = renameValue.trim();
    if (!nextName) {
      setShowRenameDialog(false);
      return;
    }
    const session = sessionsRef.current.find((s) => s.id === activeId);
    if (!session) {
      setShowRenameDialog(false);
      return;
    }
    session.name = nextName;
    updateSessionState();
    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "rename_session", name: nextName }));
    }
    setShowRenameDialog(false);
  }, [activeId, renameValue, updateSessionState]);

  useEffect(() => {
    // Recompute scrolledUp for the newly-active session — otherwise
    // the jump-to-bottom button's visibility reflects the *previous*
    // tab's scroll position.
    const active = sessionsRef.current.find((s) => s.id === activeId);
    if (active) {
      const buf = active.term.buffer.active;
      setScrolledUp(buf.viewportY < buf.baseY - 1);
    } else {
      setScrolledUp(false);
    }
    for (const session of sessionsRef.current) {
      if (session.id === activeId) {
        session.containerEl.style.display = "block";
        // Double-rAF + fallback timer: the container was display:none so its
        // width is unknown until layout runs. Fit once the browser has laid
        // out the flex children, then re-fit to catch late layout shifts.
        const fitNow = () => {
          if (session.containerEl.clientWidth > 0) {
            try { session.fitAddon.fit(); } catch {}
            // Force a redraw + SIGWINCH to the pty so reconnected sessions
            // that haven't emitted output yet repaint their screen.
            try { session.term.refresh(0, session.term.rows - 1); } catch {}
            if (session.ws?.readyState === WebSocket.OPEN) {
              session.ws.send(
                JSON.stringify({
                  type: "resize",
                  cols: session.term.cols,
                  rows: session.term.rows,
                })
              );
            }
          }
        };
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            fitNow();
            session.term.focus();
          });
        });
        setTimeout(fitNow, 60);
      } else {
        session.containerEl.style.display = "none";
      }
    }
  }, [activeId]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        const res = await fetch("/api/terminal/sessions", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("cannot load sessions");
        const data = await res.json();
        if (cancelled) return;

        const remoteSessions = Array.isArray(data.sessions) ? data.sessions : [];
        if (remoteSessions.length === 0) {
          createSession();
          return;
        }

        remoteSessions.forEach((item: { id: string; name: string }, idx: number) => {
          createSession(item.name, { serverSessionId: item.id, activate: idx === 0 });
        });
      } catch {
        if (!cancelled) {
          createSession();
        }
      }
    };

    boot();

    return () => {
      cancelled = true;
      for (const session of sessionsRef.current) {
        session.shouldReconnect = false;
        if (session.reconnectTimer != null) {
          window.clearTimeout(session.reconnectTimer);
        }
        session.ws?.close();
        session.observer.disconnect();
        if (session.onResizeEnd) {
          window.removeEventListener("ide:resize-end", session.onResizeEnd);
        }
        session.term.dispose();
        session.containerEl.remove();
      }
      sessionsRef.current = [];
    };
  }, [createSession, token]);

  // Global shortcuts: Cmd/Ctrl+T → new terminal, Cmd/Ctrl+1..9 → switch tab
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      // Cmd/Ctrl + P → new terminal
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        createSession();
        return;
      }
      // Cmd/Ctrl + O → close active terminal
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        if (activeId != null) closeSession(activeId);
        return;
      }
      // Cmd/Ctrl + I → rename active terminal
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        openRenameDialog();
        return;
      }
      // Cmd/Ctrl + / → toggle shortcuts dialog
      if (e.key === "/") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const target = sessionsRef.current[idx];
        if (target) {
          e.preventDefault();
          setActiveId(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createSession, closeSession, openRenameDialog, activeId]);

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex items-center gap-1 px-2 py-1 bg-blue-900/60 border-b border-blue-800 shrink-0 overflow-x-auto">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-1.5 rounded cursor-pointer transition-colors shrink-0 ${
              isMobile ? "px-3 py-2 text-sm min-h-[40px]" : "px-2 py-1 text-xs"
            } ${
              s.id === activeId ? "bg-blue-800 text-white" : "text-blue-300 hover:bg-blue-800/50 hover:text-white"
            }`}
            onClick={() => setActiveId(s.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.connected ? "bg-green-400" : "bg-red-400"}`} />
            <span className={`truncate ${isMobile ? "max-w-[140px]" : "max-w-[100px]"}`}>{s.name}</span>
            {sessions.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                className={`ml-0.5 flex items-center justify-center rounded hover:bg-blue-700 text-blue-400 hover:text-white transition-colors ${
                  isMobile ? "w-7 h-7 text-sm" : "w-4 h-4 text-[10px]"
                }`}
                title="Cerrar terminal"
              >
                x
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center flex-wrap gap-1 px-2 py-1 bg-blue-900/40 border-b border-blue-800 shrink-0">
        <button
          onClick={() => createSession()}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-blue-800/40 hover:bg-blue-700 text-blue-300 hover:text-white transition-colors shrink-0"
          title="Nueva terminal"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>

        <button
          onClick={openRenameDialog}
          disabled={activeId == null}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-blue-800/40 hover:bg-blue-700 text-blue-300 hover:text-white transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Renombrar terminal activa"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487a2.1 2.1 0 113.03 2.913L9.15 18.146l-4.65 1.25 1.248-4.652L16.862 4.487z" />
          </svg>
        </button>

        <button
          onClick={() => setShowShortcuts(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-blue-800/40 hover:bg-blue-700 text-blue-300 hover:text-white transition-colors shrink-0"
          title="Ver atajos de teclado"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h.01M9 8h.01M13 8h.01M17 8h.01M5 12h.01M9 12h6M17 12h.01M6 16h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>

        <div className="w-px h-4 bg-blue-700 mx-1 shrink-0" />

        <button
          onClick={() => setShowInputOverlay(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-blue-800/40 hover:bg-blue-700 text-blue-300 hover:text-white transition-colors shrink-0"
          title="Abrir input rapido"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10m-10 6h16" />
          </svg>
        </button>

        <button
          onClick={() => sendToActive("claude --dangerously-skip-permissions\n")}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-[#d97706] hover:bg-[#b45309] text-white transition-colors shrink-0"
          title="Ejecutar Claude Code"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
          </svg>
        </button>

        <button
          onClick={() => sendToActive("codex --yolo\n")}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-[#10a37f] hover:bg-[#0d8c6d] text-white transition-colors shrink-0"
          title="Ejecutar OpenAI Codex"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.5.5a6.046 6.046 0 00-5.77 4.17 6.046 6.046 0 00-4.05 2.928 6.065 6.065 0 00.745 7.097 5.98 5.98 0 00.516 4.911 6.046 6.046 0 006.51 2.9 6.065 6.065 0 004.55 1.995 6.046 6.046 0 005.77-4.17 6.046 6.046 0 004.05-2.929 6.065 6.065 0 00-.745-7.097zM12.5 21.654a4.476 4.476 0 01-2.876-1.042l.143-.082 4.779-2.758a.795.795 0 00.395-.678v-6.737l2.02 1.166a.071.071 0 01.038.052v5.583a4.504 4.504 0 01-4.5 4.496zM3.654 17.65a4.474 4.474 0 01-.535-3.014l.143.085 4.779 2.758a.78.78 0 00.79 0l5.83-3.366v2.332a.08.08 0 01-.033.063L9.83 19.318a4.504 4.504 0 01-6.176-1.668zM2.34 8.264a4.474 4.474 0 012.341-1.97V11.9a.775.775 0 00.395.677l5.83 3.366-2.02 1.166a.08.08 0 01-.065.007l-4.797-2.77A4.504 4.504 0 012.34 8.264zm16.596 3.858l-5.83-3.366 2.02-1.165a.08.08 0 01.065-.008l4.797 2.77a4.504 4.504 0 01-.695 8.107V12.8a.79.79 0 00-.396-.678zm2.01-3.023l-.143-.085-4.779-2.758a.78.78 0 00-.79 0l-5.83 3.366V7.29a.08.08 0 01.033-.063l4.797-2.77a4.504 4.504 0 016.713 4.64zm-12.64 4.135l-2.02-1.166a.071.071 0 01-.038-.052V6.433a4.504 4.504 0 017.376-3.453l-.143.082-4.779 2.758a.795.795 0 00-.395.677v6.737zm1.097-2.365l2.596-1.5 2.596 1.5v2.999l-2.596 1.5-2.596-1.5z" />
          </svg>
        </button>

        <button
          onClick={() => {
            const session = sessionsRef.current.find((s) => s.id === activeId);
            if (session) connectSession(session);
          }}
          disabled={activeId == null}
          className="w-9 h-9 flex items-center justify-center rounded-md bg-sky-600 hover:bg-sky-500 text-white transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Reconectar terminal activa"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div
        ref={wrapperRef}
        className="flex-1 min-h-0 relative"
        // Reserve space for the mobile special-keys bar at the bottom
        // so the last lines of terminal output aren't hidden behind
        // it. Add the safe-area inset so the bar clears the iPhone
        // home indicator on notched devices.
        style={
          isMobile
            ? { paddingBottom: "calc(48px + env(safe-area-inset-bottom, 0px))" }
            : undefined
        }
      >
        {isMobile && (
          // Special-keys bar: the native virtual keyboard on iOS/Android
          // doesn't expose Tab, Esc, arrow keys, or Ctrl modifiers, so
          // working in any shell/REPL/editor is painful without these.
          // The bar sits at the bottom of the terminal pane and sends
          // the corresponding bytes straight into the active pty.
          <div
            className="absolute left-0 right-0 z-30 flex items-center gap-1 px-1.5 py-1 bg-blue-900/80 backdrop-blur border-t border-blue-800 overflow-x-auto"
            // Push up above the safe-area inset so buttons aren't
            // covered by the iPhone home indicator.
            style={{ bottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            {[
              { label: "Esc", data: "\x1b" },
              { label: "Tab", data: "\t" },
              { label: "Ctrl+C", data: "\x03" },
              { label: "Ctrl+D", data: "\x04" },
              { label: "Ctrl+L", data: "\x0c" },
              { label: "Ctrl+Z", data: "\x1a" },
              { label: "↑", data: "\x1b[A" },
              { label: "↓", data: "\x1b[B" },
              { label: "←", data: "\x1b[D" },
              { label: "→", data: "\x1b[C" },
              { label: "Home", data: "\x1b[H" },
              { label: "End", data: "\x1b[F" },
              { label: "|", data: "|" },
              { label: "/", data: "/" },
              { label: "~", data: "~" },
            ].map((k) => (
              <button
                key={k.label}
                type="button"
                // tabIndex=-1 keeps the button out of the focus order,
                // which is what actually prevents iOS from blurring the
                // terminal (and dismissing the virtual keyboard) when
                // tapped. preventDefault on mouse/touch events is
                // unreliable: React's touchstart is passive, and iOS
                // focuses on touchstart before mousedown fires.
                tabIndex={-1}
                onClick={() => sendToActive(k.data)}
                className="shrink-0 min-w-[40px] h-9 px-2 rounded bg-blue-800/60 active:bg-blue-700 text-blue-100 text-xs font-medium transition-colors select-none"
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
        {isMobile && scrolledUp && (
          <button
            onClick={() => {
              const active = sessionsRef.current.find((s) => s.id === activeId);
              if (!active) return;
              active.term.scrollToBottom();
              setScrolledUp(false);
            }}
            className="absolute right-3 bottom-14 z-40 w-11 h-11 rounded-full bg-blue-600/90 text-white shadow-lg backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
            title="Ir al final"
            aria-label="Ir al final de la terminal"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        )}

        {showInputOverlay && (
          <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-sky-200 font-medium">Input rapido</div>
              <button
                onClick={() => {
                  setOverlayText("");
                  setShowInputOverlay(false);
                }}
                className="p-1.5 rounded ide-icon-button-danger transition-colors"
                title="Cerrar input"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <textarea
              ref={overlayTextareaRef}
              value={overlayText}
              onChange={(e) => setOverlayText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitOverlayText();
                  return;
                }
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  const next = overlayText.slice(0, start) + "\n" + overlayText.slice(end);
                  setOverlayText(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 1;
                  });
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOverlayText("");
                  setShowInputOverlay(false);
                }
              }}
              className="flex-1 w-full resize-none rounded-lg border ide-border ide-panel px-3 py-2 text-sm font-mono ide-text focus:outline-none"
              placeholder="Enter para enviar. Shift+Enter para salto de linea."
            />

            <div className="flex justify-end">
              <button
                onClick={submitOverlayText}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 text-white transition-colors"
                title="Enviar al terminal"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m0 0l-4-4m4 4l-4 4" />
                </svg>
                Enter
              </button>
            </div>
          </div>
        )}

        {showRenameDialog && (
          <div className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-sm ide-panel border ide-border rounded-lg shadow-xl p-4">
              <div className="text-sm font-semibold ide-text mb-2">Renombrar terminal</div>
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRename();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setShowRenameDialog(false);
                  }
                }}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono border ide-border ide-panel-soft ide-text focus:outline-none"
                placeholder="Nombre del terminal"
              />
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => setShowRenameDialog(false)}
                  className="px-3 py-1.5 text-xs rounded border ide-border ide-text hover:bg-blue-800/50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={submitRename}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 text-white transition-colors"
                >
                  Guardar
                </button>
              </div>
            </div>
          </div>
        )}

        {showShortcuts && (
          <div
            className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowShortcuts(false)}
          >
            <div
              className="w-full max-w-sm rounded-xl border ide-border ide-panel shadow-2xl p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold ide-text">Atajos de teclado</div>
                <button
                  onClick={() => setShowShortcuts(false)}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-blue-800/50 text-blue-300 hover:text-white"
                  title="Cerrar"
                >
                  ×
                </button>
              </div>
              <ul className="space-y-2 text-xs ide-text">
                {[
                  ["Nuevo terminal", "Cmd/Ctrl + P"],
                  ["Cerrar terminal activo", "Cmd/Ctrl + O"],
                  ["Renombrar terminal activo", "Cmd/Ctrl + I"],
                  ["Cambiar a terminal N", "Cmd/Ctrl + 1..9"],
                  ["Mostrar/ocultar atajos", "Cmd/Ctrl + /"],
                  ["Enviar input rapido", "Enter"],
                  ["Salto de linea en input rapido", "Shift + Enter"],
                  ["Cerrar input rapido / dialogos", "Esc"],
                ].map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3">
                    <span>{label}</span>
                    <kbd className="px-2 py-0.5 rounded border ide-border ide-panel-soft font-mono text-[11px]">
                      {keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
