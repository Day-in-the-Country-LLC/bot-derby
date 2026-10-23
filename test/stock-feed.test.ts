import { describe, expect, it } from "vitest";
import { AlpacaStockFeed } from "../src/derby/stocks/feed.js";
import { newYorkTradingDate, stockSignal } from "../src/derby/stocks/signals.js";
import type { Candle } from "../src/market/types.js";

const OPEN = Date.parse("2026-10-22T15:00:00Z");
const DAY = 86_400_000;
const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];
function bars(count = 420, end = Date.parse("2026-10-21T16:00:00Z")) {
  return Array.from({ length: count }, (_, i) => ({ t: new Date(end - (count - i - 1) * DAY).toISOString(), o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 10000 }));
}
function candles(count: number): Candle[] {
  return bars(count).map((b) => ({ ts: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, volUsd: b.v * b.c, confirmed: true }));
}
function clock(now = OPEN, isOpen = true, close = "2026-10-22T20:00:00Z", next = "2026-10-23T13:30:00Z") {
  return { timestamp: new Date(now).toISOString(), is_open: isOpen, next_open: next, next_close: close };
}
function snapshot(now = OPEN, names = symbols) {
  return Object.fromEntries(names.map((symbol) => [symbol, { latestQuote: { bp: 519.9, ap: 520.1, t: new Date(now).toISOString() }, latestTrade: { p: 520, t: new Date(now).toISOString() } }]));
}
function harness(options: { symbols?: string[]; barCount?: number; quoteAge?: number; now?: number; isOpen?: boolean; close?: string; next?: string } = {}) {
  let now = options.now ?? OPEN;
  const requested = options.symbols ?? symbols;
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/v2/clock") return Response.json(clock(now, options.isOpen ?? true, options.close, options.next));
    if (url.pathname === "/v2/stocks/snapshots") return Response.json(snapshot(now - (options.quoteAge ?? 0), requested));
    return Response.json({ bars: Object.fromEntries(requested.map((symbol) => [symbol, bars(options.barCount, now - DAY)])), next_page_token: null });
  }) as typeof fetch;
  const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: requested }, fake, () => now);
  return { feed, calls, setNow: (value: number) => { now = value; } };
}

describe("completed daily stock signals", () => {
  it("requires all nine windows and ignores unfinished/current-day bars", () => {
    expect(stockSignal("AAPL", candles(360), "2026-10-22")).toBeNull();
    const completed = candles(361);
    const signal = stockSignal("AAPL", completed, "2026-10-22");
    expect(signal).toMatchObject({ barCount: 361, score: 9, slicesAvailable: 9 });
    expect(stockSignal("AAPL", [...completed, { ...completed[360]!, ts: Date.parse("2026-10-22T04:00:00Z"), c: 0.01 }], "2026-10-22")).toEqual(signal);
    expect(stockSignal("AAPL", completed.map((c, i) => i === 360 ? { ...c, confirmed: false } : c), "2026-10-22")).toBeNull();
    expect(signal!.volatilityPct).toBeGreaterThan(0);
    expect(signal!.return1dPct).toBeCloseTo((461 / 460 - 1) * 100);
    expect(signal!.return5dPct).toBeCloseTo((461 / 456 - 1) * 100);
  });
  it("does not count duplicate dates as extra history and uses New York rather than UTC dates", () => {
    const completed = candles(360);
    expect(stockSignal("AAPL", [...completed, { ...completed[359]!, ts: completed[359]!.ts + 1000 }], "2026-10-22")).toBeNull();
    expect(newYorkTradingDate(Date.parse("2026-10-22T02:00:00Z"))).toBe("2026-10-21");
  });
});

describe("Alpaca read-only stock feed", () => {
  it("paginates symbol-first responses and caches completed split-adjusted history", async () => {
    const calls: URL[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push(url);
      expect(init?.headers).toMatchObject({ "APCA-API-KEY-ID": "key-id-test", "APCA-API-SECRET-KEY": "secret-test" });
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBeUndefined();
      expect(["data.alpaca.markets", "paper-api.alpaca.markets"]).toContain(url.hostname);
      if (url.pathname === "/v2/clock") return Response.json(clock());
      if (url.pathname === "/v2/stocks/snapshots") return Response.json(snapshot());
      expect(url.searchParams.get("timeframe")).toBe("1Day");
      if (url.searchParams.get("adjustment") === "raw") return Response.json({ bars: Object.fromEntries(symbols.map((symbol) => [symbol, bars().slice(-1)])), next_page_token: null });
      expect(url.searchParams.get("adjustment")).toBe("split");
      expect(url.searchParams.get("feed")).toBe("iex");
      if (!url.searchParams.get("page_token")) return Response.json({ bars: { AAPL: bars() }, next_page_token: "remaining-symbols" });
      return Response.json({ bars: Object.fromEntries(symbols.slice(1).map((s) => [s, bars()])), next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols }, fake, () => OPEN);
    const result = await feed.refresh();
    expect(result.ready).toBe(true);
    expect(Object.keys(result.signals).sort()).toEqual([...symbols].sort());
    expect(Object.values(result.signals).every((s) => s.barCount === 420 && s.slicesAvailable === 9)).toBe(true);
    await feed.refresh();
    expect(calls.filter((u) => u.pathname.endsWith("/bars"))).toHaveLength(3);
    expect(calls.filter((u) => u.pathname.endsWith("/clock"))).toHaveLength(2);
  });
  it.each([1, 1.25, 1.5, 0.2])("identifies an exact same-bar raw/adjusted split factor of %s", async (factor) => {
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/clock")) return Response.json(clock());
      if (url.pathname.endsWith("/snapshots")) return Response.json(snapshot(OPEN, ["AAPL"]));
      const history = bars();
      const values = url.searchParams.get("adjustment") === "raw"
        ? history.slice(-1).map((b) => ({ ...b, o: b.o * factor, h: b.h * factor, l: b.l * factor, c: b.c * factor })) : history;
      return Response.json({ bars: { AAPL: values }, next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => OPEN);
    const market = await feed.refresh();
    expect(market.ready).toBe(true);
    expect(market.signals.AAPL!.splitAdjustmentFactor).toBeCloseTo(factor, 10);
  });
  it("rechecks adjustments at the first market open after prewarming during a closed session", async () => {
    let now = Date.parse("2026-10-22T13:29:00Z");
    let open = false;
    let historyCalls = 0;
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/clock")) return Response.json(clock(now, open, "2026-10-22T20:00:00Z", "2026-10-22T13:30:00Z"));
      if (url.pathname.endsWith("/snapshots")) return Response.json(snapshot(now, ["AAPL"]));
      historyCalls++;
      const history = bars();
      const factor = open ? 1.25 : 1;
      const values = url.searchParams.get("adjustment") === "raw"
        ? history.slice(-1).map((b) => ({ ...b, o: b.o * factor, h: b.h * factor, l: b.l * factor, c: b.c * factor })) : history;
      return Response.json({ bars: { AAPL: values }, next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => now);
    expect((await feed.refresh()).ready).toBe(false); expect(historyCalls).toBe(2);
    open = true; now += 60_000;
    const market = await feed.refresh();
    expect(market.ready).toBe(true); expect(historyCalls).toBe(4);
    expect(market.signals.AAPL!.splitAdjustmentFactor).toBeCloseTo(1.25);
  });
  it("fails closed if raw split verification lacks the identical completed bar", async () => {
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/clock")) return Response.json(clock());
      if (url.pathname.endsWith("/snapshots")) return Response.json(snapshot(OPEN, ["AAPL"]));
      return Response.json({ bars: { AAPL: url.searchParams.get("adjustment") === "raw" ? bars().slice(-2, -1) : bars() }, next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => OPEN);
    expect(await feed.refresh()).toMatchObject({ ready: false, error: "Split adjustment verification is incomplete" });
  });
  it("fails closed when any stock lacks the complete history", async () => {
    const { feed } = harness({ barCount: 360 });
    const result = await feed.refresh();
    expect(result.ready).toBe(false);
    expect(result.error).toContain("361 completed");
  });
  it("does not authorize trading on old daily history even when quotes are fresh", async () => {
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/clock")) return Response.json(clock());
      if (url.pathname.endsWith("/snapshots")) return Response.json(snapshot(OPEN, ["AAPL"]));
      return Response.json({ bars: { AAPL: bars(420, OPEN - 10 * DAY) }, next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => OPEN);
    expect(await feed.refresh()).toMatchObject({ ready: false, error: "Completed stock history is stale" });
  });
  it("retries incomplete history after a bounded delay instead of caching it for the whole day", async () => {
    let now = OPEN;
    let historyCalls = 0;
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/clock")) return Response.json(clock(now));
      if (url.pathname.endsWith("/snapshots")) return Response.json(snapshot(now, ["AAPL"]));
      if (url.searchParams.get("adjustment") === "split") historyCalls++;
      return Response.json({ bars: { AAPL: bars(historyCalls === 1 ? 360 : 420) }, next_page_token: null });
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => now);
    expect((await feed.refresh()).ready).toBe(false);
    now += 10_000; expect((await feed.refresh()).ready).toBe(false); expect(historyCalls).toBe(1);
    now += 50_000; expect((await feed.refresh()).ready).toBe(true); expect(historyCalls).toBe(2);
  });
  it("retains stale quote timestamps but never authorizes a stale fill", async () => {
    const { feed } = harness({ quoteAge: 60_001 });
    const result = await feed.refresh();
    expect(result.quotes.AAPL?.ts).toBe(OPEN - 60_001);
    expect(result.ready).toBe(false);
    expect(result.error).toBe("Market quotes are stale");
  });
  it("expires successful evidence as clock or session ages, including an early close", async () => {
    const early = Date.parse("2026-11-27T17:59:50Z");
    const h = harness({ now: early, close: "2026-11-27T18:00:00Z", next: "2026-11-30T14:30:00Z" });
    expect((await h.feed.refresh()).ready).toBe(true);
    h.setNow(early + 10_000);
    expect(h.feed.view()).toMatchObject({ ready: false, session: { isOpen: false } });
    const regular = harness(); await regular.feed.refresh(); regular.setNow(OPEN + 30_001);
    expect(regular.feed.view()).toMatchObject({ ready: false, session: { isOpen: false }, error: "Market clock is stale" });
  });
  it("honors holiday closed status and never caches it across the next opening", async () => {
    const now = Date.parse("2026-11-26T15:00:00Z");
    const h = harness({ now, isOpen: false, close: "2026-11-27T18:00:00Z", next: "2026-11-27T14:30:00Z" });
    expect((await h.feed.refresh()).session.isOpen).toBe(false);
    await h.feed.refresh();
    expect(h.calls.filter((c) => c.url.pathname.endsWith("/clock"))).toHaveLength(1);
    expect(h.calls.filter((c) => c.url.pathname.endsWith("/snapshots"))).toHaveLength(0);
    h.setNow(now + 60_000); await h.feed.refresh();
    expect(h.calls.filter((c) => c.url.pathname.endsWith("/clock"))).toHaveLength(2);
  });
  it.each(["http", "invalid", "crossed", "future", "pagination"])("preserves evidence and sanitizes %s failures", async (failure) => {
    let broken = false;
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/clock") {
        if (broken && failure === "http") return new Response("secret-test", { status: 403 });
        if (broken && failure === "invalid") return Response.json({ secret: "secret-test" });
        return Response.json(clock(broken && failure === "pagination" ? OPEN + DAY : OPEN, true, broken && failure === "pagination" ? "2026-10-23T20:00:00Z" : undefined));
      }
      if (url.pathname.endsWith("/bars")) return Response.json({ bars: { AAPL: bars() }, next_page_token: broken && failure === "pagination" ? "loop" : null });
      const data = snapshot(OPEN, ["AAPL"]);
      if (broken && failure === "crossed") data.AAPL!.latestQuote.ap = 1;
      if (broken && failure === "future") data.AAPL!.latestQuote.t = new Date(OPEN + 100_000).toISOString();
      return Response.json(data);
    }) as typeof fetch;
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols: ["AAPL"] }, fake, () => broken && failure === "pagination" ? OPEN + DAY : OPEN);
    const good = await feed.refresh(); expect(good.ready).toBe(true); broken = true;
    const bad = await feed.refresh();
    expect(bad.ready).toBe(false); expect(bad.session.isOpen).toBe(false);
    expect(bad.quotes).toEqual(good.quotes); expect(bad.signals).toEqual(good.signals);
    expect(JSON.stringify(bad)).not.toContain("secret-test");
  });
  it("rejects oversized responses and missing credentials", async () => {
    let calls = 0;
    const fake = (async () => { calls++; return new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } }); }) as typeof fetch;
    const blank = new AlpacaStockFeed({ apiKey: "", apiSecret: "", symbols }, fake, () => OPEN);
    expect((await blank.refresh()).error).toContain("credentials"); expect(calls).toBe(0);
    const feed = new AlpacaStockFeed({ apiKey: "key-id-test", apiSecret: "secret-test", symbols }, fake, () => OPEN);
    expect((await feed.refresh()).ready).toBe(false); expect(calls).toBe(1);
  });
});
