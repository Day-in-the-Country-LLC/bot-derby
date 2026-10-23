import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { checkGeminiKey, GEMINI_BASE, GEMINI_MAX_OUTPUT_TOKENS, inputTokenBound, Jev, parseChoice, type JevOpts, type SystemOne } from "../src/jev.js";

const menu = { APE_PENGU: { desc: "ape", intent: { kind: "hold" as const } }, APE_BTC: { desc: "ape", intent: { kind: "hold" as const } } };
const ask = { strategy: "You are boozy.", state: { x: 1 }, menu, convictionLabels: ["tipsy", "buzzed", "wasted", "legendary"] };

function fake(result: unknown | (() => unknown), tokens = 500): SystemOne & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async systemOne(req) {
      calls.push(req);
      const r = typeof result === "function" ? (result as () => unknown)() : result;
      if (r instanceof Error) throw r;
      return { model: "jev-1.13.0", usage: { input_tokens: tokens, output_tokens: 0 }, answers: r } as never;
    },
  };
}

const answers = { action: { type: "choice", choice: "APE_PENGU", confidence: 0.62, probabilities: { APE_PENGU: 0.62, APE_BTC: 0.38 } }, conviction: { type: "score", score: 2.4, confidence: 0.5, legend: {}, probabilities: {} } };
const base = { apiKey: "k", model: "jev-1.13.0", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042 };

describe("Jev client", () => {
  it("returns choice, probabilities, rounded conviction and exact cost", async () => {
    const j = new Jev({ ...base, client: fake(answers, 500) });
    const r = await j.decide(ask);
    expect(r).toMatchObject({ ok: true, choice: "APE_PENGU", conviction: 2, inputTokens: 500 });
    expect(r.ok && r.costUsd).toBeCloseTo((500 * 0.042) / 1e6, 12);
    expect(j.spentTodayUsd).toBeCloseTo(0.000021, 12);
  });

  it("sends the menu as a choice question and the conviction rubric as a score", async () => {
    const f = fake(answers);
    await new Jev({ ...base, client: f }).decide(ask);
    const req = f.calls[0] as { model: string; questions: { action: { type: string; instructions: string; criteria: object }; conviction: { type: string; criteria: string[] } } };
    expect(req.model).toBe("jev-1.13.0");
    expect(req.questions.action.type).toBe("choice");
    expect(req.questions.action.instructions).toBe("You are boozy. Pick your next move.");
    expect(Object.keys(req.questions.action.criteria)).toEqual(["APE_PENGU", "APE_BTC"]);
    expect(req.questions.conviction.criteria).toEqual(["tipsy", "buzzed", "wasted", "legendary"]);
  });

  it("trips the daily cap, stops calling, and answers from code instead", async () => {
    const f = fake(answers, 1_000_000); // $0.042 per call
    const j = new Jev({ ...base, dailyUsdCap: 0.05, client: f });
    expect((await j.decide(ask)).ok).toBe(true);
    expect((await j.decide(ask)).ok).toBe(true);
    const third = await j.decide(ask);
    expect(third).toMatchObject({ ok: true, model: "code-fallback", costUsd: 0 });
    expect(f.calls.length).toBe(2);
  });

  it("the cap resets at 00:00 UTC", async () => {
    let now = Date.UTC(2026, 8, 24, 23, 59);
    const j = new Jev({ ...base, dailyUsdCap: 0.01, spentTodayUsd: 0.02, client: fake(answers), now: () => now });
    expect(j.capTripped).toBe(true);
    now = Date.UTC(2026, 8, 25, 0, 1);
    expect(j.capTripped).toBe(false);
  });

  it("falls back to code on errors and backs off on 429", async () => {
    let now = 1_000_000;
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const f = fake(() => err);
    const j = new Jev({ ...base, client: f, now: () => now });
    expect(await j.decide(ask)).toMatchObject({ ok: true, model: "code-fallback" });
    expect(j.downSince).toBe(1_000_000);
    expect(await j.decide(ask)).toMatchObject({ ok: true, model: "code-fallback" });
    expect(f.calls.length).toBe(1); // backing off: no second call
    now += 2_001;
    await j.decide(ask);
    expect(f.calls.length).toBe(2);
  });

  it("never passes an off-menu choice through: the code fallback answers from the menu", async () => {
    const bad = { ...answers, action: { ...answers.action, choice: "YOLO" } };
    const r = await new Jev({ ...base, client: fake(bad) }).decide(ask);
    expect(r).toMatchObject({ ok: true, model: "code-fallback" });
    expect(r.ok && Object.keys(menu)).toContain(r.ok ? r.choice : "");
  });

  it("says who decided: jev for a real answer, code with the reason otherwise", async () => {
    expect(await new Jev({ ...base, client: fake(answers) }).decide(ask)).toMatchObject({ source: "jev" });
    const bad = { ...answers, action: { ...answers.action, choice: "YOLO" } };
    const j = new Jev({ ...base, client: fake(bad) });
    expect(await j.decide(ask)).toMatchObject({ source: "code", fallbackReason: "off_menu" });
    expect(j.lastFallback).toMatchObject({ reason: "off_menu" });
    const t = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    expect(await new Jev({ ...base, client: fake(() => t) }).decide(ask)).toMatchObject({ source: "code", fallbackReason: "timeout" });
    expect(await new Jev({ ...base, client: fake(() => new Error("boom")) }).decide(ask)).toMatchObject({ source: "code", fallbackReason: "error" });
    expect(await new Jev({ ...base, spentTodayUsd: 5, client: fake(answers) }).decide(ask)).toMatchObject({ source: "code", fallbackReason: "cap" });
  });

  it("never calls with an empty menu", async () => {
    const f = fake(answers);
    expect(await new Jev({ ...base, client: f }).decide({ ...ask, menu: {} })).toMatchObject({ ok: false });
    expect(f.calls.length).toBe(0);
  });
});

// ---- The real chooser: Gemini 4 Argon over generateContent, with fetch injected (no network). ----

// The live key is a new-style 53-character "AQ." key; nothing may assume the old "AIza" prefix.
const KEY = "AQ.Xx0Fake-fake_fake-fake.fake-fake_fake-fake.fakeXYZ";
const flatMenu = {
  APE_SOL: { desc: "#1 long impulse", intent: { kind: "open" as const, instId: "SOL-USD_UM_XPERP-310404", side: "long" as const, sizeFrac: 0.5, setup: "strict" as const } },
  WAIT: { desc: "stay flat", intent: { kind: "hold" as const } },
};
const gAsk = { strategy: "You are boozy-bee.", state: { utc: "12:00", me: { pos: "flat" } }, menu: flatMenu, convictionLabels: ["tipsy", "buzzed", "wasted", "legendary"], key: "boozy" };

interface Sent {
  url: string;
  init: RequestInit;
}
function gemini(reply: unknown | (() => unknown), status = 200): { fetchFn: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const r = typeof reply === "function" ? (reply as () => unknown)() : reply;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}
const answer = (text: string, usage = { promptTokenCount: 600, candidatesTokenCount: 20, thoughtsTokenCount: 80 }) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: usage,
});
const gBase: JevOpts = { apiKey: KEY, model: "gemini-4-argon", timeoutMs: 3000, dailyUsdCap: 3, usdPerMTok: 4, usdPerMTokOut: 20, minIntervalMs: 60_000 };

describe("Gemini 4 Argon chooser", () => {
  it("POSTs generateContent for gemini-4-argon with the key in x-goog-api-key, never in the URL or the body", async () => {
    const g = gemini(answer('{"choice":"APE_SOL","confidence":0.7,"conviction":2}'));
    const r = await new Jev({ ...gBase, fetchFn: g.fetchFn }).decide(gAsk);
    expect(g.sent).toHaveLength(1);
    const { url, init } = g.sent[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body)) as { generationConfig: { maxOutputTokens: number; responseSchema: { properties: { choice: { enum: string[] } } } } };
    expect(body.generationConfig.responseSchema.properties.choice.enum).toEqual(["APE_SOL", "WAIT"]);
    expect(body.generationConfig.maxOutputTokens).toBe(GEMINI_MAX_OUTPUT_TOKENS);
    expect(r).toMatchObject({ ok: true, choice: "APE_SOL", conviction: 2, model: "gemini-4-argon", inputTokens: 600 });
  });

  it("prices input and output (thinking included) separately and books it against the cap", async () => {
    const g = gemini(answer('{"choice":"WAIT","confidence":0.6,"conviction":1}'));
    const j = new Jev({ ...gBase, fetchFn: g.fetchFn });
    const r = await j.decide(gAsk);
    const expected = (600 * 4 + (20 + 80) * 20) / 1e6;
    expect(r.ok && r.costUsd).toBeCloseTo(expected, 12);
    expect(j.spentTodayUsd).toBeCloseTo(expected, 12);
  });

  it("no key: code fallback, no network", async () => {
    const g = gemini(answer("{}"));
    const r = await new Jev({ ...gBase, apiKey: "", fetchFn: g.fetchFn }).decide(gAsk);
    expect(r).toMatchObject({ ok: true, model: "code-fallback", source: "code", fallbackReason: "no_key", choice: "APE_SOL", costUsd: 0 });
    expect(g.sent).toHaveLength(0);
  });

  it("cap hit, or a call whose worst case would cross the cap: code fallback, no network", async () => {
    const g = gemini(answer("{}"));
    expect(await new Jev({ ...gBase, spentTodayUsd: 3, fetchFn: g.fetchFn }).decide(gAsk)).toMatchObject({ model: "code-fallback", source: "code", fallbackReason: "cap" });
    // Near the cap (not tripped): the reservation refuses the call, and the answer and the chooser both say so.
    const near = new Jev({ ...gBase, spentTodayUsd: 2.999, fetchFn: g.fetchFn });
    expect(await near.decide(gAsk)).toMatchObject({ model: "code-fallback", source: "code", fallbackReason: "reservation" });
    expect([near.capTripped, near.downSince, near.budgetRefusedToday]).toEqual([false, null, true]);
    expect(near.lastFallback).toMatchObject({ reason: "reservation" });
    expect(g.sent).toHaveLength(0);
  });

  it("strict parsing: off-menu, fenced, non-JSON or wrong-typed answers fall back to code (and are still billed)", async () => {
    for (const text of ['{"choice":"YOLO","confidence":0.9,"conviction":3}', '```json\n{"choice":"APE_SOL"}\n```', "APE_SOL", '{"choice":["APE_SOL"]}', "null", ""]) {
      const g = gemini(answer(text));
      const r = await new Jev({ ...gBase, fetchFn: g.fetchFn }).decide(gAsk);
      expect(r).toMatchObject({ ok: true, model: "code-fallback", source: "code", fallbackReason: "off_menu" });
      expect(r.ok && r.costUsd).toBeGreaterThan(0);
    }
    expect(parseChoice('{"choice":"WAIT","confidence":7,"conviction":9}', ["WAIT"], 3)).toEqual({ choice: "WAIT", confidence: 1, conviction: 3 });
    expect(parseChoice('{"choice":"toString"}', ["WAIT"], 3)).toBeNull();
  });

  it("HTTP errors and timeouts fall back to code and back off, so a dead API is not hit every tick", async () => {
    let now = 5_000_000;
    const g = gemini({ error: { code: 503, message: "overloaded" } }, 503);
    const j = new Jev({ ...gBase, minIntervalMs: 0, fetchFn: g.fetchFn, now: () => now });
    expect(await j.decide(gAsk)).toMatchObject({ model: "code-fallback" });
    expect(j.downSince).toBe(5_000_000);
    await j.decide(gAsk);
    expect(g.sent).toHaveLength(1);
    now += 2_001;
    await j.decide(gAsk);
    expect(g.sent).toHaveLength(2);

    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const t = gemini(() => timeout);
    const jt = new Jev({ ...gBase, minIntervalMs: 0, fetchFn: t.fetchFn, now: () => now });
    expect(await jt.decide(gAsk)).toMatchObject({ model: "code-fallback" });
    await jt.decide(gAsk);
    expect(t.sent).toHaveLength(1);
  });

  it("aborts a slow call at timeoutMs", async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await new Jev({ ...gBase, timeoutMs: 50, fetchFn: slow }).decide(gAsk);
    expect(r).toMatchObject({ model: "code-fallback" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("paces paid calls per bee: inside the interval the bee holds, other bees are not affected", async () => {
    let now = 9_000_000;
    const g = gemini(answer('{"choice":"APE_SOL","confidence":0.7,"conviction":2}'));
    const j = new Jev({ ...gBase, fetchFn: g.fetchFn, now: () => now });
    await j.decide(gAsk);
    now += 2_000;
    const changed = { ...gAsk, state: { ...gAsk.state, me: { pos: "flat", flat_min: 1 } } };
    expect(await j.decide(changed)).toMatchObject({ ok: true, choice: "WAIT", model: "paced", costUsd: 0 });
    await j.decide({ ...changed, strategy: "You are bizzy-bee.", key: "bizzy" });
    expect(g.sent).toHaveLength(2);
    now += 60_000;
    await j.decide(changed);
    expect(g.sent).toHaveLength(3);
  });

  it("an identical state is answered from the cache at no cost", async () => {
    const g = gemini(answer('{"choice":"APE_SOL","confidence":0.7,"conviction":2}'));
    const j = new Jev({ ...gBase, minIntervalMs: 0, fetchFn: g.fetchFn });
    await j.decide(gAsk);
    const again = await j.decide({ ...gAsk, state: { ...gAsk.state, utc: "12:01" } });
    expect(again).toMatchObject({ ok: true, choice: "APE_SOL", costUsd: 0 });
    expect(g.sent).toHaveLength(1);
  });

  it("the prompt goes through the redactor", async () => {
    const g = gemini(answer('{"choice":"WAIT","confidence":0.6,"conviction":1}'));
    const leaky = { ...gAsk, strategy: "You are boozy-bee. api_key=sk-live-123456 from 192.0.2.12" };
    await new Jev({ ...gBase, fetchFn: g.fetchFn }).decide(leaky);
    const body = String(g.sent[0]!.init.body);
    expect(body).not.toContain("sk-live-123456");
    expect(body).not.toContain("192.0.2.12");
  });

  it("a single-option menu never calls", async () => {
    const g = gemini(answer("{}"));
    await new Jev({ ...gBase, fetchFn: g.fetchFn }).decide({ ...gAsk, menu: { WAIT: flatMenu.WAIT } });
    expect(g.sent).toHaveLength(0);
  });
});

// ---- The shared $3 budget is hard under concurrency, uncertainty and restarts. ----

describe("Gemini spend cap: reservations", () => {
  const slowAnswer = (usage: object) =>
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ usageMetadata: usage, candidates: [{ content: { parts: [{ text: '{"choice":"HOLD","confidence":1,"conviction":1}' }] } }] }));
    }) as unknown as typeof fetch;
  const holdAsk = { strategy: "test", state: {}, menu: { HOLD: { desc: "hold", intent: { kind: "hold" as const } }, WAIT: { desc: "wait", intent: { kind: "hold" as const } } }, convictionLabels: ["low", "high"] };

  it("three bees at once from $2.975 of $3 cannot cross the cap", async () => {
    let calls = 0;
    const inner = slowAnswer({ promptTokenCount: 100, candidatesTokenCount: 1024 });
    const fetchFn = (async (...a: Parameters<typeof fetch>) => (calls++, inner(...a))) as typeof fetch;
    const j = new Jev({ apiKey: "dummy", model: "dummy", timeoutMs: 8000, dailyUsdCap: 3, spentTodayUsd: 2.975, usdPerMTok: 4, usdPerMTokOut: 20, fetchFn });
    await Promise.all(["bizzy", "breezy", "boozy"].map((key) => j.decide({ ...holdAsk, key })));
    expect(calls).toBe(1);
    expect(j.spentTodayUsd).toBeLessThanOrEqual(3);
    expect(j.reservedUsd).toBe(0);
  });

  it("concurrent calls: settled spend plus in-flight worst cases never exceed the cap", async () => {
    let calls = 0;
    const inner = slowAnswer({ promptTokenCount: 50, candidatesTokenCount: 10 });
    const fetchFn = (async (...a: Parameters<typeof fetch>) => (calls++, inner(...a))) as typeof fetch;
    const j = new Jev({ ...gBase, dailyUsdCap: 0.1, minIntervalMs: 0, fetchFn });
    await Promise.all(Array.from({ length: 20 }, (_, i) => j.decide({ ...holdAsk, state: { i }, key: `b${i}` })));
    // Each reservation is ~$0.024 (1024 output tokens at $20/M plus the input bound): only 4 fit under $0.10 at once.
    expect(calls).toBe(4);
    expect(j.spentTodayUsd).toBeLessThan(0.1);
  });

  it("an uncertain response is charged as fully billed at the max output", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const t = gemini(() => timeout);
    const j = new Jev({ ...gBase, fetchFn: t.fetchFn });
    const r = await j.decide(gAsk);
    expect(r).toMatchObject({ model: "code-fallback" });
    const worst = j.spentTodayUsd;
    expect(worst).toBeGreaterThanOrEqual((GEMINI_MAX_OUTPUT_TOKENS * 20) / 1e6);
    expect(r.ok && r.costUsd).toBe(worst); // recorded on the decision row too

    for (const [body, status] of [[{ error: { code: 503 } }, 503], [{ candidates: [] }, 200]] as const) {
      const g = gemini(body, status);
      const j2 = new Jev({ ...gBase, fetchFn: g.fetchFn });
      await j2.decide(gAsk);
      expect(j2.spentTodayUsd).toBeCloseTo(worst, 12); // HTTP error, or a reply with no usage: same worst case
    }
  });

  it("the input bound is never below the real token count: one token per UTF-8 byte", () => {
    expect(inputTokenBound("abc")).toBeGreaterThanOrEqual(3);
    expect(inputTokenBound("é漢🐝")).toBeGreaterThanOrEqual(Buffer.byteLength("é漢🐝"));
  });

  it("restart: reservations are durable, so a call cut off mid-flight stays charged at its worst case", async () => {
    const db = new Db(":memory:");
    let release!: () => void;
    const hang = (async () => new Promise<Response>((r) => (release = () => r(new Response("{}", { status: 500 }))))) as unknown as typeof fetch;
    const j = new Jev({ ...gBase, fetchFn: hang, ledger: db });
    const pending = j.decide(gAsk);
    await new Promise((r) => setTimeout(r, 1));
    // The process dies here: nothing settled yet. A fresh engine restores today's spend from the ledger.
    const restored = db.chooserSpendSince(0);
    expect(restored).toBeGreaterThanOrEqual((GEMINI_MAX_OUTPUT_TOKENS * 20) / 1e6);
    const j2 = new Jev({ ...gBase, spentTodayUsd: Math.max(db.jevSpendSince(0), restored) });
    expect(j2.spentTodayUsd).toBe(restored);
    release();
    await pending;
    // Settled: a 500 has unknown billing, so it stays at the worst case.
    expect(db.chooserSpendSince(0)).toBeCloseTo(restored, 12);
  });

  it("settles a successful call to its billed amount in the ledger", async () => {
    const db = new Db(":memory:");
    const g = gemini(answer('{"choice":"WAIT","confidence":0.6,"conviction":1}'));
    await new Jev({ ...gBase, fetchFn: g.fetchFn, ledger: db }).decide(gAsk);
    expect(db.chooserSpendSince(0)).toBeCloseTo((600 * 4 + 100 * 20) / 1e6, 12);
  });
});

// ---- Jev's cap is a SOFT threshold: durable pre-call estimates, booked at what Jev reports. ----

describe("Jev spend cap: soft threshold", () => {
  const slow = (tokens: number | undefined): SystemOne & { calls: number } => {
    const f = {
      calls: 0,
      async systemOne() {
        f.calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { model: "jev-1.13.0", usage: tokens === undefined ? undefined : { input_tokens: tokens, output_tokens: 0 }, answers } as never;
      },
    };
    return f;
  };
  /** One call's pre-call estimate, read from the ledger (a reply with no usage is booked at the estimate). */
  async function estimate(): Promise<number> {
    const db = new Db(":memory:");
    await new Jev({ ...base, client: slow(undefined), ledger: db }).decide(ask);
    return db.chooserSpendSince(0);
  }

  it("concurrent bees: calls billed at their estimate cannot pass the cap together", async () => {
    const est = await estimate();
    const f = slow(undefined);
    const j = new Jev({ ...base, dailyUsdCap: 1 + 2.5 * est, spentTodayUsd: 1, client: f });
    await Promise.all(["bee1", "bee2", "bee3", "bee4", "bee5"].map((key) => j.decide({ ...ask, key })));
    expect(f.calls).toBe(2);
    expect(j.spentTodayUsd).toBeLessThanOrEqual(1 + 2.5 * est);
    expect(j.budgetRefusedToday).toBe(true);
    expect(j.reservedUsd).toBe(0);
  });

  it("documented overshoot: Jev bills more than the estimate, so a day can end over the cap, by the calls in flight only", async () => {
    // The gate's repro: $1.99 of $2, three bees at once, each reply billed 1M input tokens at $0.15/M.
    const f = slow(1_000_000);
    const j = new Jev({ ...base, dailyUsdCap: 2, usdPerMTok: 0.15, spentTodayUsd: 1.99, client: f });
    await Promise.all(["bee1", "bee2", "bee3"].map((key) => j.decide({ ...ask, key })));
    expect(f.calls).toBe(3);
    expect(j.spentTodayUsd).toBeCloseTo(2.44, 9); // over the cap: a soft threshold, as the README says
    // Once over, nothing more is sent today.
    expect(await j.decide({ ...ask, key: "bee1" })).toMatchObject({ source: "code", fallbackReason: "cap" });
    expect(f.calls).toBe(3);
  });

  it("restart: a Jev call in flight is in the durable ledger, and a failed call stays charged at its estimate", async () => {
    const db = new Db(":memory:");
    let fail!: () => void;
    const hang: SystemOne = { systemOne: () => new Promise((_res, rej) => (fail = () => rej(new Error("socket hang up")))) };
    const j = new Jev({ ...base, client: hang, ledger: db });
    const pending = j.decide(ask);
    await new Promise((r) => setTimeout(r, 1));
    const restored = db.chooserSpendSince(0);
    expect(restored).toBeGreaterThan(0);
    expect(new Jev({ ...base, client: fake(answers), spentTodayUsd: Math.max(db.jevSpendSince(0), restored) }).spentTodayUsd).toBe(restored);
    fail();
    expect(await pending).toMatchObject({ source: "code", fallbackReason: "error" });
    expect(db.chooserSpendSince(0)).toBeCloseTo(restored, 12);
  });

  it("a settled Jev call is booked in the ledger at what Jev reported", async () => {
    const db = new Db(":memory:");
    await new Jev({ ...base, client: fake(answers, 500), ledger: db }).decide(ask);
    expect(db.chooserSpendSince(0)).toBeCloseTo((500 * 0.042) / 1e6, 12);
  });
});

// ---- Public repo: two remote choosers and the key check Setup uses. ----

describe("chooser selection", () => {
  const ask = () => ({
    strategy: "s",
    state: { me: { upl_r: null } },
    menu: { WAIT: { desc: null, intent: { kind: "hold" as const } }, APE_SOL: { desc: null, intent: { kind: "open" as const, instId: "SOL-X", side: "long" as const, sizeFrac: 1, setup: "strict" as const } } },
    convictionLabels: ["a", "b", "c", "d"],
  });

  it("no key: answers from code and never touches the network", async () => {
    let fetched = 0;
    const j = new Jev({ provider: "code", apiKey: "", model: "gemini-4-argon", timeoutMs: 100, dailyUsdCap: 3, usdPerMTok: 4, fetchFn: (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch });
    const r = await j.decide(ask());
    expect(r).toMatchObject({ ok: true, model: "code-fallback", costUsd: 0 });
    expect(fetched).toBe(0);
  });

  it("a Jev key never goes to Google: the Jev path uses its own client, not fetch", async () => {
    let fetched = 0;
    let asked = 0;
    const client: SystemOne = {
      async systemOne() {
        asked++;
        return { model: "jev-1.13.0", usage: { input_tokens: 1000, output_tokens: 0 }, answers: { action: { type: "choice", choice: "APE_SOL", confidence: 0.9, probabilities: { APE_SOL: 0.9 } }, conviction: { type: "score", score: 2, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const j = new Jev({ provider: "jev", apiKey: "jev-key", model: "jev-1.13.0", timeoutMs: 100, dailyUsdCap: 2, usdPerMTok: 0.042, client, fetchFn: (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch });
    const r = await j.decide(ask());
    expect(r).toMatchObject({ ok: true, choice: "APE_SOL", model: "jev-1.13.0" });
    expect(r.ok && r.costUsd).toBeCloseTo(0.000042, 9);
    expect([asked, fetched]).toEqual([1, 0]);
  });

  it("a real Jev client is built only for the Jev provider with a key", () => {
    const has = (o: ConstructorParameters<typeof Jev>[0]) => (new Jev(o) as unknown as { client?: unknown }).client !== undefined;
    const base = { model: "m", timeoutMs: 100, dailyUsdCap: 1, usdPerMTok: 1 };
    expect(has({ ...base, provider: "jev", apiKey: "k" })).toBe(true);
    expect(has({ ...base, provider: "jev", apiKey: "" })).toBe(false);
    expect(has({ ...base, provider: "gemini", apiKey: "k" })).toBe(false);
  });
});

describe("checkGeminiKey (Setup)", () => {
  const reply = (status: number) => (async (url: string, init: RequestInit) => {
    expect(url).toBe(`${GEMINI_BASE}/gemini-4-argon`);
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-123456789");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;

  it("accepts a key that can see the model, with the key in the header only", async () => {
    expect(await checkGeminiKey("k-123456789", "gemini-4-argon", 1000, reply(200))).toBeNull();
  });

  it("says why when it cannot", async () => {
    expect(await checkGeminiKey("k-123456789", "gemini-4-argon", 1000, reply(400))).toMatch(/rejected/);
    expect(await checkGeminiKey("k-123456789", "gemini-4-argon", 1000, reply(404))).toMatch(/paid-tier/);
    expect(await checkGeminiKey("k-123456789", "gemini-4-argon", 1000, reply(503))).toMatch(/HTTP 503/);
    const boom = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await checkGeminiKey("k-123456789", "gemini-4-argon", 1000, boom)).toMatch(/Could not reach/);
  });
});
