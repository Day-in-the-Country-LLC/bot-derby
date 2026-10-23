import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import type { JevAsk, JevResult } from "../src/jev.js";
import type { DerbyDecisions, DerbyId } from "../src/derby/decisions.js";
import { StockEngine } from "../src/derby/stocks/engine.js";
import type { StockMarket, StockRules } from "../src/derby/stocks/types.js";

const NOW = Date.UTC(2026, 9, 22, 14);
const resources: Db[] = [];
afterEach(() => resources.splice(0).forEach(db => db.close()));
const rules = (): StockRules => ({
  version: 1, season: "test-stocks", strategy: "Long-only trend following", coins: ["AAA", "BBB"], startEquityUsd: 200,
  tickMs: 10000, askEveryCycle: true, assetClass: "stocks", feed: "Alpaca IEX", candleTimeframe: "1Day",
  risk: { maxLeverage: 1, maxExposurePct: 95, dailyLossStopPct: 8, retireDrawdownPct: 60, maxEntriesPerSession: 2,
    entryCooldownMs: 4 * 3600000, spreadGateBps: 25, maxQuoteAgeMs: 60000, feeRate: .0005, slippageBps: 5,
    stopAtrMult: 2, minActionProbability: .55, minConviction: 1 },
});
function market(now = NOW): StockMarket {
  return { ts: now, ready: true, error: null,
    session: { isOpen: true, checkedAt: now, nextOpen: now + 86400000, nextClose: now + 6 * 3600000, tradingDate: "2026-10-22" },
    quotes: Object.fromEntries(["AAA", "BBB"].map(symbol => [symbol, { symbol, bid: 99.99, ask: 100.01, last: 100, ts: now, spreadBps: 2 }])),
    signals: Object.fromEntries(["AAA", "BBB"].map((symbol, i) => [symbol, { symbol, score: 5 - i, slicesAvailable: 9, barCount: 250,
      atrPct: 2, volatilityPct: 20, return1dPct: 1, return5dPct: 4, completedThrough: now - 86400000, previousClose: 100 }])) };
}
function response(ask: JevAsk, choice: string, probability = 1, conviction = 2): JevResult {
  const labels = Object.keys(ask.menu);
  return { ok: true, source: ask.key === "bee1" ? "jev" : "openai", choice, confidence: probability,
    probabilities: Object.fromEntries(labels.map(k => [k, k === choice ? probability : (1 - probability) / Math.max(1, labels.length - 1)])),
    conviction, convictionRaw: conviction, inputTokens: 100, costUsd: .001, latencyMs: 10, model: "test" };
}
function harness() {
  const db = new Db(":memory:"); resources.push(db);
  let now = NOW, m = market();
  const calls: JevAsk[] = [];
  const costs: Record<DerbyId, number> = { bee1: 0, bee2: 0 };
  let choose: (ask: JevAsk) => JevResult | Promise<JevResult> = ask => response(ask, Object.keys(ask.menu).find(k => k.startsWith("BUY_")) ?? "HOLD");
  const decisions: Pick<DerbyDecisions, "decide" | "status"> = {
    decide: async ask => { calls.push(ask); costs[ask.key as DerbyId] += .001; return choose(ask); },
    status: id => ({ provider: id === "bee1" ? "jev" : "openai", model: "test", ready: true, dailyCapUsd: null,
      spentTodayUsd: costs[id], totalCostUsd: costs[id], budgetPaused: false, lastError: null,
      successfulCalls: calls.filter(c => c.key === id).length, meanLatencyMs: 10, attemptedCalls: calls.filter(c => c.key === id).length }),
  };
  const feed = { refresh: async () => m, view: () => m };
  const r = rules();
  const create = () => new StockEngine({ db, feed, decisions, rules: r, now: () => now });
  const engine = create();
  return { db, r, engine, calls, costs, create, get m() { return m; }, setMarket(v: StockMarket) { m = v; },
    choose(fn: typeof choose) { choose = fn; },
    advance(ms: number, renew = true) { now += ms; if (renew) { m.ts = now; m.session.checkedAt = now; for (const q of Object.values(m.quotes)) q.ts = now; } },
    price(symbol: string, px: number) { Object.assign(m.quotes[symbol]!, { bid: px * .9999, ask: px * 1.0001, last: px }); },
  };
}

describe("stock competition engine", () => {
  it("starts all competitors and baselines on common fresh evidence with fractional cash-backed fills and costs", async () => {
    const h = harness();
    expect(h.engine.snapshot().startedAt).toBeNull();
    await h.engine.tick();
    const s = h.engine.snapshot();
    expect(s.startedAt).toBe(NOW);
    expect(s.state).toBe("running");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.state.market).toEqual(h.calls[1]!.state.market);
    for (const a of Object.values(s.portfolios)) {
      expect(a.position).toMatchObject({ symbol: "AAA", side: "long" });
      expect(a.position!.sizeUsd).toBeLessThan(190);
      expect(a.cashUsd).toBeCloseTo(9.905, 6);
      expect(a.equityUsd).toBeLessThan(200);
      expect(a.netPnlUsd).toBeCloseTo(a.pnlUsd - .001, 10);
      expect(a.metrics.meaningfulChoices).toBe(1);
      expect(a.totals.feesUsd).toBeCloseTo(.095, 6);
    }
    expect(s.benchmarks.map(b => b.id)).toEqual(["cash", "buy_hold", "rules"]);
    expect(s.benchmarks.find(b => b.id === "cash")!.equityUsd).toBe(200);
    expect(s.benchmarks.find(b => b.id === "buy_hold")!.totals.orders).toBe(2);
    expect(s.benchmarks.find(b => b.id === "rules")!.equityUsd).toBeCloseTo(s.portfolios.bee1.equityUsd, 8);
    expect(Object.keys(h.engine.equitySeries())).toEqual(expect.arrayContaining(["bee1", "bee2", "cash", "buy_hold", "rules"]));
  });

  it("makes no calls or fills outside regular session, on stale data, or on invalid quotes", async () => {
    const h = harness(); h.m.session.isOpen = false;
    await h.engine.tick();
    expect(h.calls).toHaveLength(0); expect(h.engine.snapshot().state).toBe("market_closed");
    expect(h.engine.snapshot().startedAt).toBeNull();
    h.m.session.isOpen = true; h.m.quotes.AAA!.ts -= 60001;
    await h.engine.tick(); expect(h.calls).toHaveLength(0); expect(h.engine.snapshot().state).toBe("stale");
    h.m.quotes.AAA!.ts = NOW; h.m.quotes.AAA!.ask = 0;
    await h.engine.tick(); expect(h.calls).toHaveLength(0);
    expect(h.engine.snapshot().portfolios.bee1.totals.orders).toBe(0);
  });

  it("continues paid hold assessments without manufacturing choices or trades when no entries qualify", async () => {
    const h = harness(); for (const s of Object.values(h.m.signals)) s.score = 0;
    await h.engine.tick(); h.advance(10000); await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(h.calls).toHaveLength(4); expect(Object.keys(h.calls[0]!.menu)).toEqual(["HOLD"]);
    expect(a.metrics).toMatchObject({ meaningfulChoices: 0, holdAssessments: 2 });
    expect(a.last.attribution).toBe("rules_required"); expect(a.equityUsd).toBe(200);
    expect(a.netEquityUsd).toBeCloseTo(199.998, 8); expect(a.totals.orders).toBe(0);
  });

  it("fails closed on API failures and off-menu answers and never uses a fallback add", async () => {
    const h = harness(); h.choose(() => ({ ok: false, reason: "error", latencyMs: 1 }));
    await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    h.choose(ask => response(ask, "BUY_AAA")); h.advance(10000); await h.engine.tick();
    const before = h.engine.snapshot().portfolios.bee1;
    h.choose(() => ({ ok: false, reason: "error", latencyMs: 1 })); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.totals.orders).toBe(before.totals.orders);
    expect(h.engine.snapshot().portfolios.bee1.last.attribution).toBe("api_unavailable");
    h.choose(ask => response(ask, "ADD")); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.totals.orders).toBe(before.totals.orders);
  });

  it("allows AI exits and half reductions during entry cooldown; never offers additions", async () => {
    const h = harness(); await h.engine.tick();
    const before = h.engine.snapshot().portfolios.bee1.position!.sizeUsd;
    h.choose(ask => response(ask, "REDUCE_HALF")); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position!.sizeUsd).toBeCloseTo(before / 2, 8);
    expect(Object.keys(h.calls.at(-1)!.menu)).toEqual(["HOLD", "CLOSE", "REDUCE_HALF"]);
    h.choose(ask => response(ask, "CLOSE")); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    expect(h.engine.snapshot().portfolios.bee1.totals.completedTrades).toBe(1);
    h.choose(ask => response(ask, "HOLD")); h.advance(10000); await h.engine.tick();
    expect(Object.keys(h.calls.at(-1)!.menu)).toEqual(["HOLD"]);
  });

  it("rejects weak entry confidence and wide spreads without affecting safe exits", async () => {
    const h = harness(); h.choose(ask => response(ask, "BUY_AAA", .54, 2));
    await h.engine.tick(); expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    h.choose(ask => response(ask, "BUY_AAA", .99, 0)); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    h.m.quotes.AAA!.spreadBps = 30; h.advance(10000); await h.engine.tick();
    expect(h.calls.at(-1)!.menu).not.toHaveProperty("BUY_AAA");
    h.m.quotes.AAA!.spreadBps = 2; h.choose(ask => response(ask, "BUY_AAA")); h.advance(10000); await h.engine.tick();
    h.choose(ask => response(ask, "CLOSE", .1, 0)); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
  });

  it("enforces two entries per exchange session and resets that counter on the next session", async () => {
    const h = harness(); await h.engine.tick();
    h.choose(ask => response(ask, "CLOSE")); h.advance(10000); await h.engine.tick();
    h.advance(4 * 3600000); h.m.session.nextClose += 4 * 3600000;
    h.choose(ask => response(ask, "BUY_AAA")); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.entriesToday).toBe(2);
    h.choose(ask => response(ask, "CLOSE")); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    h.choose(ask => response(ask, "HOLD")); h.advance(10000); await h.engine.tick();
    expect(Object.keys(h.calls.at(-1)!.menu)).toEqual(["HOLD"]);
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.choose(ask => response(ask, "BUY_AAA")); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.entriesToday).toBe(1);
  });

  it("closes protective stops before waiting for an API and tracks protective attribution", async () => {
    const h = harness(); await h.engine.tick();
    h.price("AAA", 94); h.advance(10000);
    h.choose(ask => {
      expect(h.engine.snapshot().portfolios[ask.key as DerbyId].position).toBeNull();
      expect(Object.keys(ask.menu)).toEqual(["HOLD"]);
      return response(ask, "HOLD");
    });
    await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(a.metrics.protectiveExits).toBe(1); expect(a.last.attribution).toBe("protective_exit");
    expect(a.totals.completedTrades).toBe(1); expect(a.maxDrawdownPct).toBeGreaterThan(5);
  });

  it("daily loss stops stay latched through the session; retirement remains permanent", async () => {
    const h = harness(); await h.engine.tick(); h.price("AAA", 90); h.advance(10000);
    h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.cap).toBe("loss_stop");
    h.price("AAA", 100); h.advance(10000); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.cap).toBe("loss_stop");
    const retired = harness(); await retired.engine.tick(); retired.price("AAA", 30); retired.advance(10000);
    retired.choose(ask => response(ask, "HOLD")); await retired.engine.tick();
    expect(retired.engine.snapshot().portfolios.bee1.cap).toBe("retired");
    expect(retired.engine.snapshot().state).toBe("finished");
    retired.advance(86400000); retired.m.session.tradingDate = "2026-10-23"; retired.m.session.nextClose += 86400000;
    await retired.engine.tick(); expect(retired.engine.snapshot().portfolios.bee1.cap).toBe("retired");
  });

  it("rejects late answers after market close or quote staleness", async () => {
    const h = harness(); let call = 0;
    h.choose(ask => { if (++call === 2) h.m.session.isOpen = false; return response(ask, "BUY_AAA"); });
    await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    expect(h.engine.snapshot().portfolios.bee2.position).toBeNull();
    const stale = harness(); let calls = 0;
    stale.choose(ask => { if (++calls === 2) stale.advance(60001, false); return response(ask, "BUY_AAA"); });
    await stale.engine.tick(); expect(stale.engine.snapshot().portfolios.bee1.position).toBeNull();
  });

  it("serializes ticks and shutdown drains paid calls without executing late decisions", async () => {
    const h = harness(); const releases: Array<() => void> = [];
    h.choose(ask => new Promise(resolve => releases.push(() => resolve(response(ask, "BUY_AAA")))));
    const one = h.engine.tick(), two = h.engine.tick();
    expect(one).toBe(two); await Promise.resolve(); await Promise.resolve();
    expect(h.calls).toHaveLength(2);
    const stopping = h.engine.stop();
    releases.forEach(r => r()); await Promise.all([one, two, stopping]);
    expect(h.engine.snapshot().portfolios.bee1.position).toBeNull();
    expect(h.engine.snapshot().portfolios.bee1.totals.orders).toBe(0);
  });

  it("restores durable holdings, baseline accounting, entry cooldown and API-adjusted metrics", async () => {
    const h = harness(); await h.engine.tick(); const before = h.engine.snapshot();
    await h.engine.stop(); const restored = h.create();
    expect(restored.snapshot().portfolios).toEqual(before.portfolios);
    expect(restored.snapshot().benchmarks).toEqual(before.benchmarks);
    expect(restored.snapshot().startedAt).toBe(before.startedAt);
    h.choose(ask => response(ask, "HOLD")); h.advance(10000); await restored.tick();
    expect(restored.snapshot().portfolios.bee1.totals.orders).toBe(1);
    expect(restored.snapshot().portfolios.bee1.netPnlUsd).toBeCloseTo(restored.snapshot().portfolios.bee1.pnlUsd - .002, 8);
    expect(() => new StockEngine({ db: h.db, feed: { refresh: async () => h.m, view: () => h.m }, decisions: {} as never, rules: { ...h.r, startEquityUsd: 300 } })).toThrow("does not match");
  });

  it("halts suspicious overnight discontinuities rather than recognizing split profits/losses", async () => {
    const h = harness(); await h.engine.tick(); const before = h.engine.snapshot().portfolios.bee1;
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.m.signals.AAA!.previousClose = 50; h.price("AAA", 50);
    h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(a.cap).toBe("data_issue"); expect(a.dataIssue).toContain("discontinuity");
    expect(a.equityUsd).toBe(before.equityUsd); expect(a.totals.orders).toBe(1);
    expect(h.engine.snapshot().benchmarks.find(b => b.id === "buy_hold")!.dataIssue).toContain("discontinuity");
  });

  it("keeps quotes, prices and share counts out of public snapshots, history and activities", async () => {
    const h = harness(); await h.engine.tick();
    const publicData = JSON.stringify({ s: h.engine.snapshot(), a: h.engine.activity(), e: h.engine.equitySeries() });
    for (const key of ['"bid"', '"ask"', '"last"\u003a100', '"shares"', '"entry"', '"mark"', '"stop"', '"previousClose"']) expect(publicData).not.toContain(key);
    const row = h.db.raw.prepare("SELECT state_json FROM decisions WHERE bee='bee1' AND state_json IS NOT NULL").get() as { state_json: string };
    expect(row.state_json).toContain('"quote"');
    expect(h.engine.activity().every(e => ["bee1", "bee2", "rules"].includes(e.botId))).toBe(true);
  });

  it("counts an ordinary overnight gap toward the new session loss stop", async () => {
    const h = harness(); await h.engine.tick();
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.price("AAA", 90); h.choose(ask => response(ask, "HOLD"));
    await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(a.cap).toBe("loss_stop"); expect(a.dataIssue).toBeNull(); expect(a.position).toBeNull();
  });

  it("freezes a basket consistently when its later component has an overnight data issue", async () => {
    const h = harness(); await h.engine.tick();
    const before = h.engine.snapshot().benchmarks.find(b => b.id === "buy_hold")!;
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.price("AAA", 105); h.m.signals.BBB!.previousClose = 80; h.price("BBB", 80);
    h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    const after = h.engine.snapshot().benchmarks.find(b => b.id === "buy_hold")!;
    expect(after.equityUsd).toBe(before.equityUsd); expect(after.cap).toBe("data_issue");
    expect(h.engine.snapshot().state).toBe("stale");
  });

  it("selects post-fill equity on tied timestamps and writes unrealized profit rather than market value", async () => {
    const h = harness(); await h.engine.tick();
    expect(h.engine.equitySeries().bee1!.at(-1)![1]).toBe(h.engine.snapshot().portfolios.bee1.equityUsd);
    const row = h.db.raw.prepare("SELECT upl_usd AS upl FROM equity_snapshots WHERE bee='bee1' ORDER BY rowid DESC LIMIT 1").get() as { upl: number };
    expect(row.upl).toBeLessThan(0); expect(row.upl).toBeGreaterThan(-1);
    h.price("AAA", 110); h.advance(10000); h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.totals.orders).toBe(1);
  });

  it("expires the displayed session without needing a further trading tick", async () => {
    const h = harness(); await h.engine.tick();
    h.m.session.nextClose = NOW + 1000;
    h.advance(2000, false);
    expect(h.engine.snapshot().session!.isOpen).toBe(false);
    expect(h.engine.snapshot().state).toBe("market_closed");
  });

  it("bounds private market evidence retention while preserving outcomes and spending", async () => {
    const h = harness(); await h.engine.tick();
    const old = NOW - 8 * 86400000;
    h.db.raw.prepare("INSERT INTO decisions (bee,ts,state_json,menu_json,action_json,status,decided_by) VALUES (?,?,?,?,?,?,?)")
      .run("bee1", old, '{"private_market":"old"}', '["HOLD"]', '{"kind":"hold"}', "old hold", "jev");
    h.db.reserveChooserSpend(old, "bee1", .10);
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    const oldRow = h.db.raw.prepare("SELECT state_json,menu_json,status FROM decisions WHERE ts=?").get(old);
    expect(oldRow).toMatchObject({ state_json: null, menu_json: null, status: "old hold" });
    expect(h.db.raw.prepare("SELECT charged_usd AS cost FROM chooser_spend WHERE ts=?").get(old)).toMatchObject({ cost: .10 });
  });

  it("halts even a small split confirmed by raw versus split-adjusted prior-close evidence", async () => {
    const h = harness(); await h.engine.tick(); const before = h.engine.snapshot().portfolios.bee1.equityUsd;
    h.advance(86400000); h.m.session.tradingDate = "2026-10-23"; h.m.session.nextClose += 86400000;
    h.m.signals.AAA!.splitAdjustmentFactor = 1.02;
    h.m.signals.AAA!.previousClose = 100 / 1.02; h.price("AAA", 100 / 1.02);
    h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    expect(h.engine.snapshot().portfolios.bee1.cap).toBe("data_issue");
    expect(h.engine.snapshot().portfolios.bee1.equityUsd).toBe(before);
  });

  it("never relabels a protective exit as an AI trade when the subsequent assessment fails", async () => {
    const h = harness(); await h.engine.tick(); h.price("AAA", 94); h.advance(10000);
    h.choose(() => ({ ok: false, reason: "error", latencyMs: 1 })); await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(a.last.attribution).toBe("protective_exit"); expect(a.last.decidedBy).toBe("rules");
    expect(a.metrics.protectiveExits).toBe(1); expect(a.totals.completedTrades).toBe(1);
    expect(h.engine.activity().some(e => e.botId === "bee1" && e.attribution === "api_unavailable")).toBe(true);
  });

  it("freezes holdings after missing an entire session even when the latest split factor looks normal", async () => {
    const h = harness(); await h.engine.tick(); const before = h.engine.snapshot().portfolios.bee1.equityUsd;
    h.advance(4 * 86400000); h.m.session.tradingDate = "2026-10-26"; h.m.session.nextClose += 4 * 86400000;
    for (const signal of Object.values(h.m.signals)) {
      signal.completedThrough = Date.UTC(2026, 9, 23, 4); signal.splitAdjustmentFactor = 1;
    }
    h.price("AAA", 99); h.choose(ask => response(ask, "HOLD")); await h.engine.tick();
    const a = h.engine.snapshot().portfolios.bee1;
    expect(a.cap).toBe("data_issue"); expect(a.dataIssue).toContain("missed trading session");
    expect(a.equityUsd).toBe(before); expect(a.totals.orders).toBe(1);
  });
});
