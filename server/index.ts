import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { spawnTerminal } from "./terminal";
import { filesystemRouter } from "./filesystem";
import { authRouter, requireAuth, isValidToken } from "./auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Auth routes (public)
app.use("/api/auth", authRouter);

// Protected API routes
app.use("/api/fs", requireAuth, filesystemRouter);

// Serve client static files in production
const clientDist = path.join(__dirname, "../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// WebSocket server for terminal — check token from query param
const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const token = url.searchParams.get("token") || "";

  if (!isValidToken(token)) {
    ws.close(1008, "No autorizado");
    return;
  }

  spawnTerminal(ws);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Editor server running on http://localhost:${PORT}`);
});
