import { WebSocket } from "ws";
import * as pty from "node-pty";

export function spawnTerminal(ws: WebSocket) {
  const shell = process.env.SHELL || "/bin/bash";
  const dataDir = process.env.DATA_DIR || "/";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: dataDir,
    env: {
      ...process.env as Record<string, string>,
      HOME: process.env.HOME || `/home/${process.env.USER || "mini-ide"}`,
    },
  });

  // PTY output -> WebSocket
  ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  // WebSocket input -> PTY
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") {
        ptyProcess.write(msg.data);
      } else if (msg.type === "resize") {
        ptyProcess.resize(
          Math.max(1, msg.cols || 80),
          Math.max(1, msg.rows || 24)
        );
      }
    } catch {
      ptyProcess.write(raw.toString());
    }
  });

  ws.on("close", () => {
    ptyProcess.kill();
  });
}
