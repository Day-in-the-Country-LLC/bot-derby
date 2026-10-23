// Who made each call is recorded, streamed and shown: a code-fallback answer is never presented as the model's.
// Engine end to end on paper with a fake Gemini endpoint (no network): the decision row, the SSE event and the snapshot.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus, type BeeEvent } from "../src/events.js";
import type { Executor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

const KEY = "AQ.Xx0Fake-fake_fake-fake.fake-fake_fake-fake.fakeXYZ";

/** A fake generateContent: picks the menu's first label (or `pick`'s answer), counts calls. */
function geminiFake(pick?: (labels: string[]) => string) {
  const state = { calls: 0 };
  const fetchFn = (async (_url: string, init: RequestInit) => {
    state.calls++;
    const body = JSON.parse(String(init.body)) as { generationConfig: { responseSchema: { properties: { choice: { enum: string[] } } } } };
    const labels = body.generationConfig.responseSchema.properties.choice.enum;
    const choice = pick ? pick(labels) : labels[0]!;
    const text = JSON.stringify({ choice, confidence: 0.7, conviction: 2 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, thoughtsTokenCount: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

async function run(opts: { spentTodayUsd?: number; pick?: (labels: string[]) => string }) {
  const cfg = testConfig({ DRY_RUN: "true", GEMINI_API_KEY: KEY });
  const v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }), coin("SUI", { ret24hPct: 12, ret7dPct: 40 })]);
  const now = NOW;
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, get lastRefreshAt() { return now; } } as unknown as MarketFeed;
  const exec: Executor = {
    kind: "sim",
    async init() {},
    async market() {
      return { ok: false, state: "unknown", error: { code: "51008", message: "insufficient margin" } } as never;
    },
    async positions() { return []; },
    async fundingBills() { return []; },
    async feesFor() { return new Map(); },
  };
  const g = geminiFake(opts.pick);
  const db = new Db(":memory:");
  const bus = new EventBus(db);
  const events: BeeEvent[] = [];
  bus.subscribe((_l, ev) => events.push(ev));
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: opts.spentTodayUsd ?? 0, fetchFn: g.fetchFn, ledger: db, now: () => now });
  const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: { send: () => {} } as unknown as Alerts, now: () => now });
  await engine.start();
  engine.stop();
  for (const id of ["bee1", "bee2"] as const) engine.bees[id].cap = "trade_cap"; // only the Momentum bee asks
  engine.bees.bee3.flatSince = now - 60 * 60_000;
  await engine.tick();
  const row = db.raw.prepare(`SELECT choice, decided_by, fallback_reason, confidence FROM decisions WHERE bee = 'bee3' ORDER BY id DESC LIMIT 1`).get() as { choice: string; decided_by: string | null; fallback_reason: string | null };
  const ev = events.filter((e) => e.type === "decision" && e.bee === "bee3").at(-1)!;
  const snap = engine.snapshot();
  return { row, ev, snap, calls: g.state.calls, last: snap.bees.find((b) => b.bee === "bee3")!.last };
}

describe("decision attribution", () => {
  it("a healthy Gemini answer is recorded, streamed and shown as Gemini's", async () => {
    const r = await run({});
    expect(r.calls).toBe(1);
    expect(r.row).toMatchObject({ decided_by: "gemini", fallback_reason: null });
    expect(r.ev).toMatchObject({ decidedBy: "gemini", fallbackReason: null });
    expect(r.last).toMatchObject({ decidedBy: "gemini" });
    expect(r.snap.jev).toMatchObject({ provider: "gemini", budgetRefused: false, lastFallback: null });
  });

  it("near the cap: the reservation refuses the call before any network, and the code answer says so everywhere", async () => {
    // $2.999 of $3 settled: the cap has NOT tripped, but this call's worst case does not fit.
    const r = await run({ spentTodayUsd: 2.999 });
    expect(r.calls).toBe(0);
    expect(r.row).toMatchObject({ decided_by: "code", fallback_reason: "reservation" });
    expect(r.ev).toMatchObject({ decidedBy: "code", fallbackReason: "reservation" });
    expect(r.last).toMatchObject({ decidedBy: "code", fallbackReason: "reservation" });
    expect(r.snap.jev).toMatchObject({ capTripped: false, down: false, budgetRefused: true, lastFallback: { reason: "reservation" } });
  });

  it("an off-menu answer is billed, and the move is recorded as the code chooser's (off_menu)", async () => {
    const r = await run({ pick: () => "YOLO" });
    expect(r.calls).toBe(1);
    expect(r.row).toMatchObject({ decided_by: "code", fallback_reason: "off_menu" });
    expect(r.ev).toMatchObject({ decidedBy: "code", fallbackReason: "off_menu" });
    expect(r.snap.jev).toMatchObject({ down: false, lastFallback: { reason: "off_menu" } });
    expect(r.snap.jev.spentTodayUsd).toBeGreaterThan(0);
  });

  it("an older database gains the two columns on open, and keeps its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bees-attr-")), "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE decisions (id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL, state_hash TEXT, state_json TEXT, menu_json TEXT,
      choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL, latency_ms INTEGER, input_tokens INTEGER,
      jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT, action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT);
      INSERT INTO decisions (bee, ts, action_json) VALUES ('bee1', 1, '{}');`);
    old.close();
    const db = new Db(path);
    const cols = (db.raw.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["decided_by", "fallback_reason"]));
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM decisions`).get()).toEqual({ n: 1 });
    db.close();
    new Db(path).close(); // opening again is a no-op
  });
});
