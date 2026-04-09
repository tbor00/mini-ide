import { Router } from "express";
import { spawn } from "child_process";
import fs from "fs/promises";

export const PLAY_PID_FILE = "/tmp/mini-ide-play.pid";
export const PLAY_TUNNEL_LOG = "/tmp/mini-ide-play-tunnel.log";

export const playRouter = Router();

// Recursively collect every descendant of `pid` using pgrep -P.
function getDirectChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const proc = spawn("pgrep", ["-P", String(pid)]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      resolve(
        out
          .split("\n")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
      );
    });
    proc.on("error", () => resolve([]));
  });
}

async function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const children = await getDirectChildren(pid);
  // Depth-first so leaves die before their parents and we don't lose
  // track of grandchildren reparented to init.
  for (const child of children) {
    await killTree(child, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead or permission denied — ignore.
  }
}

// POST /api/play/stop — kill the whole process tree started by the Play
// button. The Play command writes its BASHPID to PLAY_PID_FILE so we
// know the root. We walk the tree with pgrep -P and send SIGTERM to
// each pid. A second pass with SIGKILL catches stragglers that ignored
// SIGTERM (Next.js sometimes takes >5s to shut down gracefully).
playRouter.post("/stop", async (_req, res) => {
  try {
    let pid: number | null = null;
    try {
      const raw = await fs.readFile(PLAY_PID_FILE, "utf-8");
      const parsed = parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    } catch {
      // No pidfile → nothing to stop.
    }

    if (pid == null) {
      res.json({ ok: true, killed: false, reason: "no pidfile" });
      return;
    }

    await killTree(pid, "SIGTERM");
    // Give graceful shutdown a moment, then SIGKILL anything still alive.
    setTimeout(async () => {
      try {
        await killTree(pid!, "SIGKILL");
      } catch {}
      try {
        await fs.writeFile(PLAY_PID_FILE, "");
      } catch {}
    }, 2500);

    res.json({ ok: true, killed: true, pid });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "stop failed" });
  }
});
