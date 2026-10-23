import type { Candle } from "../../market/types.js";
import { newYorkTradingDate, stockSignal } from "./signals.js";
import type { StockFeedLike, StockMarket, StockQuote, StockSession, StockSignal } from "./types.js";

const DATA_ORIGIN = "https://data.alpaca.markets";
const PAPER_ORIGIN = "https://paper-api.alpaca.markets";
const DAY = 86_400_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUOTE_AGE_MS = 60_000;
const MAX_CLOCK_AGE_MS = 30_000;
const FUTURE_TOLERANCE_MS = 5_000;
type Json = Record<string, unknown>;
export interface AlpacaStockFeedOptions { apiKey: string; apiSecret: string; symbols: string[] }
class FeedError extends Error {}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeedError("Market data response was invalid");
  return value as Json;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new FeedError("Market data response was invalid");
  return value;
}
function time(value: unknown): number {
  if (typeof value !== "string") throw new FeedError("Market data timestamp was invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new FeedError("Market data timestamp was invalid");
  return parsed;
}

/** Read-only stock evidence: no brokerage order, account mutation, or live-trading API exists here. */
export class AlpacaStockFeed implements StockFeedLike {
  private readonly symbols: string[];
  private market: StockMarket;
  private historyDate = "";
  private historyOpenVerifiedDate = "";
  private historyAttemptAt = 0;
  private historySignals: Record<string, StockSignal> = {};
  private pending: Promise<StockMarket> | null = null;

  constructor(private readonly options: AlpacaStockFeedOptions, private readonly fetchFn: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.symbols = [...new Set(options.symbols)];
    if (!this.symbols.length || this.symbols.length > 30 || this.symbols.some((symbol) => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol))) throw new Error("Invalid stock symbols");
    this.market = { ts: 0, session: { isOpen: false, checkedAt: 0, nextOpen: 0, nextClose: 0, tradingDate: newYorkTradingDate(this.now()) }, quotes: {}, signals: {}, ready: false, error: null };
  }

  view(): StockMarket {
    const market = this.market;
    const now = this.now();
    if (market.session.isOpen && (now >= market.session.nextClose || now - market.session.checkedAt > MAX_CLOCK_AGE_MS)) {
      return { ...market, ready: false, error: now >= market.session.nextClose ? null : "Market clock is stale", session: { ...market.session, isOpen: false } };
    }
    if (market.ready && market.session.isOpen && this.symbols.some((symbol) => !this.freshQuote(market.quotes[symbol], now))) {
      return { ...market, ready: false, error: "Market quotes are stale" };
    }
    return market;
  }

  refresh(): Promise<StockMarket> {
    if (!this.pending) this.pending = this.doRefresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  private freshQuote(quote: StockQuote | undefined, now: number): boolean {
    return !!quote && now - quote.ts <= MAX_QUOTE_AGE_MS && quote.ts <= now + FUTURE_TOLERANCE_MS;
  }

  private async doRefresh(): Promise<StockMarket> {
    const now = this.now();
    let session = { ...this.market.session, isOpen: false };
    try {
      if (!this.options.apiKey.trim() || !this.options.apiSecret.trim()) throw new FeedError("Stock data credentials are missing");
      const oldSession = this.market.session;
      // Only a confirmed closed session may be cached, and never across its next open.
      session = !oldSession.isOpen && oldSession.checkedAt > 0 && now - oldSession.checkedAt < 60_000 && now < oldSession.nextOpen && newYorkTradingDate(now) === oldSession.tradingDate
        ? oldSession : await this.clock();
      if ((this.historyDate !== session.tradingDate || (session.isOpen && this.historyOpenVerifiedDate !== session.tradingDate)) && (!this.historyAttemptAt || this.now() - this.historyAttemptAt >= 60_000)) {
        this.historyAttemptAt = this.now();
        this.historySignals = await this.history(session.tradingDate);
        if (this.symbols.every((symbol) => this.historySignals[symbol]?.slicesAvailable === 9 && this.historySignals[symbol]!.completedThrough >= this.now() - 7 * DAY)) {
          this.historyDate = session.tradingDate;
          if (session.isOpen) this.historyOpenVerifiedDate = session.tradingDate;
        }
      }
      const signals = this.historySignals;
      const quotes = session.isOpen ? await this.snapshots() : this.market.quotes;
      const complete = this.symbols.every((symbol) => signals[symbol]?.slicesAvailable === 9);
      const recentHistory = this.symbols.every((symbol) => (signals[symbol]?.completedThrough ?? 0) >= this.now() - 7 * DAY);
      const verified = this.historyDate === session.tradingDate && (!session.isOpen || this.historyOpenVerifiedDate === session.tradingDate);
      const fresh = this.symbols.every((symbol) => this.freshQuote(quotes[symbol], this.now()));
      this.market = {
        ts: this.now(), session, quotes, signals,
        ready: complete && recentHistory && verified && fresh && session.isOpen,
        error: !complete ? "Waiting for at least 361 completed daily bars for every stock" : !recentHistory ? "Completed stock history is stale" : !verified ? "Waiting for current session history refresh" : session.isOpen && !fresh ? "Market quotes are stale" : null,
      };
    } catch (error) {
      // Retain evidence for diagnostics; a failed refresh never authorizes an execution.
      this.market = { ...this.market, session: { ...session, isOpen: false, checkedAt: 0 }, ready: false, error: error instanceof FeedError ? error.message : "Stock market data is unavailable" };
    }
    return this.view();
  }

  private async clock(): Promise<StockSession> {
    const data = await this.get(new URL("/v2/clock", PAPER_ORIGIN));
    const serverTime = time(data.timestamp);
    const now = this.now();
    const nextOpen = time(data.next_open);
    const nextClose = time(data.next_close);
    if (typeof data.is_open !== "boolean" || Math.abs(now - serverTime) > MAX_CLOCK_AGE_MS || (data.is_open && nextClose <= now)) throw new FeedError("Market clock is stale or invalid");
    return { isOpen: data.is_open, checkedAt: now, nextOpen, nextClose, tradingDate: newYorkTradingDate(serverTime) };
  }

  private async snapshots(): Promise<Record<string, StockQuote>> {
    const url = new URL("/v2/stocks/snapshots", DATA_ORIGIN);
    url.search = new URLSearchParams({ symbols: this.symbols.join(","), feed: "iex" }).toString();
    const data = await this.get(url);
    const quotes: Record<string, StockQuote> = {};
    for (const symbol of this.symbols) {
      const snapshot = object(data[symbol]);
      const quote = object(snapshot.latestQuote);
      const trade = object(snapshot.latestTrade);
      const bid = positive(quote.bp);
      const ask = positive(quote.ap);
      const last = positive(trade.p);
      const ts = time(quote.t);
      const tradeTs = time(trade.t);
      if (ask < bid || ts > this.now() + FUTURE_TOLERANCE_MS || tradeTs > this.now() + FUTURE_TOLERANCE_MS) throw new FeedError("Market quote was invalid");
      quotes[symbol] = { symbol, bid, ask, last, ts, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10_000 };
    }
    return quotes;
  }

  private async history(tradingDate: string): Promise<Record<string, StockSignal>> {
    // 800 calendar days comfortably cover 420 regular US equity sessions.
    const bars = await this.historicalBars("split", new Date(this.now() - 800 * DAY).toISOString(), tradingDate);
    const signals: Record<string, StockSignal> = {};
    for (const symbol of this.symbols) {
      const signal = stockSignal(symbol, bars.get(symbol)!, tradingDate);
      if (signal) signals[symbol] = signal;
    }
    if (!this.symbols.every((symbol) => signals[symbol] && signals[symbol]!.completedThrough >= this.now() - 7 * DAY)) return signals;
    // Explicit raw bars avoid relying on undocumented snapshot adjustment semantics.
    // Comparing the SAME historical session isolates the adjustment from market returns.
    const since = Math.min(...Object.values(signals).map((signal) => signal.completedThrough));
    const raw = await this.historicalBars("raw", new Date(since).toISOString(), tradingDate);
    for (const symbol of this.symbols) {
      const signal = signals[symbol]!;
      const matching = raw.get(symbol)!.find((bar) => bar.ts === signal.completedThrough);
      if (!matching) throw new FeedError("Split adjustment verification is incomplete");
      const factor = matching.c / signal.previousClose;
      if (!Number.isFinite(factor) || factor <= 0) throw new FeedError("Split adjustment verification was invalid");
      signal.splitAdjustmentFactor = factor;
    }
    return signals;
  }

  private async historicalBars(adjustment: "split" | "raw", start: string, tradingDate: string): Promise<Map<string, Candle[]>> {
    const bars = new Map(this.symbols.map((symbol) => [symbol, [] as Candle[]]));
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;
    let rows = 0;
    do {
      if (++pages > 20) throw new FeedError("Market history exceeded its page limit");
      const url = new URL("/v2/stocks/bars", DATA_ORIGIN);
      const query = new URLSearchParams({ symbols: this.symbols.join(","), timeframe: "1Day", feed: "iex", adjustment, start, end: new Date(this.now()).toISOString(), limit: "10000", sort: "asc" });
      if (pageToken) query.set("page_token", pageToken);
      url.search = query.toString();
      const data = await this.get(url);
      const groups = object(data.bars);
      for (const [symbol, values] of Object.entries(groups)) {
        if (!bars.has(symbol) || !Array.isArray(values)) throw new FeedError("Market history was invalid");
        rows += values.length;
        if (rows > 30_000) throw new FeedError("Market history exceeded its row limit");
        for (const raw of values) {
          const b = object(raw);
          const ts = time(b.t);
          const o = positive(b.o); const h = positive(b.h); const l = positive(b.l); const c = positive(b.c);
          if (l > Math.min(o, c) || h < Math.max(o, c) || h < l || ts > this.now() + FUTURE_TOLERANCE_MS || typeof b.v !== "number" || !Number.isFinite(b.v) || b.v < 0) throw new FeedError("Market history was invalid");
          bars.get(symbol)!.push({ ts, o, h, l, c, volUsd: b.v * c, confirmed: newYorkTradingDate(ts) < tradingDate });
        }
      }
      const token = data.next_page_token;
      if (token !== null && token !== undefined && (typeof token !== "string" || !token.length || token.length > 4096 || seenTokens.has(token))) throw new FeedError("Market history pagination was invalid");
      pageToken = typeof token === "string" ? token : undefined;
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return bars;
  }

  private async get(url: URL): Promise<Json> {
    const response = await this.fetchFn(url, {
      headers: { "APCA-API-KEY-ID": this.options.apiKey, "APCA-API-SECRET-KEY": this.options.apiSecret, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedError(response.status === 401 || response.status === 403 ? "Stock data authentication or entitlement failed" : "Stock market data request failed");
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_RESPONSE_BYTES || !response.body) {
      await response.body?.cancel();
      throw new FeedError("Market data response was invalid");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new FeedError("Market data response exceeded its size limit");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new FeedError("Market data response was invalid"); }
  }
}
