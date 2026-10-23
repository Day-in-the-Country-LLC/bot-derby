import { atr, donchianEnsemble, realisedVolPct } from "../../market/indicators.js";
import type { Candle } from "../../market/types.js";
import type { StockSignal } from "./types.js";

export const STOCK_HISTORY_TARGET = 420;
export const STOCK_HISTORY_MINIMUM = 361;
const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function newYorkTradingDate(timestamp: number): string {
  const parts = nyDay.formatToParts(timestamp);
  return ["year", "month", "day"].map((part) => parts.find((p) => p.type === part)!.value).join("-");
}

/** Daily bars at midnight New York; the current session's partial bar is never used. */
export function stockSignal(symbol: string, daily: Candle[], tradingDate: string): StockSignal | null {
  const unique = new Map<string, Candle>();
  for (const bar of daily) {
    const day = newYorkTradingDate(bar.ts);
    if (bar.confirmed && day < tradingDate) unique.set(day, bar);
  }
  const completed = [...unique.values()].sort((a, b) => a.ts - b.ts).slice(-STOCK_HISTORY_TARGET);
  if (completed.length < STOCK_HISTORY_MINIMUM) return null;
  const closes = completed.map((bar) => bar.c);
  const last = completed[completed.length - 1]!;
  const trend = donchianEnsemble(closes);
  const range = atr(completed, 14);
  const volatility = realisedVolPct(closes, 90, 252);
  if (trend.slicesAvailable !== 9 || range === null || volatility === null) return null;
  const result: StockSignal = {
    symbol, score: trend.score, slicesAvailable: trend.slicesAvailable, barCount: completed.length,
    atrPct: range / last.c * 100, volatilityPct: volatility,
    return1dPct: (last.c / closes[closes.length - 2]! - 1) * 100,
    return5dPct: (last.c / closes[closes.length - 6]! - 1) * 100,
    completedThrough: last.ts, previousClose: last.c,
  };
  return Object.values(result).every((value) => typeof value !== "number" || Number.isFinite(value)) ? result : null;
}
