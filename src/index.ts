import { loadConfig } from "./config";
import { TradingEngine } from "./core/engine";
import { startDashboard } from "./dashboard/server";
import { logger } from "./utils/logger";

async function main() {
  logger.info("╔══════════════════════════════════════════╗");
  logger.info("║   LunioX Trading Bot — PancakeSwap V2    ║");
  logger.info("║   Token registry managed via dashboard   ║");
  logger.info("╚══════════════════════════════════════════╝");

  const config = loadConfig();

  logger.info(`Chain ID: ${config.chainId}`);
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Wallets loaded: ${config.walletKeys.length}`);
  logger.info(`V2 Router: ${config.v2RouterAddress}`);
  logger.info(`V2 Factory: ${config.v2FactoryAddress}`);
  logger.info(`Tokens file: ${config.tokensFile}`);

  const engine = new TradingEngine(config);

  const registered = engine.getRegistry().list();
  if (registered.length === 0) {
    logger.info(
      "No tokens registered yet — add one via the dashboard before starting."
    );
  } else {
    logger.info(
      `Registered tokens: ${registered.map((t) => `${t.key}${t.enabled ? "" : " (disabled)"}`).join(", ")}`
    );
  }

  startDashboard(engine, config.dashboardPort, config.dashboardApiKey);

  // Auto-start engine if default mode is not "stopped" AND at least one
  // token is enabled. Otherwise wait for the operator to start it from
  // the dashboard.
  const anyEnabled = registered.some((t) => t.enabled);
  if (config.defaultTradingParams.mode !== "stopped" && anyEnabled) {
    logger.info("Auto-starting engine (default mode is not stopped)...");
    await engine.start();
  } else {
    logger.info("Engine initialized but not started. Use dashboard to start.");
  }

  const shutdown = async () => {
    logger.info("Shutting down gracefully...");
    engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    logger.info("Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
