// boozy's profit lock (since 13 Oct 2026: +1.5% keeps 40% of the best move, +3% keeps 60%, +5% keeps 75%) and "an add can't make a loser".
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { BIZZY_PROFIT_LOCK } from "../src/bees/bizzy.js";
import { BOOZY_PROFIT_LOCK } from "../src/bees/boozy.js";
import { BREEZY_PROFIT_LOCK } from "../src/bees/breezy.js";
import { profitLockStop } from "../src/bees/common.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, trend, view } from "./fixtures.js";

describe("profitLockStop", () => {
  it("nothing below +1.5%", () => {
    expect(profitLockStop("long", 100, 101.4, BOOZY_PROFIT_LOCK)).toBeNull();
    expect(profitLockStop("long", 100, 99, BOOZY_PROFIT_LOCK)).toBeNull();
  });
  it("+1.5% keeps 40% of the best move, +3% keeps 60%, +5% keeps 75%", () => {
    expect(profitLockStop("long", 100, 102, BOOZY_PROFIT_LOCK)).toBeCloseTo(100.8, 10);
    expect(profitLockStop("long", 100, 104, BOOZY_PROFIT_LOCK)).toBeCloseTo(102.4, 10);
    expect(profitLockStop("long", 100, 110, BOOZY_PROFIT_LOCK)).toBeCloseTo(107.5, 10);
  });
  it("mirrors for a short", () => {
    expect(profitLockStop("short", 100, 94, BOOZY_PROFIT_LOCK)).toBeCloseTo(95.5, 10);
  });
  it("26 Sep ENA: best 0.2853 on an average entry of 0.27018 (+5.6%) now locks 75%, about 0.2815", () => {
    expect(profitLockStop("long", 0.27018, 0.2853, BOOZY_PROFIT_LOCK)).toBeCloseTo(0.27018 + 0.75 * (0.2853 - 0.27018), 10);
  });
  it("bizzy: +1.2% keeps 50%, +2.5% keeps 70%", () => {
    expect(profitLockStop("long", 100, 101.1, BIZZY_PROFIT_LOCK)).toBeNull();
    expect(profitLockStop("long", 100, 102, BIZZY_PROFIT_LOCK)).toBeCloseTo(101, 10);
    expect(profitLockStop("long", 100, 103, BIZZY_PROFIT_LOCK)).toBeCloseTo(102.1, 10);
  });
  it("breezy: +2% keeps 45%, +4% keeps 65%", () => {
    expect(profitLockStop("short", 100, 98.1, BREEZY_PROFIT_LOCK)).toBeNull();
    expect(profitLockStop("short", 100, 97, BREEZY_PROFIT_LOCK)).toBeCloseTo(98.65, 10);
    expect(profitLockStop("short", 100, 95, BREEZY_PROFIT_LOCK)).toBeCloseTo(96.75, 10);
  });
});

async function harness(px: number, answer = "RIDE") {
  const cfg = testConfig({ DRY_RUN: "true" });
  let v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, px), coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)]);
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const client: SystemOne = {
    async systemOne() {
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: answer, confidence: 0.9, probabilities: { [answer]: 0.9, RIDE: 0.1 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const db = new Db(":memory:");
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
  await engine.start();
  engine.stop();
  const setPx = (p: number) => {
    v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, p), coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)]);
  };
  return { engine, setPx, instId: v.stats.get([...v.stats.keys()].find((k) => k.startsWith("ENA"))!)!.instId };
}

describe("engine: boozy's profit lock", () => {
  it("a +6% run locks 75% of it; the lock holds as the price fades, then the stop sells", async () => {
    const h = await harness(106);
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    const p = h.engine.bees.bee3.position!;
    expect(p.peakPx).toBe(106);
    expect(p.stopPx!).toBeCloseTo(104.5, 6); // above the 2 x ATR(1h) trail at 103.88
    h.setPx(105); // fades, still above the lock
    await h.engine.tick();
    expect(h.engine.bees.bee3.position?.stopPx).toBeCloseTo(104.5, 6);
    h.setPx(104.4); // through the lock: code sells, still in profit
    await h.engine.tick();
    expect(h.engine.bees.bee3.position).toBeNull();
  });

  it("does nothing below +1.5%", async () => {
    const h = await harness(101.4);
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    expect(h.engine.bees.bee3.position!.stopPx!).toBeLessThan(100);
  });
});

describe("engine: an add can't turn a winner into a loser", () => {
  it("after DOUBLE_DOWN the stop is at least the new average entry", async () => {
    const h = await harness(100, "DOUBLE_DOWN");
    // DOUBLE_DOWN is only on the menu after a 1.5 x ATR(1h) run: ATR(1h) is 1.0 here, so the entry sits 1.6 below.
    h.engine.bees.bee3.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 3, entryPx: 98.4, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    h.engine.bees.bee3.flatSince = null;
    await h.engine.tick();
    const p = h.engine.bees.bee3.position!;
    expect(p.contracts).toBeGreaterThan(3); // the add filled
    expect(p.entryPx).toBeGreaterThan(98.4);
    expect(p.stopPx!).toBeGreaterThanOrEqual(p.entryPx - 1e-9);
  });
});

describe("engine: breezy's TRIM_HALF trims once per 3-point drop, not every tick", () => {
  it("re-bases entryScore after a trim, so the next tick does not trim again", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const btc = coin("BTC", { trend: trend({ score: 4, rv90Pct: 20 }) }, 80000);
    const v = view([btc]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const asked: string[][] = [];
    const client: SystemOne = {
      async systemOne(req) {
        const labels = Object.keys((req.questions.action as unknown as { criteria: object }).criteria);
        asked.push(labels);
        const choice = labels.includes("TRIM_HALF") ? "TRIM_HALF" : labels[0]!;
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }, conviction: { type: "score", score: 2, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    engine.bees.bee2.position = { instId: btc.instId, coin: "BTC", side: "long", contracts: 400, entryPx: 80000, openedAt: NOW - 60 * 60_000, stopPx: 70000, riskUsd: 10, initialStopPx: 70000, entryScore: 7 };
    engine.bees.bee2.flatSince = null;
    await engine.tick();
    expect(engine.bees.bee2.position!.contracts).toBe(200);
    expect(engine.bees.bee2.position!.entryScore).toBe(4);
    await engine.tick();
    expect(engine.bees.bee2.position!.contracts).toBe(200);
  });
});

describe("engine: over the daily cap the bees run on the code fallback", () => {
  it("asks the chooser (which answers from code at no cost) instead of freezing every bee", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const s = coin("SOL", { ret24hPct: 3, ret1hPct: 0.5, oiChg1hPct: 0.5, rsi14: 60 });
    const v = view([s]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const db = new Db(":memory:");
    const jev = new Jev({ ...cfg.jev, apiKey: "set", spentTodayUsd: cfg.jev.dailyUsdCap, now: () => NOW, fetchFn: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch });
    expect(jev.capTripped).toBe(true);
    const engine = new Engine({ cfg, db, feed, jev, exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    await engine.tick();
    expect(engine.bees.bee3.position?.coin).toBe("SOL");
    expect(jev.spentTodayUsd).toBe(cfg.jev.dailyUsdCap);
  });
});

// ---- A stalled chooser never delays a deterministic exit. ----

describe("engine: stops do not wait on the chooser", () => {
  async function stalled(px: number) {
    const cfg = testConfig({ DRY_RUN: "true" });
    let v = view([coin("ENA", { ret24hPct: 5, ret1hPct: -0.5 }, px)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const asked: string[] = [];
    let release: (answer: string) => void = () => {};
    const client: SystemOne = {
      systemOne(req) {
        asked.push((req.questions.action as unknown as { instructions: string }).instructions);
        // Never resolves until the test says so: a Gemini call stuck for its whole timeout.
        return new Promise((resolve) => {
          release = (choice) => resolve({ model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } }, conviction: { type: "score", score: 2, confidence: 1, legend: {}, probabilities: {} } } } as never);
        });
      },
    };
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    const instId = [...v.stats.keys()][0]!;
    engine.bees.bee3.position = { instId, coin: "ENA", side: "long", contracts: 100, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 95, riskUsd: 5, initialStopPx: 95 };
    engine.bees.bee3.flatSince = null;
    const setPx = (p: number) => (v = view([coin("ENA", { ret24hPct: 5, ret1hPct: -0.5 }, p)]));
    const orders = () => db.raw.prepare("SELECT purpose FROM orders WHERE bee = 'bee3'").all() as Array<{ purpose: string }>;
    return { engine, db, asked, setPx, orders, release: (c: string) => release(c) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("a stop already crossed fires on that tick, and the hung chooser is never even asked", async () => {
    const h = await stalled(94); // below the 95 stop
    void h.engine.tick(); // never awaited: the tick may hang on the chooser for other bees
    await settle();
    expect(h.engine.bees.bee3.position).toBeNull();
    expect(h.orders()).toEqual([{ purpose: "stop" }]);
    expect(h.asked.some((a) => a.includes("boozy-bee"))).toBe(false);
  });

  it("a stop crossed while the chooser hangs fires from the exit watch; the late answer is dropped", async () => {
    const h = await stalled(100);
    const tick = h.engine.tick();
    await settle();
    expect(h.asked.some((a) => a.includes("boozy-bee"))).toBe(true); // boozy is waiting on the chooser
    expect(h.engine.bees.bee3.position).not.toBeNull();
    h.setPx(94); // the price falls through the stop mid-call
    await h.engine.exitWatch();
    expect(h.engine.bees.bee3.position).toBeNull();
    expect(h.orders()).toEqual([{ purpose: "stop" }]);
    h.release("BAIL"); // the chooser finally answers, for a position that is gone
    await tick;
    expect(h.orders()).toEqual([{ purpose: "stop" }]);
    const chosen = h.db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE bee = 'bee3' AND choice = 'BAIL'").get() as { n: number };
    expect(chosen.n).toBe(0);
  });

  it("the exit watch does not depend on the tick: with no tick running it still fires a crossed stop", async () => {
    const h = await stalled(94);
    await h.engine.exitWatch();
    expect(h.engine.bees.bee3.position).toBeNull();
    expect(h.orders()).toEqual([{ purpose: "stop" }]);
  });
});

// ---- The exit watch covers EVERY open bee while any chooser call blocks the tick. ----

describe("engine: one bee's hung chooser delays no other bee's stop", () => {
  async function twoBees(exec?: (v: () => ReturnType<typeof view>) => SimExecutor) {
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([coin("ENA", { ret24hPct: 5, ret1hPct: -0.5 }, 100)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    let calls = 0;
    const client: SystemOne = { systemOne: () => (calls++, new Promise(() => {})) }; // hangs for ever
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: exec ? exec(() => v) : new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    const instId = [...v.stats.keys()][0]!;
    const setMid = (px: number) => {
      v.tickers.get(instId)!.mid = px;
      v.stats.get(instId)!.mid = px;
    };
    const orders = () => db.raw.prepare("SELECT bee, purpose FROM orders ORDER BY id").all() as Array<{ bee: string; purpose: string }>;
    return { engine, cfg, instId, setMid, orders, calls: () => calls };
  }

  it("a benched bizzy below her stop is closed while boozy's chooser hangs", async () => {
    const h = await twoBees();
    const pos = { instId: h.instId, coin: "ENA", side: "long" as const, contracts: 100, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 95, initialStopPx: 95, riskUsd: 5 };
    h.engine.bees.bee1.position = { ...pos };
    h.engine.bees.bee1.flatSince = null;
    h.engine.bees.bee1.cap = "trade_cap";
    h.engine.bees.bee1.tradesToday = h.cfg.bees.bizzy.maxTradesPerDay;
    h.engine.bees.bee3.position = { ...pos, stopPx: 80, initialStopPx: 80 };
    h.engine.bees.bee3.flatSince = null;
    void h.engine.tick(); // blocks on boozy's chooser
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls()).toBe(1);
    h.setMid(94);
    await h.engine.exitWatch();
    await h.engine.tick(); // still blocked: returns at once
    expect(h.engine.bees.bee1.position).toBeNull();
    expect(h.orders()).toContainEqual({ bee: "bee1", purpose: "stop" });
  });

  it("covers a bee that already decided this tick (rules-only hold) while another bee's chooser hangs", async () => {
    const h = await twoBees();
    // breezy holds ENA: no trend data for it, so her menu is a lone HOLD_WINNER (rules-only, no chooser call).
    const pos = { instId: h.instId, coin: "ENA", side: "long" as const, contracts: 100, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 95, initialStopPx: 95, riskUsd: 5 };
    h.engine.bees.bee2.position = { ...pos };
    h.engine.bees.bee2.flatSince = null;
    h.engine.bees.bee3.position = { ...pos, stopPx: 80, initialStopPx: 80 };
    h.engine.bees.bee3.flatSince = null;
    void h.engine.tick();
    await new Promise((r) => setTimeout(r, 20));
    h.setMid(94);
    await h.engine.exitWatch();
    expect(h.engine.bees.bee2.position).toBeNull();
    expect(h.orders().filter((o) => o.bee === "bee2")).toEqual([{ bee: "bee2", purpose: "stop" }]);
  });

  it("serializes per bee: the tick and the exit watch racing on one stop send exactly one order", async () => {
    // A slow exchange: every order takes 30 ms, so both passes see the position before either fills.
    const h = await twoBees((v) => {
      const sim = new SimExecutor(v, 0.0005);
      const market = sim.market.bind(sim);
      sim.market = async (...a: Parameters<SimExecutor["market"]>) => (await new Promise((r) => setTimeout(r, 30)), market(...a));
      return sim;
    });
    h.engine.bees.bee1.position = { instId: h.instId, coin: "ENA", side: "long", contracts: 100, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 95, initialStopPx: 95, riskUsd: 5 };
    h.engine.bees.bee1.flatSince = null;
    h.setMid(94);
    await Promise.all([h.engine.tick(), h.engine.exitWatch(), h.engine.exitWatch()]);
    expect(h.engine.bees.bee1.position).toBeNull();
    expect(h.orders().filter((o) => o.bee === "bee1")).toEqual([{ bee: "bee1", purpose: "stop" }]);
  });
});
