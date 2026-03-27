import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";

export const authRouter = Router();

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin";

// Simple token: hash of username+password so it's consistent across restarts
const VALID_TOKEN = crypto
  .createHash("sha256")
  .update(`${AUTH_USERNAME}:${AUTH_PASSWORD}`)
  .digest("hex");

authRouter.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
    res.json({ ok: true, token: VALID_TOKEN });
  } else {
    res.status(401).json({ ok: false, error: "Credenciales incorrectas" });
  }
});

// Middleware to protect routes
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    (req.query.token as string);
  if (token === VALID_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: "No autorizado" });
  }
}

// Validate token for WebSocket connections
export function isValidToken(token: string): boolean {
  return token === VALID_TOKEN;
}
