import { derbyConfig } from "../config.js";
import { AlpacaStockFeed } from "./feed.js";

// Read-only connectivity check: no decision requests, brokerage orders, or database writes.
const { marketData } = derbyConfig();
const feed = new AlpacaStockFeed(marketData);
const market = await feed.refresh();
const complete = marketData.symbols.every(symbol => market.signals[symbol]?.slicesAvailable === 9);
console.info(JSON.stringify({
  authenticated: market.session.checkedAt > 0,
  marketOpen: market.session.isOpen,
  nextOpen: market.session.nextOpen ? new Date(market.session.nextOpen).toISOString() : null,
  feed: "Alpaca IEX", historyComplete: complete,
  history: marketData.symbols.map(symbol => ({ symbol, completedBars: market.signals[symbol]?.barCount ?? 0, trendWindows: market.signals[symbol]?.slicesAvailable ?? 0 })),
  error: market.error,
}, null, 2));
if (!complete || market.error) process.exitCode = 1;
