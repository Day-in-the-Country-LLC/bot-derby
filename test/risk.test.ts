// Phase 5: every cap, gate and forcing rule, in both directions.
import { describe, expect, it } from "vitest";
import { MARGIN_HEADROOM } from "../src/bees/common.js";
import { bizzy } from "../src/bees/bizzy.js";
import { boozy } from "../src/bees/boozy.js";
import { breezy } from "../src/bees/breezy.js";
import type { BeeBrain, BeeContext, Intent } from "../src/bees/types.js";
import { applyRisk, evaluateCaps, type JevStatus, type Proposal, type RiskInput } from "../src/risk.js";
import { bee, coin, ctx, NOW, position, testConfig, trend, view } from "./fixtures.js";

const open = (instId: string, side: "long" | "short" = "long", setup: "strict" | "loose" = "strict", sizeFrac = 1): Intent => ({ kind: "open", instId, side, sizeFrac, setup });
const prop = (intent: Intent, prob = 0.9, conviction = 3, label = "X"): Proposal => ({ label, intent, prob, conviction });

function run(c: BeeContext, brain: BeeBrain, proposal: Proposal | null, jev: JevStatus = "ok", extra: Partial<RiskInput> = {}) {
  return applyRisk({ ctx: c, brain, proposal, jev, sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 210_000, ...extra });
}

const SOL = coin("SOL");
const V = view([SOL, coin("BTC", { trend: trend({ score: 5 }) }, 80000), coin("ETH", { trend: trend({ score: -2 }) }, 2700)]);

describe("caps", () => {
  it("daily loss stop trips at -8% and stays quiet at -7.9%", () => {
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 306.3, dayStartEquityUsd: 333 }), V)).cap).toBe("loss_stop");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 306.8, dayStartEquityUsd: 333 }), V)).cap).toBeNull();
  });

  it("retire line trips at 40% of start and not above it", () => {
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 133, dayStartEquityUsd: 133 }), V)).cap).toBe("retired");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { equityUsd: 134, dayStartEquityUsd: 134 }), V)).cap).toBeNull();
  });

  it("trade cap trips at the max and not one below (bizzy 4, breezy 2, boozy 3)", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 4 }), V)).cap).toBe("trade_cap");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 3 }), V)).cap).toBeNull();
    expect(evaluateCaps(ctx("breezy", bee("breezy", { tradesToday: 2 }), V)).cap).toBe("trade_cap");
    expect(evaluateCaps(ctx("breezy", bee("breezy", { tradesToday: 1 }), V)).cap).toBeNull();
    expect(evaluateCaps(ctx("boozy", bee("boozy", { tradesToday: 3 }), V)).cap).toBe("trade_cap");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { tradesToday: 2 }), V)).cap).toBeNull();
  });

  it("fee budget trips when spent and not before (bizzy $1.20, breezy $0.75, boozy $1.50)", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { feesTodayUsd: 1.2 }), V)).cap).toBe("fee_budget");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { feesTodayUsd: 1.19 }), V)).cap).toBeNull();
    expect(evaluateCaps(ctx("breezy", bee("breezy", { feesTodayUsd: 0.75 }), V)).cap).toBe("fee_budget");
    expect(evaluateCaps(ctx("breezy", bee("breezy", { feesTodayUsd: 0.74 }), V)).cap).toBeNull();
    expect(evaluateCaps(ctx("boozy", bee("boozy", { feesTodayUsd: 1.5 }), V)).cap).toBe("fee_budget");
    expect(evaluateCaps(ctx("boozy", bee("boozy", { feesTodayUsd: 1.49 }), V)).cap).toBeNull();
  });

  it("reports a trip only once", () => {
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 6 }), V)).tripped).toBe("trade_cap");
    expect(evaluateCaps(ctx("bizzy", bee("bizzy", { tradesToday: 6, cap: "trade_cap" }), V)).tripped).toBeNull();
  });

  it("a loss stop escalates over an active trade cap", () => {
    const r = evaluateCaps(ctx("bizzy", bee("bizzy", { cap: "trade_cap", tradesToday: 6, equityUsd: 300, dayStartEquityUsd: 333 }), V));
    expect(r).toEqual({ cap: "loss_stop", tripped: "loss_stop" });
  });
});

describe("loss stop and retire go flat", () => {
  it("closes an open position on the loss stop, even if Jev says ride", () => {
    const b = bee("boozy", { equityUsd: 300, dayStartEquityUsd: 333, position: position(SOL), flatSince: null });
    const r = run(ctx("boozy", b, V), boozy, prop({ kind: "hold" }));
    expect(r.action).toEqual({ kind: "close", reason: "loss_stop" });
    expect(r.forcedBy).toBe("loss_stop");
  });

  it("when flat and sent home, never forces an entry", () => {
    const b = bee("boozy", { equityUsd: 300, dayStartEquityUsd: 333, flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", b, V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("none");
    expect(r.status).toMatch(/sent home/);
  });
});

describe("code stops", () => {
  it("stop fires when mark crosses it (long) and not before", () => {
    const hit = bee("bizzy", { position: position(SOL, { stopPx: 100.5 }), flatSince: null });
    expect(run(ctx("bizzy", hit, V), bizzy, prop({ kind: "hold" })).action).toEqual({ kind: "close", reason: "stop" });
    const safe = bee("bizzy", { position: position(SOL, { stopPx: 99 }), flatSince: null });
    expect(run(ctx("bizzy", safe, V), bizzy, prop({ kind: "hold" })).action.kind).toBe("none");
  });

  it("short stop fires above", () => {
    const b = bee("bizzy", { position: position(SOL, { side: "short", stopPx: 99.5 }), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, prop({ kind: "hold" })).forcedBy).toBe("stop");
  });

  it("stops fire even while Jev is unreachable", () => {
    const b = bee("bizzy", { position: position(SOL, { stopPx: 101 }), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, null, "unreachable").action.kind).toBe("close");
  });

  it("bizzy's 4h time stop: fires at 240 minutes and not at 239", () => {
    const old = bee("bizzy", { position: position(SOL, { openedAt: NOW - 240 * 60_000 }), flatSince: null });
    expect(run(ctx("bizzy", old, V), bizzy, prop({ kind: "hold" })).forcedBy).toBe("time_stop");
    const young = bee("bizzy", { position: position(SOL, { openedAt: NOW - 239 * 60_000 }), flatSince: null });
    expect(run(ctx("bizzy", young, V), bizzy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });

  it("boozy's 12h time stop: fires at 720 minutes and not at 719", () => {
    const old = bee("boozy", { position: position(SOL, { openedAt: NOW - 720 * 60_000 }), flatSince: null });
    expect(run(ctx("boozy", old, V), boozy, prop({ kind: "hold" })).action).toEqual({ kind: "close", reason: "time_stop" });
    const young = bee("boozy", { position: position(SOL, { openedAt: NOW - 719 * 60_000 }), flatSince: null });
    expect(run(ctx("boozy", young, V), boozy, prop({ kind: "hold" })).action.kind).toBe("none");
  });

  it("breezy has no time stop: a trend may run for days", () => {
    const BTC = V.stats.get("BTC-USD_UM_XPERP-310404")!;
    const b = bee("breezy", { position: position(BTC, { contracts: 400, openedAt: NOW - 5 * 24 * 60 * 60_000 }), flatSince: null });
    expect(run(ctx("breezy", b, V), breezy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });
});

describe("Jev fail-closed", () => {
  it("unreachable: holds a position and opens nothing, even when flat past the limit", () => {
    const flat = bee("boozy", { flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", flat, V), boozy, null, "unreachable");
    expect(r.action.kind).toBe("none");
    expect(r.vetoedBy).toBe("jev_unreachable");
  });

  it("daily cap: all bees hold", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, null, "daily_cap");
    expect(r.action.kind).toBe("none");
    expect(r.status).toMatch(/daily cap/);
  });

  it("a healthy Jev answer goes through", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("open");
    expect(r.vetoedBy).toBeNull();
  });
});

describe("trade cap and fee budget: hold or close only", () => {
  it("vetoes an open when the trade cap is hit", () => {
    const b = bee("bizzy", { tradesToday: 6 });
    const r = run(ctx("bizzy", b, V), bizzy, prop(open(SOL.instId)));
    expect(r.vetoedBy).toBe("trade_cap");
    expect(r.action.kind).toBe("none");
  });

  it("still allows a close when capped", () => {
    const b = bee("bizzy", { tradesToday: 6, position: position(SOL), flatSince: null });
    const r = run(ctx("bizzy", b, V), bizzy, prop({ kind: "close", reason: "cut_loss" }));
    expect(r.action).toEqual({ kind: "close", reason: "cut_loss" });
  });

  it("vetoes a switch and a double-down under the fee budget", () => {
    const b = bee("boozy", { feesTodayUsd: 3, position: position(SOL), flatSince: null });
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "switch", instId: "BTC-USD_UM_XPERP-310404", side: "long", sizeFrac: 1, setup: "strict" })).vetoedBy).toBe("fee_budget");
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "add", sizeFrac: 1 })).vetoedBy).toBe("fee_budget");
  });

  it("a benched bee opens nothing and says why", () => {
    const b = bee("boozy", { tradesToday: 3, flatSince: NOW - 3_600_000 });
    const r = run(ctx("boozy", b, V), boozy, prop(open(SOL.instId)));
    expect(r.action.kind).toBe("none");
    expect(r.vetoedBy).toBe("trade_cap");
    expect(r.forcedBy).toBeNull();
    expect(r.status).toMatch(/benched: all 3 trades used today/);
  });
});

describe("spread gate", () => {
  it("vetoes a coin above the bee's gate", () => {
    const RAY = coin("RAY", { spreadBp: 58.6 });
    const v = view([RAY, SOL]);
    const r = run(ctx("boozy", bee("boozy", { flatSince: NOW }), v), boozy, prop(open(RAY.instId)));
    expect(r.vetoedBy).toMatch(/^spread_gate RAY 58.6bp/);
  });

  it("allows a coin at exactly the gate and vetoes one just above it (boozy 8 bp)", () => {
    const X = coin("X", { spreadBp: 8 });
    expect(run(ctx("boozy", bee("boozy"), view([X])), boozy, prop(open(X.instId))).action.kind).toBe("open");
    const Y = coin("Y", { spreadBp: 8.1 });
    expect(run(ctx("boozy", bee("boozy"), view([Y])), boozy, prop(open(Y.instId))).vetoedBy).toMatch(/^spread_gate Y 8.1bp/);
  });

  it("the gate also applies to an add", () => {
    const W = coin("W", { spreadBp: 9 });
    const b = bee("boozy", { position: position(W), flatSince: null });
    expect(run(ctx("boozy", b, view([W])), boozy, prop({ kind: "add", sizeFrac: 0.25 })).vetoedBy).toMatch(/^spread_gate W/);
  });
});

describe("funding veto on crowded longs (bizzy and boozy, z > 1.5)", () => {
  it("vetoes a long above the line, allows one at it, and never blocks a short", () => {
    for (const [id, brain] of [["bizzy", bizzy], ["boozy", boozy]] as const) {
      const hot = coin("H", { fundingZ: 1.6 });
      expect(run(ctx(id, bee(id), view([hot])), brain, prop(open(hot.instId))).vetoedBy).toMatch(/^funding_veto H/);
      const edge = coin("E", { fundingZ: 1.5 });
      expect(run(ctx(id, bee(id), view([edge])), brain, prop(open(edge.instId))).action.kind).toBe("open");
      expect(run(ctx(id, bee(id), view([hot])), brain, prop(open(hot.instId, "short"))).action.kind).toBe("open");
    }
  });
});

describe("bizzy: waits for her breakout", () => {
  it("is never forced in, however long she has been flat", () => {
    const b = bee("bizzy", { flatSince: NOW - 10 * 60 * 60_000 });
    const r = run(ctx("bizzy", b, view([coin("SOL", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 } }, 101)])), bizzy, null, "no_options");
    expect(r.forcedBy).toBeNull();
    expect(r.action.kind).toBe("none");
    expect(r.status).toBe("SOL is 0.99% from breakout");
  });

  it("the risk layer caps any intent at 2x x 0.97 (her own menu offers 0.5 of that, 1x equity)", () => {
    const r = run(ctx("bizzy", bee("bizzy"), V), bizzy, prop(open(SOL.instId, "long", "strict", 1)));
    expect(r.action).toMatchObject({ kind: "open" });
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(666 * MARGIN_HEADROOM, 5);
  });
});

describe("breezy: open gate and never flat", () => {
  const BTC = V.stats.get("BTC-USD_UM_XPERP-310404")!;

  it("opens with p >= 0.55 and conviction >= 1, sized |score|/9 under the vol cap", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, prop(open(BTC.instId, "long", "strict", 5 / 9), 0.55, 1));
    expect(r.action.kind).toBe("open");
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo((5 / 9) * 666 * MARGIN_HEADROOM, 5);
  });

  it("a weak pick while flat is vetoed and nothing is forced in (neverForce)", () => {
    const r = run(ctx("breezy", bee("breezy", { flatSince: NOW - 10 * 60 * 60_000 }), V), breezy, prop(open(BTC.instId, "long", "strict", 5 / 9), 0.54, 3));
    expect(r.vetoedBy).toMatch(/^weak_conviction/);
    expect(r.forcedBy).toBeNull();
    expect(r.action.kind).toBe("none");
  });

  it("conviction 0 with high probability is still vetoed", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, prop(open(BTC.instId), 0.95, 0));
    expect(r.vetoedBy).toMatch(/^weak_conviction/);
  });

  it("a loose setup is never opened (requiresStrictSetup)", () => {
    const r = run(ctx("breezy", bee("breezy"), V), breezy, prop(open(BTC.instId, "long", "loose", 5 / 9), 0.9, 3));
    expect(r.vetoedBy).toBe("no_setup_yet");
  });

  it("a weak flip while positioned becomes HOLD", () => {
    // $400 position: already at target size (5/9 of $666), so no rebalance either.
    const b = bee("breezy", { position: position(BTC, { contracts: 400 }), flatSince: null });
    const r = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "loose" }, 0.6, 1));
    expect(r.action.kind).toBe("none");
    expect(r.forcedBy).toBeNull();
  });

  it("4h cooldown blocks a flip and an open, and nothing is forced in its place", () => {
    const b = bee("breezy", { position: position(BTC), flatSince: null, lastOrderAt: NOW - 60 * 60_000 });
    const flip = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "strict" }, 0.9, 3));
    expect(flip.vetoedBy).toBe("cooldown 180m");
    const flat = bee("breezy", { flatSince: NOW, lastOrderAt: NOW - 60_000 });
    const blocked = run(ctx("breezy", flat, V), breezy, prop(open(BTC.instId), 0.9, 3));
    expect(blocked.vetoedBy).toBe("cooldown 239m");
    expect(blocked.forcedBy).toBeNull();
    expect(blocked.action.kind).toBe("none");
  });

  it("cooldown is quiet once it has elapsed", () => {
    const b = bee("breezy", { position: position(BTC), flatSince: null, lastOrderAt: NOW - 241 * 60_000 });
    const r = run(ctx("breezy", b, V), breezy, prop({ kind: "switch", instId: BTC.instId, side: "short", sizeFrac: 0.5, setup: "strict" }, 0.9, 3));
    expect(r.action.kind).toBe("switch");
  });

  it("cooldowns per bee: bizzy 30 min, boozy 60 min", () => {
    const bz = run(ctx("bizzy", bee("bizzy", { lastOrderAt: NOW - 29 * 60_000 }), V), bizzy, prop(open(SOL.instId)));
    expect(bz.vetoedBy).toBe("cooldown 1m");
    expect(run(ctx("bizzy", bee("bizzy", { lastOrderAt: NOW - 30 * 60_000 }), V), bizzy, prop(open(SOL.instId))).action.kind).toBe("open");
    const bo = run(ctx("boozy", bee("boozy", { lastOrderAt: NOW - 59 * 60_000 }), V), boozy, prop(open(SOL.instId)));
    expect(bo.vetoedBy).toBe("cooldown 1m");
    expect(run(ctx("boozy", bee("boozy", { lastOrderAt: NOW - 60 * 60_000 }), V), boozy, prop(open(SOL.instId))).action.kind).toBe("open");
  });
});

describe("breezy: code keeps her at target size", () => {
  it("a HOLD on an undersized winner (uplR > 0.5) becomes a rebalance add, sized on realised cash", () => {
    const BTC = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    // Equity 343 includes $10 of unbooked profit; cash is 333, so the target is 2 x 333 x 0.97, not 2 x 343 x 0.97.
    const b = bee("breezy", { position: position(BTC, { contracts: 10 }), flatSince: null, cashUsd: 333, equityUsd: 343, uplUsd: 10 });
    const r = run(ctx("breezy", b, view([BTC])), breezy, prop({ kind: "hold" }));
    expect(r.forcedBy).toBe("rebalance");
    expect(r.action).toMatchObject({ kind: "add" });
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(666 * MARGIN_HEADROOM - 10, 5);
  });

  it("no rebalance on a position that is not yet a winner (uplR <= 0.5)", () => {
    const BTC = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const b = bee("breezy", { position: position(BTC, { contracts: 10 }), flatSince: null, uplUsd: 5 });
    expect(run(ctx("breezy", b, view([BTC])), breezy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });

  it("an add is sized on realised cash, never on unbooked profit, and never on a negative cash balance", () => {
    const W = coin("W");
    const winner = bee("boozy", { position: position(W, { contracts: 100 }), flatSince: null, cashUsd: 200, equityUsd: 400, dayStartEquityUsd: 400, uplUsd: 200 });
    const r = run(ctx("boozy", winner, view([W])), boozy, prop({ kind: "add", sizeFrac: 1 }));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(2 * 200 * MARGIN_HEADROOM - 100, 5);
    const broke = bee("boozy", { position: position(W, { contracts: 100 }), flatSince: null, cashUsd: -5, equityUsd: 300, dayStartEquityUsd: 300, uplUsd: 305 });
    expect(run(ctx("boozy", broke, view([W])), boozy, prop({ kind: "add", sizeFrac: 1 })).vetoedBy).toBe("size_cap");
  });
  it("no rebalance while benched", () => {
    const BTC = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const b = bee("breezy", { position: position(BTC, { contracts: 10 }), flatSince: null, tradesToday: 3 });
    expect(run(ctx("breezy", b, view([BTC])), breezy, prop({ kind: "hold" })).forcedBy).toBeNull();
  });
});

describe("boozy: waits flat for a clean impulse", () => {
  it("is not forced back in after bailing, however long he is flat", () => {
    for (const flatMs of [2000, 10 * 60 * 60_000]) {
      const r = run(ctx("boozy", bee("boozy", { flatSince: NOW - flatMs }), V), boozy, null, "no_options");
      expect(r.forcedBy).toBeNull();
      expect(r.action.kind).toBe("none");
    }
  });

  it("an APE from his own menu is 1x equity (half of max)", () => {
    const S = coin("S", { ret24hPct: 3, ret1hPct: 0.5, oiChg1hPct: 0.5, rsi14: 60 });
    const c = ctx("boozy", bee("boozy"), view([S]));
    const ape = boozy.menu(c).APE_S!;
    const r = run(c, boozy, prop(ape.intent));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(0.5 * 666 * MARGIN_HEADROOM, 5);
  });

  it("always enters at 1x whatever the conviction; size comes from pyramiding", () => {
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "long", "strict", 0.5), 0.5, 3)).action).toMatchObject({ notionalUsd: 333 * MARGIN_HEADROOM });
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId, "long", "strict", 0.5), 0.5, 0)).action).toMatchObject({ notionalUsd: 333 * MARGIN_HEADROOM });
  });
});

describe("a hold while flat is accepted, and menu sanity", () => {
  it("a WAIT while flat stays flat: nothing is forced", () => {
    const r = run(ctx("boozy", bee("boozy", { flatSince: NOW - 10 * 60 * 60_000 }), V), boozy, prop({ kind: "hold" }));
    expect(r.action.kind).toBe("none");
    expect(r.forcedBy).toBeNull();
  });

  it("the global flat limit still caps a bee's own limit (both default to 1440, i.e. unused)", () => {
    expect(testConfig().bees.bizzy.maxFlatMinutes).toBe(1440);
    expect(testConfig({ BIZZY_MAX_FLAT_MINUTES: "45" }).bees.bizzy.maxFlatMinutes).toBe(45);
    expect(testConfig({ MAX_FLAT_MINUTES: "10" }).bees.bizzy.maxFlatMinutes).toBe(10);
  });

  it("a brain without neverForce is still forced in after its flat limit, but never through a cooldown", () => {
    const S = coin("S");
    const forcing = { ...boozy, neverForce: false, forcedEntry: () => ({ kind: "open" as const, instId: S.instId, side: "long" as const, sizeFrac: 0.5, setup: "strict" as const }) };
    const cfg = testConfig({ BOOZY_MAX_FLAT_MINUTES: "30" });
    const due = run(ctx("boozy", bee("boozy", { flatSince: NOW - 31 * 60_000 }), view([S]), cfg), forcing, null, "no_options");
    expect(due.forcedBy).toBe("max_flat");
    const cooling = run(ctx("boozy", bee("boozy", { flatSince: NOW - 31 * 60_000, lastOrderAt: NOW - 31 * 60_000 }), view([S]), cfg), forcing, null, "no_options");
    expect(cooling.forcedBy).toBeNull();
    expect(cooling.status).toMatch(/cooling down/);
  });

  it("rejects close while flat and open while positioned", () => {
    expect(run(ctx("bizzy", bee("bizzy", { flatSince: NOW }), V), bizzy, prop({ kind: "close", reason: "x" })).vetoedBy).toBe("invalid_while_flat");
    const b = bee("bizzy", { position: position(SOL), flatSince: null });
    expect(run(ctx("bizzy", b, V), bizzy, prop(open(SOL.instId))).vetoedBy).toBe("invalid_while_positioned");
  });
});

describe("size cap: 2x and the absolute ceiling", () => {
  it("never exceeds MAX_LEVERAGE x equity", () => {
    const r = run(ctx("boozy", bee("boozy", { equityUsd: 200, dayStartEquityUsd: 200 }), V), boozy, prop(open(SOL.instId), 0.9, 3));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(400 * MARGIN_HEADROOM, 5);
  });

  it("never exceeds MAX_NOTIONAL_USD_PER_BEE even with a big (demo) balance", () => {
    const r = run(ctx("boozy", bee("boozy", { equityUsd: 5000, dayStartEquityUsd: 5000 }), V), boozy, prop(open(SOL.instId), 0.9, 3));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBe(700);
  });

  it("refuses MAX_LEVERAGE above 2", () => {
    expect(() => testConfig({ MAX_LEVERAGE: "3" })).toThrow(/Hard rule 3/);
  });

  it("the live ramp shrinks size", () => {
    const r = run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId), 0.9, 3), "ok", { sizeMult: 0.25 });
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(166.5 * MARGIN_HEADROOM, 5);
  });

  it("double-down is capped at the room left under max", () => {
    const b = bee("boozy", { position: position(SOL, { contracts: 500 }), flatSince: null }); // 500 contracts x $1 = $500
    const r = run(ctx("boozy", b, V), boozy, prop({ kind: "add", sizeFrac: 1 }));
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(666 * MARGIN_HEADROOM - 500, 5);
  });

  it("vetoes an order below the instrument minimum", () => {
    const pricey = coin("BIG");
    const v = view([pricey]);
    v.instruments.get(pricey.instId)!.minSz = 10_000; // min order $10,000
    const r = run(ctx("boozy", bee("boozy"), v), boozy, prop(open(pricey.instId)));
    expect(r.vetoedBy).toMatch(/^below_min_size/);
  });
});

describe("stale data", () => {
  it("blocks opens on stale market data but still lets a close through", () => {
    const stale = { dataAgeMs: 300_000 };
    expect(run(ctx("boozy", bee("boozy"), V), boozy, prop(open(SOL.instId)), "ok", stale).vetoedBy).toBe("stale_market_data");
    const b = bee("boozy", { position: position(SOL), flatSince: null });
    expect(run(ctx("boozy", b, V), boozy, prop({ kind: "close", reason: "bail" }), "ok", stale).action.kind).toBe("close");
  });
});
