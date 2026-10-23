import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Db } from "../src/db.js";
import { derbyConfig } from "../src/derby/config.js";
import { DerbyDecisions, requestBody, ROSTER } from "../src/derby/decisions.js";
import { derbyServer } from "../src/derby/server.js";
import type { JevAsk } from "../src/jev.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Alerts } from "../src/alerts.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, trend, view, NOW } from "./fixtures.js";

const ask: JevAsk = { key: "bee1", state: { market: "same" }, strategy: "Follow the trend", convictionLabels: ["weak", "fair", "strong", "overwhelming"], menu: { WAIT: { desc: "Keep position", intent: { kind: "hold" } }, OPEN: { desc: "Open long", intent: { kind: "open", instId: "BTC", side: "long", sizeFrac: .5, setup: "strict" } } } };
const resources: Db[] = [];
const database = () => { const db = new Db(":memory:"); resources.push(db); return db; };
afterEach(() => resources.splice(0).forEach(db => db.close()));
const config = () => derbyConfig({ TYPESAFE_API_KEY: "test-jev-secret", OPENAI_API_KEY: "test-openai-secret", COMPETITION_ENABLED: "true", BOT_DAILY_USD_CAP: "0.25" });
function answer(provider: string, labels = ["WAIT", "OPEN"], selected = labels[0]!) {
  const probs = Object.fromEntries(labels.map(l => [l, l === selected ? 1 : 0]));
  const action = { type: "choice", choice: selected, confidence: 1, probabilities: provider === "jev" ? probs : labels.map(value => ({ value, probability: probs[value] })) };
  const conviction = { type: "score", score: 2 };
  return { model: provider, usage: { input_tokens: 500 }, answers: provider === "jev" ? { action, conviction } : [{ name: "action", ...action }, { name: "conviction", ...conviction }] };
}

describe("Bot Derby decision providers", () => {
  it("sends identical evidence and question meaning to the two dedicated APIs and isolates credentials", async () => {
    const { providers } = config();
    const calls: Array<{ url: string; body: any; authorization: string }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const isJev = url.includes('typesafe');
      calls.push({ url, body, authorization: (init.headers as Record<string, string>).authorization! });
      return Response.json(answer(isJev ? 'jev' : 'openai'));
    }) as typeof fetch;
    const client = new DerbyDecisions(providers, database(), fake, () => NOW);
    const [a, b] = await Promise.all([client.decide(ask), client.decide({ ...ask, key: "bee2" })]);
    expect(a).toMatchObject({ ok: true, source: "jev", choice: "WAIT", conviction: 2 });
    expect(b).toMatchObject({ ok: true, source: "openai", choice: "WAIT", conviction: 2 });
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/decisions");
    expect(calls[0]!.authorization).toBe("Bearer test-jev-secret");
    expect(calls[1]!.authorization).toBe("Bearer test-openai-secret");
    expect(calls[0]!.body.state).toBe(calls[1]!.body.input);
    expect(calls[1]!.body.questions[1].levels).toEqual(ask.convictionLabels.map(label => ({ label, description: label })));
    expect(calls[0]!.body.questions.conviction.criteria).toEqual(calls[1]!.body.questions[1].levels.map((v: { description: string }) => v.description));
    expect(calls[0]!.body.questions.action.instructions).toBe(calls[1]!.body.questions[0].instructions);
    expect(JSON.stringify(calls.map(c => c.body))).not.toContain('secret');
    expect(client.status("bee1").totalCostUsd).toBeCloseTo(500 * .042 / 1e6);
    expect(client.status("bee2").totalCostUsd).toBeCloseTo(500 * .1 / 1e6);
  });
  it.each(["refusal", "off_menu", "bad_probability", "timeout", "http_error"])("holds on %s, books cost and never falls back", async kind => {
    const { providers } = config();
    const fake = (async () => {
      if (kind === "timeout") throw new Error('test-openai-secret should never escape');
      if (kind === "http_error") return new Response('test-openai-secret', { status: 429 });
      const data = answer('openai') as any;
      if (kind === "refusal") data.answers[0] = { name: 'action', type: 'refusal' };
      if (kind === "off_menu") data.answers[0].choice = 'BUY_EVERYTHING';
      if (kind === "bad_probability") data.answers[0].probabilities[0].probability = -5;
      return Response.json(data);
    }) as typeof fetch;
    const client = new DerbyDecisions(providers, database(), fake, () => NOW);
    const result = await client.decide({ ...ask, key: 'bee2' });
    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(client.status('bee2').totalCostUsd).toBeGreaterThan(0);
    expect(await client.decide({ ...ask, key: 'bee2' })).toMatchObject({ ok: false, reason: 'backoff' });
  });
  it("keeps budgets independent, restores reservations after restart, and resets on UTC day boundary", async () => {
    const { providers } = config();
    const db = database();
    db.reserveChooserSpend(NOW, "bee1", 1);
    let now = NOW, calls = 0;
    const fake = (async (url: string) => { calls++; return Response.json(answer(url.includes('typesafe') ? 'jev' : 'openai')); }) as typeof fetch;
    const client = new DerbyDecisions(providers, db, fake, () => now);
    expect(await client.decide(ask)).toMatchObject({ ok: false, reason: 'daily_cap' });
    expect((await client.decide({ ...ask, key: 'bee2' })).ok).toBe(true);
    expect(calls).toBe(1);
    const restarted = new DerbyDecisions(providers, db, fake, () => now);
    expect(await restarted.decide(ask)).toMatchObject({ ok: false, reason: 'daily_cap' });
    now += 86400000;
    expect((await restarted.decide(ask)).ok).toBe(true);
  });
  it("never sends requests when a key is absent or budget is zero", async () => {
    const { providers } = config(); providers.bee1.apiKey = ''; providers.bee2.dailyUsdCap = 0;
    let calls = 0;
    const client = new DerbyDecisions(providers, database(), (async () => { calls++; return Response.json({}); }) as typeof fetch, () => NOW);
    expect((await client.decide(ask)).ok).toBe(false);
    expect(await client.decide({ ...ask, key: 'bee2' })).toMatchObject({ ok: false, reason: 'daily_cap' });
    expect(calls).toBe(0);
  });
  it("asks both APIs for conviction when only one action is legal, without inventing a second choice", async () => {
    const { providers } = config();
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const jev = url.includes('typesafe');
      if (jev) expect(Object.keys(body.questions)).toEqual(['conviction']);
      else expect(body.questions.map((q: any) => q.name)).toEqual(['conviction']);
      const score = { type: 'score', score: 2 };
      return Response.json({ usage: { input_tokens: 100 }, answers: jev ? { conviction: score } : [{ name: 'conviction', ...score }] });
    }) as typeof fetch;
    const client = new DerbyDecisions(providers, database(), fake, () => NOW);
    for (const id of ROSTER) expect(await client.decide({ ...ask, key: id, menu: { WAIT: ask.menu.WAIT! } })).toMatchObject({ ok: true, choice: 'WAIT', conviction: 2, source: providers[id].provider });
  });
  it("keeps calling both providers without a spending cutoff while recording costs", async () => {
    const { providers, cfg } = derbyConfig({ TYPESAFE_API_KEY: 'test-jev-secret', OPENAI_API_KEY: 'test-openai-secret', BOT_DAILY_USD_CAP: 'unlimited' });
    expect(cfg.tickMs).toBe(10_000);
    const db = database();
    for (const id of ROSTER) db.reserveChooserSpend(NOW, id, 50);
    const client = new DerbyDecisions(providers, db, (async (url: string) => Response.json(answer(url.includes('typesafe') ? 'jev' : 'openai'))) as typeof fetch, () => NOW);
    for (const id of ROSTER) {
      expect((await client.decide({ ...ask, key: id })).ok).toBe(true);
      expect((await client.decide({ ...ask, key: id })).ok).toBe(true);
      expect(client.status(id)).toMatchObject({ dailyCapUsd: null, budgetPaused: false, attemptedCalls: 3 });
      expect(client.status(id).totalCostUsd).toBeGreaterThan(50);
    }
    expect(client.capTripped).toBe(false);
    expect(client.budgetRefusedToday).toBe(false);
  });
  it("rejects live trading and unsafe configuration", () => {
    expect(() => derbyConfig({ MODE: 'live' })).toThrow('paper');
    expect(() => derbyConfig({ DRY_RUN: 'false' })).toThrow('paper');
    expect(() => derbyConfig({ BOT_DAILY_USD_CAP: '-1' })).toThrow();
    expect(() => derbyConfig({ TICK_MS: 'NaN' })).toThrow();
    expect(derbyConfig({ GEMINI_API_KEY: 'unrelated' }).providers.bee1.provider).toBe('jev');
    expect(derbyConfig({}).enabled).toBe(false);
  });
});

describe("the competition engine", () => {
  it("runs exactly Ferdi and Bodi, records the correct provider and survives a restart with portfolios intact", async () => {
    const { cfg, providers } = config();
    const db = database();
    const v = view([coin('BTC', { trend: trend({ score: 6, longOn: 6, rv90Pct: 40 }) }), coin('ETH', { trend: trend({ score: 0 }) })]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const jev = url.includes('typesafe');
      const labels: string[] = jev ? Object.keys(body.questions.action?.criteria ?? { HOLD: '' }) : (body.questions.find((q: any) => q.name === 'action')?.choices ?? [{ value: 'HOLD' }]).map((c: any) => c.value);
      const open = labels.find(l => l.includes('LONG')) || labels[0]!;
      return Response.json(answer(jev ? 'jev' : 'openai', labels, open));
    }) as typeof fetch;
    const decisions = new DerbyDecisions(providers, db, fake, () => NOW);
    const deps = { cfg, db, feed, jev: decisions, activeBees: ROSTER, askEveryCycle: true, chooserLabel: (id: string) => id === 'bee1' ? 'Jev' : 'OpenAI Decisions', exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW };
    const engine = new Engine(deps);
    await engine.start(); engine.stop();
    await engine.tick();
    expect(Object.keys(engine.bees)).toEqual(['bee1', 'bee2']);
    expect(engine.snapshot().bees).toHaveLength(2);
    const rows = db.raw.prepare('SELECT bee, decided_by FROM decisions').all();
    expect(rows).toEqual(expect.arrayContaining([{ bee: 'bee1', decided_by: 'jev' }, { bee: 'bee2', decided_by: 'openai' }]));
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE bee='bee3'").get()).toEqual({ n: 0 });
    // Continue paying for real provider answers even on a forced hold or a trading cap.
    expect(engine.bees.bee1.position).not.toBeNull();
    await engine.tick();
    for (const id of ROSTER) expect(decisions.status(id).successfulCalls).toBe(2);
    const orders = engine.bees.bee1.totals.orders;
    engine.bees.bee1.cap = 'trade_cap';
    engine.bees.bee2.cap = 'fee_budget';
    await engine.tick();
    for (const id of ROSTER) expect(decisions.status(id).successfulCalls).toBe(3);
    expect(engine.bees.bee1.cap).toBe('trade_cap');
    expect(engine.bees.bee2.cap).toBe('fee_budget');
    expect(engine.bees.bee1.totals.orders).toBe(orders);
    const prior = JSON.parse(JSON.stringify(engine.bees));
    const restarted = new Engine(deps); await restarted.start(); restarted.stop();
    expect(restarted.bees).toEqual(prior);
  });
});

describe("public website", () => {
  it("serves scoreboard and assets, blocks writes and does not expose files or owner routes", async () => {
    const db = database();
    const server = derbyServer({ db, webDir: './derby-web', snapshot: () => ({ state: 'paused', bots: [{ name: 'Ferdi' }, { name: 'Bodi' }] }) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/api/scoreboard`)).json()).toMatchObject({ state: 'paused' });
      const page = await fetch(base); expect(await page.text()).toContain('Bot Derby');
      expect(page.headers.get('content-security-policy')).toContain("form-action 'none'");
      for (const path of ['/.env', '/data/bot-derby.sqlite', '/setup/status', '/lab/overlay', '/hive/join', '/keeper/connect']) expect((await fetch(`${base}${path}`)).status).toBe(404);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await fetch(`${base}/api/scoreboard`, { method })).status).toBe(405);
      expect(await (await fetch(`${base}/api/equity`)).json()).toEqual({});
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
