import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Db } from "../db.js";
import { setLogLevel } from "../log.js";
import { derbyConfig } from "./config.js";
import { DerbyDecisions, ROSTER } from "./decisions.js";
import { lockSeason, publicArchives } from "./seasons.js";
import { derbyServer } from "./server.js";
import { AlpacaStockFeed } from "./stocks/feed.js";
import { StockEngine } from "./stocks/engine.js";

async function main() {
  const { cfg, providers, enabled, webDir, stockRules, marketData } = derbyConfig();
  setLogLevel(cfg.logLevel);
  const db = new Db(cfg.dbPath);
  const decisions = new DerbyDecisions(providers, db);
  const rules = {
    ...stockRules,
    providers: ROSTER.map(id => ({ name: providers[id].name, provider: providers[id].provider, model: providers[id].model, dailyUsdCap: providers[id].dailyUsdCap, timeoutMs: providers[id].timeoutMs, usdPerMTok: providers[id].usdPerMTok })),
  };
  lockSeason(db, rules);
  const feed = new AlpacaStockFeed(marketData);
  const engine = new StockEngine({ db, feed, decisions, rules: stockRules });
  const ready = ROSTER.every(id => !!providers[id].apiKey);
  const marketReady = !!marketData.apiKey && !!marketData.apiSecret;
  let startupFailed = false;
  // Closing the season stops decisions; it never manufactures out-of-hours fills.
  const closed = () => existsSync(join(dirname(cfg.dbPath), "close-stock-derby"));
  const server = derbyServer({
    db, webDir, equitySeries: () => engine.equitySeries(), activity: () => engine.activity(),
    snapshot: () => {
      const snap = engine.snapshot();
      const state = startupFailed ? "error" : closed() ? "finished" : !enabled ? "paused" : !ready ? "awaiting_keys" : !marketReady ? "awaiting_market_data" : snap.state;
      return {
        title: "Bot Derby", ts: Date.now(), state, mode: "paper", readOnly: true,
        startedAt: snap.startedAt, marketUpdatedAt: snap.marketUpdatedAt,
        session: snap.session, marketError: snap.marketError, rules, benchmarks: snap.benchmarks, archives: publicArchives(db),
        bots: ROSTER.map(id => ({ id, name: providers[id].name, ...decisions.status(id), portfolio: snap.portfolios[id] })),
        attribution: { name: "Mike Russell / Creator Magic", url: "https://github.com/imikerussell/beebots", license: "MIT" },
      };
    },
  });
  server.listen(cfg.server.port, cfg.server.bind, () => console.info(`Bot Derby: http://${cfg.server.bind}:${cfg.server.port} (stock paper season ${stockRules.season})`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    // Drain paid requests so reservations settle, without accepting late fills.
    const forceExit = setTimeout(() => process.exit(0), 12_000);
    await engine.stop();
    db.close();
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (!enabled || !ready || !marketReady || closed()) return;
  const closeWatch = setInterval(() => { if (closed()) { void engine.stop(); clearInterval(closeWatch); } }, 1000);
  closeWatch.unref();
  try { await engine.start(); }
  catch { startupFailed = true; await engine.stop(); console.error("Stock competition startup failed; check cloud logs and market access."); }
}
main().catch(() => { console.error("Bot Derby could not start. Check validated settings, storage access and season consistency."); process.exitCode = 1; });
