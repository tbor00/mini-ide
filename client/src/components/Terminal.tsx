import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
  token: string;
}

export interface TerminalHandle {
  sendCommand: (cmd: string) => void;
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
  reconnectTimer: number | null;
  shouldReconnect: boolean;
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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ token }, ref) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const overlayTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionsRef = useRef<TermSession[]>([]);
  const [sessions, setSessions] = useState<{ id: number; name: string; connected: boolean }[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showInputOverlay, setShowInputOverlay] = useState(false);
  const [overlayText, setOverlayText] = useState("");

  const updateSessionState = useCallback(() => {
    setSessions(sessionsRef.current.map((s) => ({ id: s.id, name: s.name, connected: s.connected })));
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
      };

      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "session_meta") {
            if (typeof msg.sessionId === "string") session.serverSessionId = msg.sessionId;
            if (typeof msg.name === "string") session.name = msg.name;
            updateSessionState();
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
      options?: { serverSessionId?: string | null; activate?: boolean }
    ) => {
      const id = nextId++;
      const containerEl = document.createElement("div");
      containerEl.style.cssText = "width:100%;height:100%;display:none;padding:4px;";

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: TERM_THEME,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (wrapperRef.current) {
        wrapperRef.current.appendChild(containerEl);
      }

      term.open(containerEl);
      fitAddon.fit();

      const observer = new ResizeObserver(() => {
        if (containerEl.style.display !== "none") {
          fitAddon.fit();
        }
      });
      observer.observe(containerEl);

      const session: TermSession = {
        id,
        serverSessionId: options?.serverSessionId || null,
        name: name || `Terminal ${id}`,
        term,
        fitAddon,
        ws: null,
        connected: false,
        containerEl,
        observer,
        reconnectTimer: null,
        shouldReconnect: true,
      };

      term.onData((data) => {
        if (session.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: "input", data }));
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

  const closeSession = useCallback(
    (id: number) => {
      const idx = sessionsRef.current.findIndex((s) => s.id === id);
      if (idx === -1) return;
      if (sessionsRef.current.length <= 1) return;

      const session = sessionsRef.current[idx];
      session.shouldReconnect = false;
      if (session.reconnectTimer != null) {
        window.clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
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
      session.term.dispose();
      session.containerEl.remove();

      sessionsRef.current.splice(idx, 1);
      updateSessionState();

      setActiveId((current) => {
        if (current !== id) return current;
        const newIdx = Math.min(idx, sessionsRef.current.length - 1);
        return sessionsRef.current[newIdx]?.id ?? null;
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
  }));

  useEffect(() => {
    if (!showInputOverlay) return;
    requestAnimationFrame(() => {
      overlayTextareaRef.current?.focus();
    });
  }, [showInputOverlay]);

  const submitOverlayText = useCallback(() => {
    if (!overlayText.trim()) {
      setShowInputOverlay(false);
      return;
    }
    sendToActive(overlayText);
    setOverlayText("");
    setShowInputOverlay(false);
  }, [overlayText, sendToActive]);

  useEffect(() => {
    for (const session of sessionsRef.current) {
      if (session.id === activeId) {
        session.containerEl.style.display = "block";
        requestAnimationFrame(() => {
          session.fitAddon.fit();
          session.term.focus();
        });
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
        session.term.dispose();
        session.containerEl.remove();
      }
      sessionsRef.current = [];
    };
  }, [createSession, token]);

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex items-center gap-1 px-2 py-1 bg-blue-900/60 border-b border-blue-800 shrink-0 overflow-x-auto">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded cursor-pointer transition-colors shrink-0 ${
              s.id === activeId ? "bg-blue-800 text-white" : "text-blue-300 hover:bg-blue-800/50 hover:text-white"
            }`}
            onClick={() => setActiveId(s.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.connected ? "bg-green-400" : "bg-red-400"}`} />
            <span className="truncate max-w-[100px]">{s.name}</span>
            {sessions.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                className="ml-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-blue-700 text-blue-400 hover:text-white transition-colors text-[10px]"
                title="Cerrar terminal"
              >
                x
              </button>
            )}
          </div>
        ))}

        <button
          onClick={() => createSession()}
          className="p-1 rounded hover:bg-blue-800/50 text-blue-400 hover:text-white transition-colors shrink-0"
          title="Nueva terminal"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>

        <div className="w-px h-4 bg-blue-700 mx-1 shrink-0" />

        <button
          onClick={() => setShowInputOverlay(true)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors shrink-0"
          title="Abrir input rapido"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10m-10 6h16" />
          </svg>
          Input
        </button>

        <button
          onClick={() => sendToActive("claude --dangerously-skip-permissions\n")}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded bg-[#d97706] hover:bg-[#b45309] text-white transition-colors shrink-0"
          title="Ejecutar Claude Code"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15.5v-3H8.5L13 7.5v3H15.5L11 17.5z" />
          </svg>
          Claude
        </button>

        <button
          onClick={() => sendToActive("codex --yolo\n")}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded bg-[#10a37f] hover:bg-[#0d8c6d] text-white transition-colors shrink-0"
          title="Ejecutar OpenAI Codex"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.5.5a6.046 6.046 0 00-5.77 4.17 6.046 6.046 0 00-4.05 2.928 6.065 6.065 0 00.745 7.097 5.98 5.98 0 00.516 4.911 6.046 6.046 0 006.51 2.9 6.065 6.065 0 004.55 1.995 6.046 6.046 0 005.77-4.17 6.046 6.046 0 004.05-2.929 6.065 6.065 0 00-.745-7.097zM12.5 21.654a4.476 4.476 0 01-2.876-1.042l.143-.082 4.779-2.758a.795.795 0 00.395-.678v-6.737l2.02 1.166a.071.071 0 01.038.052v5.583a4.504 4.504 0 01-4.5 4.496zM3.654 17.65a4.474 4.474 0 01-.535-3.014l.143.085 4.779 2.758a.78.78 0 00.79 0l5.83-3.366v2.332a.08.08 0 01-.033.063L9.83 19.318a4.504 4.504 0 01-6.176-1.668zM2.34 8.264a4.474 4.474 0 012.341-1.97V11.9a.775.775 0 00.395.677l5.83 3.366-2.02 1.166a.08.08 0 01-.065.007l-4.797-2.77A4.504 4.504 0 012.34 8.264zm16.596 3.858l-5.83-3.366 2.02-1.165a.08.08 0 01.065-.008l4.797 2.77a4.504 4.504 0 01-.695 8.107V12.8a.79.79 0 00-.396-.678zm2.01-3.023l-.143-.085-4.779-2.758a.78.78 0 00-.79 0l-5.83 3.366V7.29a.08.08 0 01.033-.063l4.797-2.77a4.504 4.504 0 016.713 4.64zm-12.64 4.135l-2.02-1.166a.071.071 0 01-.038-.052V6.433a4.504 4.504 0 017.376-3.453l-.143.082-4.779 2.758a.795.795 0 00-.395.677v6.737zm1.097-2.365l2.596-1.5 2.596 1.5v2.999l-2.596 1.5-2.596-1.5z" />
          </svg>
          Codex
        </button>

        <div className="flex-1" />

        <button
          onClick={() => {
            const session = sessionsRef.current.find((s) => s.id === activeId);
            if (session) connectSession(session);
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded bg-sky-600 hover:bg-sky-500 text-white transition-colors shrink-0"
          title="Reconectar terminal activa"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Reconectar
        </button>
      </div>

      <div ref={wrapperRef} className="flex-1 min-h-0 relative">
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
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitOverlayText();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOverlayText("");
                  setShowInputOverlay(false);
                }
              }}
              className="flex-1 w-full resize-none rounded-lg border ide-border ide-panel px-3 py-2 text-sm font-mono ide-text focus:outline-none"
              placeholder="Escribe o pega aqui. Cmd/Ctrl+Enter para enviar."
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
      </div>
    </div>
  );
});
