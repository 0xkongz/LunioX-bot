import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { TradingEngine } from "../core/engine";
import { TradingMode, TradingParams } from "../config";
import { TokenValidationError } from "../services/errors";
import { logger } from "../utils/logger";

export function createApiRouter(engine: TradingEngine, apiKey: string): Router {
  const router = Router();

  // ─── Auth Middleware ──────────────────────────────────────────────
  const auth = (req: Request, res: Response, next: NextFunction): void => {
    const key = (req.headers["x-api-key"] || req.query.apiKey || "") as string;
    const keyBuf = Buffer.from(key);
    const expectedBuf = Buffer.from(apiKey);
    if (
      keyBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(keyBuf, expectedBuf)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  router.use(auth);

  // ─── Helpers ──────────────────────────────────────────────────────
  const sendValidationError = (res: Response, e: any) => {
    if (e instanceof TokenValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(400).json({ error: e?.message ?? "Bad request" });
  };

  // ─── GET /api/status ──────────────────────────────────────────────
  router.get("/status", (_req: Request, res: Response) => {
    try {
      const status = engine.getStatus();
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── POST /api/mode ───────────────────────────────────────────────
  // Body: { token: "LUNIO", mode: "delta_neutral" }
  router.post("/mode", (req: Request, res: Response) => {
    try {
      const { token, mode } = req.body;
      const validModes: TradingMode[] = [
        "delta_neutral",
        "dca_buy",
        "dca_sell",
        "stopped",
      ];
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode. Use: ${validModes.join(", ")}` });
        return;
      }
      engine.setMode(token, mode);
      res.json({ success: true, token, mode });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── POST /api/params ─────────────────────────────────────────────
  router.post("/params", (req: Request, res: Response) => {
    try {
      const { token, params } = req.body;
      engine.updateParams(token, params as Partial<TradingParams>);
      res.json({ success: true, token, params });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Token Registry CRUD ──────────────────────────────────────────

  // GET /api/tokens — list all registered tokens.
  router.get("/tokens", (_req: Request, res: Response) => {
    try {
      res.json(engine.getRegistry().list());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tokens/detect?address=0x... — preview detection without saving.
  // Useful for the "Add token" modal: paste address → see name/symbol/decimals
  // → confirm → save.
  router.get("/tokens/detect", async (req: Request, res: Response) => {
    try {
      const address = (req.query.address as string) || "";
      const result = await engine.getDetector().detect(address);
      res.json(result);
    } catch (e: any) {
      sendValidationError(res, e);
    }
  });

  // POST /api/tokens — register a new token.
  // Body: { address, name?, enabled?, walletSelector? }
  // Detector validates address + ERC20 + V2 pair existence.
  router.post("/tokens", async (req: Request, res: Response) => {
    try {
      const { address, name, enabled, walletSelector } = req.body ?? {};
      if (!address) {
        res.status(400).json({ error: "address is required" });
        return;
      }
      const stored = await engine.addToken({
        address,
        name,
        enabled,
        walletSelector,
      });
      res.json({ success: true, token: stored });
    } catch (e: any) {
      sendValidationError(res, e);
    }
  });

  // PATCH /api/tokens/:key — update mutable fields.
  // Body: { name?, enabled?, walletSelector?, decimals? }
  router.patch("/tokens/:key", (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const { name, enabled, walletSelector, decimals } = req.body ?? {};
      const updated = engine.updateToken(key, {
        name,
        enabled,
        walletSelector,
        decimals,
      });
      res.json({ success: true, token: updated });
    } catch (e: any) {
      sendValidationError(res, e);
    }
  });

  // DELETE /api/tokens/:key — remove a token entirely.
  router.delete("/tokens/:key", (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const removed = engine.removeToken(key);
      if (!removed) {
        res.status(404).json({ error: `Token "${key}" not found` });
        return;
      }
      res.json({ success: true, key: key.toUpperCase() });
    } catch (e: any) {
      sendValidationError(res, e);
    }
  });

  // ─── POST /api/wallet ─────────────────────────────────────────────
  router.post("/wallet", (req: Request, res: Response) => {
    if (process.env.ALLOW_RUNTIME_WALLET_ADDITION !== "true") {
      res.status(403).json({
        error:
          "Runtime wallet addition is disabled. Restart the service with new WALLET_PRIVATE_KEYS instead, or set ALLOW_RUNTIME_WALLET_ADDITION=true.",
      });
      return;
    }
    try {
      const { privateKey, tokens } = req.body;
      if (!privateKey) {
        res.status(400).json({ error: "privateKey required" });
        return;
      }
      const result = engine.addWallet(privateKey, tokens);
      logger.warn(`Wallet added at runtime: ${result.address}`);
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Engine start/stop ────────────────────────────────────────────
  router.post("/start", async (_req: Request, res: Response) => {
    try {
      await engine.start();
      res.json({ success: true, message: "Engine started" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/stop", (_req: Request, res: Response) => {
    try {
      engine.stop();
      res.json({ success: true, message: "Engine stopped" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/trades ──────────────────────────────────────────────
  router.get("/trades", (req: Request, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || "50");
      const trades = engine.getTracker().getRecentTrades(limit);
      res.json(trades);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
