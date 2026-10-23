import { z } from "zod";
import type { BeeId } from "../config.js";
import type { Db } from "../db.js";
import type { JevAsk, JevResult } from "../jev.js";

export const ROSTER = ["bee1", "bee2"] as const;
export type DerbyId = (typeof ROSTER)[number];
export type Provider = "jev" | "openai";
export interface ProviderConfig {
  provider: Provider;
  name: string;
  apiKey: string;
  model: string;
  dailyUsdCap: number | null;
  usdPerMTok: number;
  timeoutMs: number;
}
const probability = z.number().finite().min(0).max(1);
const choiceSchema = z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability });
const scoreSchema = z.object({ type: z.literal("score"), score: z.number().finite().min(0).max(3) });
const dayStart = (now: number) => Math.floor(now / 86_400_000) * 86_400_000;

/** Identical evidence, question wording, options and score rubric; only the wire protocol differs. */
export function requestBody(p: ProviderConfig, ask: JevAsk) {
  const instructions = `${ask.strategy} Pick your next move.`;
  const onlyMove = Object.keys(ask.menu).length === 1 ? Object.keys(ask.menu)[0] : null;
  // OpenAI choice questions require multiple options. For a forced hold, both APIs
  // assess conviction only; the engine still owns the one legal action.
  const scoreInstructions = onlyMove ? `${ask.strategy} The only legal action is ${onlyMove}. Assess signal strength for this required action.` : "Signal strength?";
  // A string of the same JSON is accepted by both APIs, avoiding provider-specific input formatting.
  const evidence = JSON.stringify(ask.state);
  if (p.provider === "jev") return {
    model: p.model, state: evidence,
    questions: {
      ...(onlyMove ? {} : { action: { type: "choice", instructions, criteria: Object.fromEntries(Object.entries(ask.menu).map(([k, v]) => [k, v.desc ?? k])) } }),
      conviction: { type: "score", instructions: scoreInstructions, criteria: ask.convictionLabels },
    },
  };
  return {
    model: p.model, input: evidence,
    questions: [
      ...(onlyMove ? [] : [{ type: "choice", name: "action", instructions, choices: Object.entries(ask.menu).map(([value, v]) => ({ value, description: v.desc ?? value })) }]),
      { type: "score", name: "conviction", instructions: scoreInstructions, levels: ask.convictionLabels.map(label => ({ label, description: label })) },
    ],
  };
}

function parseAnswer(provider: Provider, value: unknown, labels: string[]) {
  const data = z.object({ model: z.string().optional(), answers: z.unknown(), usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional() }).parse(value);
  const answers = provider === "jev" ? z.record(z.unknown()).parse(data.answers) : Object.fromEntries(
    z.array(z.object({ name: z.string() }).passthrough()).parse(data.answers).map(a => [a.name, a]),
  );
  const a = labels.length === 1 ? { type: "choice" as const, choice: labels[0]!, confidence: 1 } : choiceSchema.parse(answers.action);
  const c = scoreSchema.parse(answers.conviction);
  const raw = (answers.action as Record<string, unknown> | undefined)?.probabilities;
  const probabilities = labels.length === 1 ? { [labels[0]!]: 1 } : provider === "jev" ? z.record(probability).parse(raw) : Object.fromEntries(
    z.array(z.object({ value: z.string(), probability })).parse(raw).map(p => [p.value, p.probability]),
  );
  if (!labels.includes(a.choice) || Object.keys(probabilities).length !== labels.length || labels.some(l => !(l in probabilities))) throw new Error("invalid choices");
  if (Math.abs(Object.values(probabilities).reduce((s, p) => s + p, 0) - 1) > 0.02) throw new Error("invalid probability distribution");
  return { ...a, convictionRaw: c.score, conviction: Math.round(c.score), probabilities, inputTokens: data.usage?.input_tokens, model: data.model };
}

/** No generative API and no fallback trader. Unknown billing stays reserved across restarts. */
export class DerbyDecisions {
  private errors: Partial<Record<DerbyId, { at: number; code: string }>> = {};
  private backoff: Partial<Record<DerbyId, number>> = {};
  private refused: Partial<Record<DerbyId, number>> = {};
  private inFlight = new Set<DerbyId>();
  constructor(readonly providers: Record<DerbyId, ProviderConfig>, private db: Db, private fetchFn: typeof fetch = fetch, private now = Date.now) {}

  private spent(id: DerbyId, since: number): number {
    return (this.db.raw.prepare("SELECT COALESCE(SUM(charged_usd),0) AS total FROM chooser_spend WHERE bee=? AND ts>=?").get(id, since) as { total: number }).total;
  }
  get spentTodayUsd() { return ROSTER.reduce((n, id) => n + this.spent(id, dayStart(this.now())), 0); }
  get capTripped() { return ROSTER.some(id => { const cap = this.providers[id].dailyUsdCap; return cap !== null && this.spent(id, dayStart(this.now())) >= cap; }); }
  get budgetRefusedToday() { return Object.values(this.refused).some(at => at >= dayStart(this.now())); }
  get downSince() { return Math.min(...Object.values(this.errors).map(e => e.at)) === Infinity ? null : Math.min(...Object.values(this.errors).map(e => e.at)); }
  get lastFallback() { return null; }

  status(id: DerbyId) {
    const p = this.providers[id];
    const stats = this.db.raw.prepare("SELECT COUNT(*) AS calls, AVG(latency_ms) AS latencyMs FROM decisions WHERE bee=? AND decided_by=?").get(id, p.provider) as { calls: number; latencyMs: number | null };
    return {
      provider: p.provider, model: p.model, ready: !!p.apiKey, dailyCapUsd: p.dailyUsdCap,
      spentTodayUsd: this.spent(id, dayStart(this.now())), totalCostUsd: this.spent(id, 0),
      budgetPaused: p.dailyUsdCap !== null && (this.spent(id, dayStart(this.now())) >= p.dailyUsdCap || (this.refused[id] ?? 0) >= dayStart(this.now())),
      lastError: this.errors[id] ?? null, successfulCalls: stats.calls, meanLatencyMs: stats.latencyMs,
      attemptedCalls: (this.db.raw.prepare("SELECT COUNT(*) AS n FROM chooser_spend WHERE bee=?").get(id) as { n: number }).n,
    };
  }

  async decide(ask: JevAsk): Promise<JevResult> {
    const id = ask.key as DerbyId;
    if (!ROSTER.includes(id)) return { ok: false, reason: "error", latencyMs: 0, error: { code: "UNKNOWN_BOT", message: "Unknown competitor" } };
    const p = this.providers[id];
    const started = this.now();
    const failure = (code: string, costUsd = 0): JevResult => {
      this.errors[id] = { at: started, code };
      this.backoff[id] = started + 30_000;
      return { ok: false, reason: "error", latencyMs: this.now() - started, costUsd, error: { code, message: `${p.name} decision unavailable; holding` } };
    };
    if (!p.apiKey) return failure("MISSING_KEY");
    if (this.inFlight.has(id) || started < (this.backoff[id] ?? 0)) return { ok: false, reason: "backoff", latencyMs: 0 };
    const labels = Object.keys(ask.menu);
    if (!labels.length) return failure("EMPTY_MENU");
    const body = JSON.stringify(requestBody(p, ask));
    // Conservative estimate, not a billing guarantee: provider framing can differ. Count all input at the full rate.
    const reservedTokens = Buffer.byteLength(body, "utf8") + 1024;
    const reservedUsd = reservedTokens * p.usdPerMTok / 1e6;
    if (p.dailyUsdCap !== null && this.spent(id, dayStart(started)) + reservedUsd > p.dailyUsdCap) {
      this.refused[id] = started;
      return { ok: false, reason: "daily_cap", latencyMs: 0 };
    }
    const reservation = this.db.reserveChooserSpend(started, id, reservedUsd);
    this.inFlight.add(id);
    let chargedUsd = reservedUsd;
    try {
      const response = await this.fetchFn(p.provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.openai.com/v1/decisions", {
        method: "POST", headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
        body, signal: AbortSignal.timeout(p.timeoutMs),
      });
      if (!response.ok) return failure(`HTTP_${response.status}`, chargedUsd);
      const raw: unknown = await response.json();
      // Valid usage may be available even for a refusal/invalid answer; never log the remote body.
      const usage = z.object({ usage: z.object({ input_tokens: z.number().int().nonnegative() }) }).safeParse(raw);
      if (usage.success) chargedUsd = usage.data.usage.input_tokens * p.usdPerMTok / 1e6;
      const answer = parseAnswer(p.provider, raw, labels);
      delete this.errors[id];
      delete this.backoff[id];
      return { ok: true, source: p.provider, ...answer, inputTokens: answer.inputTokens ?? reservedTokens, model: answer.model ?? p.model, latencyMs: this.now() - started, costUsd: chargedUsd };
    } catch {
      return failure("INVALID_OR_UNAVAILABLE_RESPONSE", chargedUsd);
    } finally {
      this.inFlight.delete(id);
      this.db.settleChooserSpend(reservation, chargedUsd);
    }
  }
}
