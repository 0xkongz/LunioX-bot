import express from "express";
import cors from "cors";
import path from "path";
import { TradingEngine } from "../core/engine";
import { createApiRouter } from "./api";
import { logger } from "../utils/logger";

export function startDashboard(
  engine: TradingEngine,
  port: number,
  apiKey: string
): express.Express {
  const app = express();

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    const allowedOrigins = process.env.CORS_ORIGIN || "";
    app.use(cors({ origin: allowedOrigins ? allowedOrigins.split(",") : false }));
  } else {
    app.use(cors());
  }

  app.use(express.json());

  // Health check — no auth (for Railway monitoring)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  app.use(express.static(path.join(__dirname, "public")));
  app.use("/api", createApiRouter(engine, apiKey));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  if (apiKey === "changeme" || apiKey.length < 16) {
    if (isProduction) {
      logger.error("===========================================");
      logger.error("  FATAL: DASHBOARD_API_KEY is missing, default, or too short");
      logger.error("  Refusing to start in NODE_ENV=production");
      logger.error("  Set DASHBOARD_API_KEY to a random string of at least 16 chars");
      logger.error("===========================================");
      throw new Error("Insecure DASHBOARD_API_KEY in production");
    }
    logger.warn("===========================================");
    logger.warn("  WARNING: Using default/short API key");
    logger.warn("  Set DASHBOARD_API_KEY (>=16 chars) in your environment");
    logger.warn("===========================================");
  }

  app.listen(port, () => {
    logger.info(`Dashboard running on http://0.0.0.0:${port}`);
    logger.info(`Health check: http://0.0.0.0:${port}/health`);
  });

  return app;
}
