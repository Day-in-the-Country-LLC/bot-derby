import { loadConfig, type Config } from "../config.js";
import { ROSTER, type DerbyId, type ProviderConfig } from "./decisions.js";
import type { StockRules } from "./stocks/types.js";

export const STOCK_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"] as const;

function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const n = Number(env[key] || fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  return n;
}
export function derbyConfig(env: NodeJS.ProcessEnv = process.env) {
  if ((env.MODE && env.MODE !== "dry") || /^(false|0|no)$/i.test(env.DRY_RUN ?? "")) throw new Error("Bot Derby supports paper trading only");
  const start = number(env, "BEE_START_EQUITY_USD", 50_000, 10, 1_000_000);
  const tickMs = number(env, "TICK_MS", 10_000, 10_000, 3_600_000);
  const timeoutMs = number(env, "DECISION_TIMEOUT_MS", 5000, 100, 20_000);
  const cap = (env.BOT_DAILY_USD_CAP ?? "unlimited").trim().toLowerCase() === "unlimited" ? null : number(env, "BOT_DAILY_USD_CAP", 0.25, 0, 100);
  // Only these explicit knobs enter this experiment. Legacy Gemini/owner/setup settings cannot change it.
  const cfg: Config = loadConfig({
    DRY_RUN: "true", MODE: "dry", BEE_START_EQUITY_USD: String(start),
    TICK_MS: String(tickMs), DATA_REFRESH_MS: "60000", MAX_NOTIONAL_USD_PER_BEE: String(start * 1.5),
    DB_PATH: env.DB_PATH || "./data/bot-derby-stocks-s02-50k.sqlite",
    ENGINE_BIND: env.ENGINE_BIND || "127.0.0.1", ENGINE_PORT: env.PORT || env.ENGINE_PORT || "8080",
    UPDATE_CHECK: "false", LOG_LEVEL: env.LOG_LEVEL || "info",
  });
  for (const id of ROSTER) cfg.slots[id] = {
    name: id === "bee1" ? "Ferdi" : "Bodi", tagline: id === "bee1" ? "Powered by Jev" : "Powered by OpenAI Decisions",
    style: "breezy", coins: ["BTC", "ETH"], rules: "", customImage: false, fromSetup: true,
  };
  const providers: Record<DerbyId, ProviderConfig> = {
    bee1: { provider: "jev", name: "Ferdi", apiKey: env.TYPESAFE_API_KEY?.trim() || "", model: env.JEV_MODEL || "jev-1.13.0", dailyUsdCap: cap, usdPerMTok: number(env, "JEV_USD_PER_MTOK", 0.042, 0.0001, 100), timeoutMs },
    bee2: { provider: "openai", name: "Bodi", apiKey: env.OPENAI_API_KEY?.trim() || "", model: "gpt-6-luna", dailyUsdCap: cap, usdPerMTok: number(env, "OPENAI_DECISIONS_USD_PER_MTOK", 0.10, 0.0001, 100), timeoutMs },
  };
  // A new immutable season: changing market, accounting, models or execution rules
  // must never silently reinterpret the preceding crypto experiment's database.
  const stockRules: StockRules = {
    version: 3, season: "02", strategy: "Matched long-only stock Donchian trend following",
    coins: [...STOCK_SYMBOLS], assetClass: "stocks", feed: "Alpaca IEX", candleTimeframe: "1Day",
    startEquityUsd: start, tickMs, askEveryCycle: true,
    risk: {
      maxLeverage: 1, maxExposurePct: 95, dailyLossStopPct: 8, retireDrawdownPct: 60,
      maxEntriesPerSession: 2, entryCooldownMs: 4 * 60 * 60 * 1000,
      spreadGateBps: 25, maxQuoteAgeMs: 60_000,
      feeRate: 0.0005, slippageBps: 5, stopAtrMult: 2,
      minActionProbability: 0.55, minConviction: 1,
    },
  };
  const marketData = { apiKey: env.ALPACA_API_KEY?.trim() || "", apiSecret: env.ALPACA_API_SECRET?.trim() || "", symbols: [...STOCK_SYMBOLS] };
  return { cfg, providers, stockRules, marketData, enabled: env.COMPETITION_ENABLED === "true", webDir: env.DERBY_WEB_DIR || "./derby-web" };
}
