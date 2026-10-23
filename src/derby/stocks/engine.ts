import { createHash } from "node:crypto";
import type { Menu } from "../../bees/types.js";
import type { BeeId } from "../../config.js";
import type { Db } from "../../db.js";
import type { JevAsk, JevResult } from "../../jev.js";
import type { DerbyDecisions, DerbyId } from "../decisions.js";
import { newYorkTradingDate } from "./signals.js";
import type { StockFeedLike, StockMarket, StockQuote, StockRules, StockSession } from "./types.js";

const IDS = ["bee1", "bee2"] as const;
const STATE_KEY = "stock_engine_v1";
type Attribution = "ai_choice" | "rules_required" | "protective_exit" | "api_unavailable";
type Cap = "trade_cap" | "loss_stop" | "retired" | "data_issue" | null;
type Action = { kind: "hold" } | { kind: "open"; symbol: string } | { kind: "close" } | { kind: "trim" };
interface Position { symbol: string; shares: number; entry: number; mark: number; stop: number; lastSession: string; }
interface Last { at: number; attribution: Attribution; status: string; decidedBy: string | null; }
interface Account {
  id: string; name: string; cash: number; equity: number; peak: number; drawdown: number;
  position: Position | null; basket: Position[]; session: string; dayStart: number;
  entries: number; lastEntryAt: number | null; cap: Cap; dataIssue: string | null;
  startedAt: number | null;
  totals: { orders: number; completedTrades: number; feesUsd: number; realisedUsd: number; decisions: number };
  metrics: { meaningfulChoices: number; holdAssessments: number; protectiveExits: number };
  last: Last;
}
interface DurableState {
  version: 1; rulesHash: string; startedAt: number | null;
  accounts: Record<DerbyId, Account>; benchmarks: { cash: Account; buy_hold: Account; rules: Account };
}
interface Prepared { ask: JevAsk; actions: Record<string, Action>; protected: boolean; }
interface Activity { ts: number; botId: string; bot: string; attribution: Attribution; status: string; decidedBy: string | null; action: string; }
export interface StockEngineOptions {
  db: Db; feed: StockFeedLike; decisions: Pick<DerbyDecisions, "decide" | "status">; rules: StockRules; now?: () => number;
}

/** A deliberately separate, cash-backed stock simulator. Private marks/shares never enter public views. */
export class StockEngine {
  private state: DurableState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private market: StockMarket | null = null;
  private readonly now: () => number;
  private readonly rules: StockRules;

  constructor(private readonly d: StockEngineOptions) {
    this.now = d.now ?? Date.now;
    this.rules = d.rules;
    const rulesHash = createHash("sha256").update(JSON.stringify(this.rules)).digest("hex");
    const saved = d.db.getMeta(STATE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as DurableState;
      if (parsed.version !== 1 || parsed.rulesHash !== rulesHash || !parsed.accounts?.bee1 || !parsed.accounts?.bee2) {
        throw new Error("Stock season state does not match these rules; preserve it and start a new season database");
      }
      this.state = parsed;
    } else {
      this.state = {
        version: 1, rulesHash, startedAt: null,
        accounts: { bee1: this.fresh("bee1", "Ferdi"), bee2: this.fresh("bee2", "Bodi") },
        benchmarks: { cash: this.fresh("cash", "Cash"), buy_hold: this.fresh("buy_hold", "Equal-weight buy and hold"), rules: this.fresh("rules", "Rules only") },
      };
      this.persist();
    }
  }

  private fresh(id: string, name: string): Account {
    const n = this.rules.startEquityUsd;
    return { id, name, cash: n, equity: n, peak: n, drawdown: 0, position: null, basket: [], session: "", dayStart: n,
      entries: 0, lastEntryAt: null, cap: null, dataIssue: null, startedAt: null,
      totals: { orders: 0, completedTrades: 0, feesUsd: 0, realisedUsd: 0, decisions: 0 },
      metrics: { meaningfulChoices: 0, holdAssessments: 0, protectiveExits: 0 },
      last: { at: this.now(), attribution: "rules_required", status: "Waiting for the first fresh regular market session", decidedBy: "rules" } };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.tick();
    if (!this.stopped) this.timer = setInterval(() => { void this.tick().catch(() => { /* fail closed; health exposes stale market */ }); }, this.rules.tickMs);
  }

  /** Drain any paid calls before the caller closes SQLite; a stopped engine never fills their late answers. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
    this.persist();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runTick().finally(() => { this.pending = null; });
    return this.pending;
  }

  private allAccounts(): Account[] { return [...IDS.map(id => this.state.accounts[id]), ...Object.values(this.state.benchmarks)]; }
  private persist(): void { this.d.db.setMeta(STATE_KEY, JSON.stringify(this.state)); }
  private atomic(work: () => void): void {
    const before = JSON.stringify(this.state);
    this.d.db.raw.exec("BEGIN IMMEDIATE");
    try { work(); this.persist(); this.d.db.raw.exec("COMMIT"); }
    catch (error) { this.d.db.raw.exec("ROLLBACK"); this.state = JSON.parse(before) as DurableState; throw error; }
  }

  private sessionOpen(m: StockMarket, at = this.now()): boolean {
    const s = m.session;
    return s.isOpen && !!s.tradingDate && Number.isFinite(s.checkedAt) && s.checkedAt <= at + 5000
      && at - s.checkedAt <= this.rules.risk.maxQuoteAgeMs && Number.isFinite(s.nextClose) && at < s.nextClose;
  }
  private quoteFresh(q: StockQuote | undefined, at = this.now()): q is StockQuote {
    return !!q && [q.bid, q.ask, q.last, q.ts, q.spreadBps].every(Number.isFinite)
      && q.bid > 0 && q.ask >= q.bid && q.last > 0 && q.ts <= at + 5000 && at - q.ts <= this.rules.risk.maxQuoteAgeMs;
  }
  private usable(m: StockMarket, at = this.now()): boolean {
    return m.ready && !m.error && this.sessionOpen(m, at) && this.rules.coins.every(s => this.quoteFresh(m.quotes[s], at));
  }
  private mid(q: StockQuote): number { return (q.bid + q.ask) / 2; }

  private mark(a: Account, m: StockMarket): void {
    const holdings = a.position ? [a.position] : a.basket;
    for (const p of holdings) {
      if (a.dataIssue) break;
      const s = m.signals[p.symbol];
      if (s && Number.isFinite(s.completedThrough) && p.lastSession < newYorkTradingDate(s.completedThrough)) {
        a.dataIssue = `${p.symbol}: missed trading session; valuation and trading paused until corporate actions are reviewed`;
        a.cap = "data_issue";
        a.last = { at: this.now(), attribution: "rules_required", status: a.dataIssue, decidedBy: "rules" };
        break;
      }
      // Splits/corrections must be repaired explicitly, not counted as incredible overnight returns.
      const split = s?.splitAdjustmentFactor !== undefined && Math.abs(s.splitAdjustmentFactor - 1) > 1e-6;
      if (p.lastSession !== m.session.tradingDate && s && (split || (s.previousClose > 0 && p.mark > 0 && Math.abs(s.previousClose / p.mark - 1) > 0.10))) {
        a.dataIssue = `${p.symbol}: overnight price discontinuity; valuation and trading paused pending data review`;
        a.cap = "data_issue";
        a.last = { at: this.now(), attribution: "rules_required", status: a.dataIssue, decidedBy: "rules" };
        break;
      }
    }
    // Preflight every basket component before changing any valuation; a flagged basket freezes consistently.
    if (!a.dataIssue) for (const p of holdings) {
      const q = m.quotes[p.symbol];
      if (this.quoteFresh(q)) { p.mark = this.mid(q); p.lastSession = m.session.tradingDate; }
    }
    a.equity = a.cash + (a.position ? a.position.shares * a.position.mark : a.basket.reduce((n, p) => n + p.shares * p.mark, 0));
    a.peak = Math.max(a.peak, a.equity);
    a.drawdown = Math.max(a.drawdown, a.peak > 0 ? (a.peak - a.equity) / a.peak * 100 : 0);
  }

  private rollSession(a: Account, m: StockMarket): void {
    if (a.session === m.session.tradingDate) return;
    a.session = m.session.tradingDate;
    a.dayStart = a.equity;
    a.entries = 0;
    if (a.cap !== "retired" && a.cap !== "data_issue") a.cap = null;
  }

  private evaluateCap(a: Account): void {
    if (a.dataIssue) { a.cap = "data_issue"; return; }
    if (a.cap === "retired") return;
    if (a.equity <= this.rules.startEquityUsd * (1 - this.rules.risk.retireDrawdownPct / 100)) { a.cap = "retired"; return; }
    if (a.cap === "loss_stop") return;
    if (a.equity <= a.dayStart * (1 - this.rules.risk.dailyLossStopPct / 100)) { a.cap = "loss_stop"; return; }
    if (a.entries >= this.rules.risk.maxEntriesPerSession) a.cap = "trade_cap";
  }

  private protective(a: Account, m: StockMarket): boolean {
    this.evaluateCap(a);
    const p = a.position;
    if (!p || a.dataIssue || !this.usable(m)) return false;
    const s = m.signals[p.symbol];
    if (s && Number.isFinite(s.atrPct) && s.atrPct > 0) p.stop = Math.max(p.stop, p.mark * (1 - s.atrPct / 100 * this.rules.risk.stopAtrMult));
    const reason = a.cap === "retired" ? "Retirement loss threshold" : a.cap === "loss_stop" ? "Daily loss stop" : p.mark <= p.stop ? "Trailing stop" : null;
    if (!reason) return false;
    const status = `${reason}: closed ${p.symbol}`;
    // The entire private fill and public outcome are one SQLite transaction, committed only together.
    if (!this.fill(a, { kind: "close" }, m)) return false;
    this.audit(a, null, null, { kind: "close" }, "protective_exit", status, reason);
    a.metrics.protectiveExits++;
    a.last = { at: this.now(), attribution: "protective_exit", status, decidedBy: "rules" };
    return true;
  }

  private actions(a: Account, m: StockMarket, protectedThisCycle = false): Record<string, Action> {
    if (a.dataIssue || a.cap === "retired" || a.cap === "loss_stop" || protectedThisCycle) return { HOLD: { kind: "hold" } };
    if (a.position) return { HOLD: { kind: "hold" }, CLOSE: { kind: "close" }, REDUCE_HALF: { kind: "trim" } };
    const out: Record<string, Action> = { HOLD: { kind: "hold" } };
    if (a.cap || (a.lastEntryAt !== null && this.now() - a.lastEntryAt < this.rules.risk.entryCooldownMs)) return out;
    for (const symbol of this.rules.coins) {
      const s = m.signals[symbol], q = m.quotes[symbol];
      if (s && s.slicesAvailable === 9 && s.score >= 3 && s.atrPct > 0 && Number.isFinite(s.atrPct)
          && this.quoteFresh(q) && q.spreadBps <= this.rules.risk.spreadGateBps) out[`BUY_${symbol}`] = { kind: "open", symbol };
    }
    return out;
  }

  private prepare(a: Account, m: StockMarket, protectedThisCycle: boolean): Prepared {
    const actions = this.actions(a, m, protectedThisCycle);
    const menu: Menu = {};
    for (const [label, action] of Object.entries(actions)) {
      menu[label] = action.kind === "open"
        ? { desc: `Buy ${action.symbol}; trend score ${m.signals[action.symbol]!.score}/9; fixed risk-managed size`, intent: { kind: "open", instId: action.symbol, side: "long", sizeFrac: this.rules.risk.maxExposurePct / 100, setup: "strict" } }
        : action.kind === "close" ? { desc: "Close the entire position to cash", intent: { kind: "close", reason: "ai_exit" } }
        : action.kind === "trim" ? { desc: "Sell half of the position", intent: { kind: "trim", fraction: 0.5 } }
        : { desc: a.position ? "Keep the current position" : "Stay in cash", intent: { kind: "hold" } };
    }
    return { actions, protected: protectedThisCycle, ask: {
      key: a.id, strategy: this.rules.strategy, menu, convictionLabels: ["weak", "fair", "strong", "overwhelming"],
      state: {
        market: { asOf: m.ts, session: m.session, stocks: this.rules.coins.map(symbol => ({ symbol, quote: m.quotes[symbol], signal: m.signals[symbol] ?? null })) },
        account: { equityUsd: a.equity, cashUsd: a.cash, position: a.position ? { symbol: a.position.symbol, sizeUsd: a.position.shares * a.position.mark,
          returnPct: (a.position.mark / a.position.entry - 1) * 100, stopDistancePct: (a.position.mark - a.position.stop) / a.position.mark * 100 } : null,
          entriesThisSession: a.entries, entriesLimit: this.rules.risk.maxEntriesPerSession, cap: a.cap },
        rules: { longOnly: true, fractionalShares: true, maxExposurePct: this.rules.risk.maxExposurePct, entryCooldownMinutes: this.rules.risk.entryCooldownMs / 60_000,
          costsPerSide: { feeBps: this.rules.risk.feeRate * 10000, slippageBps: this.rules.risk.slippageBps }, noAdding: true },
      },
    } };
  }

  private fill(a: Account, action: Action, m: StockMarket): boolean {
    if (this.stopped || !this.usable(m) || a.dataIssue || action.kind === "hold") return false;
    const symbol = action.kind === "open" ? action.symbol : a.position?.symbol;
    if (!symbol) return false;
    const q = m.quotes[symbol];
    if (!this.quoteFresh(q)) return false;
    const r = this.rules.risk;
    if (action.kind === "open") {
      if (a.position || a.cap || q.spreadBps > r.spreadGateBps) return false;
      const s = m.signals[symbol];
      if (!s || !(s.atrPct > 0)) return false;
      const px = q.ask * (1 + r.slippageBps / 10000);
      const notional = Math.min(a.equity * r.maxExposurePct / 100, a.cash / (1 + r.feeRate));
      if (!(notional > 0)) return false;
      const fee = notional * r.feeRate;
      a.cash -= notional + fee;
      a.position = { symbol, shares: notional / px, entry: px, mark: this.mid(q), stop: px * (1 - s.atrPct / 100 * r.stopAtrMult), lastSession: m.session.tradingDate };
      a.entries++; a.lastEntryAt = this.now(); a.totals.feesUsd += fee;
    } else {
      const p = a.position;
      if (!p) return false;
      const shares = action.kind === "trim" ? p.shares / 2 : p.shares;
      const px = q.bid * (1 - r.slippageBps / 10000), value = shares * px, fee = value * r.feeRate;
      a.cash += value - fee; a.totals.feesUsd += fee;
      a.totals.realisedUsd += (px - p.entry) * shares;
      p.shares -= shares;
      if (action.kind === "close") { a.position = null; a.totals.completedTrades++; }
    }
    a.totals.orders++;
    this.mark(a, m);
    this.evaluateCap(a);
    return true;
  }

  private audit(a: Account, prepared: Prepared | null, result: JevResult | null, action: Action, attribution: Attribution, status: string, veto: string | null = null): void {
    const at = this.now();
    const decidedBy = attribution === "protective_exit" || attribution === "rules_required" ? "rules" : result?.ok ? result.source : null;
    // Private decision evidence is retained for reproducibility; the activity event deliberately contains no quotes/fills.
    this.d.db.insertDecision({ bee: a.id as BeeId, ts: at, stateHash: prepared ? createHash("sha256").update(JSON.stringify(prepared.ask.state)).digest("hex") : null,
      stateJson: prepared ? JSON.stringify(prepared.ask.state) : null, menuJson: prepared ? JSON.stringify(Object.keys(prepared.actions)) : null,
      choice: result?.ok ? result.choice : null, probabilities: result?.ok ? result.probabilities : null,
      confidence: result?.ok ? result.confidence : null, conviction: result?.ok ? result.convictionRaw : null,
      latencyMs: result?.latencyMs ?? null, inputTokens: result?.ok ? result.inputTokens : null, jevCostUsd: result?.costUsd ?? 0,
      jevError: result && !result.ok ? result.reason : null, decidedBy: result?.ok ? result.source : decidedBy,
      action, vetoedBy: veto, forcedBy: attribution === "protective_exit" ? status : null, status });
    const event: Activity = { ts: at, botId: a.id, bot: a.name, attribution, status, decidedBy, action: action.kind === "open" ? `buy ${action.symbol}` : action.kind };
    this.d.db.insertEvent(at, "stock_activity", JSON.stringify(event));
    a.last = { at, attribution, status, decidedBy };
  }

  private processResult(a: Account, prepared: Prepared, result: JevResult, m: StockMarket): void {
    a.totals.decisions++;
    const hold: Action = { kind: "hold" };
    if (!result.ok) { this.audit(a, prepared, result, hold, "api_unavailable", "Decision API unavailable; no discretionary trade"); return; }
    const onlyHold = Object.keys(prepared.actions).length === 1;
    const attribution = onlyHold ? "rules_required" : "ai_choice";
    const chosen = prepared.actions[result.choice];
    if (!chosen) { this.audit(a, prepared, result, hold, "api_unavailable", "Invalid off-menu answer; no trade", "off_menu"); return; }
    if (onlyHold) a.metrics.holdAssessments++; else a.metrics.meaningfulChoices++;
    if (this.stopped || !this.usable(m)) { this.audit(a, prepared, result, hold, attribution, "Market closed or stale before execution; no trade", "market_unavailable"); return; }
    this.mark(a, m);
    const protectedNow = this.protective(a, m);
    const currentlyLegal = this.actions(a, m, prepared.protected || protectedNow);
    let action = chosen, veto: string | null = null;
    if (!currentlyLegal[result.choice]) { action = hold; veto = "rules_changed"; }
    if (action.kind === "open" && ((result.probabilities[result.choice] ?? 0) < this.rules.risk.minActionProbability || result.conviction < this.rules.risk.minConviction)) {
      action = hold; veto = "weak_conviction";
    }
    if (action.kind !== "hold" && !this.fill(a, action, m)) { action = hold; veto = "execution_unavailable"; }
    const status = veto ? `${result.choice} blocked by ${veto.replaceAll("_", " ")}`
      : onlyHold ? (a.dataIssue ?? `Hold required by rules${a.cap ? ` (${a.cap.replaceAll("_", " ")})` : ""}; API assessed signal strength`)
      : action.kind === "open" ? `Bought ${action.symbol}` : action.kind === "close" ? "Closed position to cash" : action.kind === "trim" ? "Reduced position by half" : "Chose to hold";
    const previous = a.last;
    this.audit(a, prepared, result, action, attribution, status, veto);
    if (protectedNow || prepared.protected) a.last = previous;
  }

  private initBasket(m: StockMarket): void {
    const a = this.state.benchmarks.buy_hold;
    if (a.startedAt !== null || !this.usable(m)) return;
    const r = this.rules.risk, perStock = a.equity * r.maxExposurePct / 100 / this.rules.coins.length;
    for (const symbol of this.rules.coins) {
      const q = m.quotes[symbol]!, px = q.ask * (1 + r.slippageBps / 10000), fee = perStock * r.feeRate;
      a.basket.push({ symbol, shares: perStock / px, entry: px, mark: this.mid(q), stop: 0, lastSession: m.session.tradingDate });
      a.cash -= perStock + fee; a.totals.feesUsd += fee; a.totals.orders++;
    }
    a.startedAt = this.now();
    a.last = { at: this.now(), attribution: "rules_required", status: "Holding the initial equal-weight basket; no rebalancing", decidedBy: "rules" };
    this.mark(a, m);
  }

  private rulesBaseline(m: StockMarket, protectedThisCycle: boolean): void {
    const a = this.state.benchmarks.rules;
    if (protectedThisCycle || a.dataIssue) return;
    const actions = this.actions(a, m);
    let chosen: Action = { kind: "hold" };
    if (a.position && (m.signals[a.position.symbol]?.score ?? 0) <= 0) chosen = { kind: "close" };
    else if (!a.position) chosen = Object.values(actions).filter((x): x is { kind: "open"; symbol: string } => x.kind === "open")
      .sort((a, b) => m.signals[b.symbol]!.score - m.signals[a.symbol]!.score || a.symbol.localeCompare(b.symbol))[0] ?? chosen;
    if (chosen.kind === "hold") return;
    const status = chosen.kind === "open" ? `Rules baseline bought ${chosen.symbol}` : "Rules baseline exited exhausted trend";
    if (this.fill(a, chosen, m)) this.audit(a, null, null, chosen, "rules_required", status);
  }

  private recordEquity(): void {
    const insert = this.d.db.raw.prepare("INSERT INTO equity_snapshots (bee,ts,equity_usd,cash_usd,upl_usd) VALUES (?,?,?,?,?)");
    for (const a of this.allAccounts()) {
      const holdings = a.position ? [a.position] : a.basket;
      const upl = holdings.reduce((sum, p) => sum + p.shares * (p.mark - p.entry), 0);
      insert.run(a.id, this.now(), a.equity, a.cash, upl);
    }
  }

  private async runTick(): Promise<void> {
    let m: StockMarket;
    try { m = structuredClone(await this.d.feed.refresh()); this.market = m; }
    catch { this.market = null; return; }
    if (this.stopped || !this.usable(m)) return;
    const prepared = {} as Record<DerbyId, Prepared>;
    this.atomic(() => {
      if (this.state.startedAt === null) this.state.startedAt = this.now();
      for (const a of this.allAccounts()) {
        if (a.id !== "buy_hold" && a.startedAt === null) a.startedAt = this.state.startedAt;
        // Carry the previous close into session-start equity so an opening gap counts toward the loss stop.
        this.rollSession(a, m); this.mark(a, m);
      }
      this.initBasket(m);
      for (const id of IDS) {
        const a = this.state.accounts[id];
        const exited = this.protective(a, m);
        prepared[id] = this.prepare(a, m, exited);
      }
      const baselineExited = this.protective(this.state.benchmarks.rules, m);
      this.rulesBaseline(m, baselineExited);
      this.recordEquity();
      const pruneDay = m.session.tradingDate;
      if (this.d.db.getMeta("stock_private_audit_pruned_day") !== pruneDay) {
        // Keep outcome/cost/count history, but raw licensed market evidence is private and short-lived.
        this.d.db.raw.prepare("UPDATE decisions SET state_json=NULL,menu_json=NULL WHERE ts<? AND (state_json IS NOT NULL OR menu_json IS NOT NULL)").run(this.now() - 7 * 86_400_000);
        this.d.db.setMeta("stock_private_audit_pruned_day", pruneDay);
      }
    });
    // Both providers receive the same captured market evidence, concurrently; only own-account state differs.
    const results = await Promise.all(IDS.map(async id => {
      try { return await this.d.decisions.decide(prepared[id].ask); }
      catch { return { ok: false, reason: "error", latencyMs: 0 } as JevResult; }
    }));
    const latest = structuredClone(this.d.feed.view());
    this.market = latest;
    this.atomic(() => {
      IDS.forEach((id, i) => {
        const a = this.state.accounts[id];
        const protectiveLast = prepared[id].protected ? { ...a.last } : null;
        this.processResult(a, prepared[id], results[i]!, latest);
        // A subsequent paid assessment/error does not relabel the protective trade that already happened.
        if (protectiveLast) a.last = protectiveLast;
      });
      for (const a of this.allAccounts()) this.mark(a, latest);
      this.recordEquity();
    });
  }

  private publicAccount(a: Account) {
    const apiCostUsd = IDS.includes(a.id as DerbyId) ? this.d.decisions.status(a.id as DerbyId).totalCostUsd : 0;
    const netEquityUsd = a.equity - apiCostUsd, netPnlUsd = netEquityUsd - this.rules.startEquityUsd;
    return { id: a.id, name: a.name, startedAt: a.startedAt, equityUsd: a.equity, cashUsd: a.cash,
      pnlUsd: a.equity - this.rules.startEquityUsd, pnlPct: (a.equity / this.rules.startEquityUsd - 1) * 100,
      netEquityUsd, netPnlUsd, apiCostUsd, maxDrawdownPct: a.drawdown,
      position: a.position ? { symbol: a.position.symbol, coin: a.position.symbol, side: "long" as const, sizeUsd: a.position.shares * a.position.mark } : null,
      entriesToday: a.entries, tradesToday: a.entries, cap: a.cap, dataIssue: a.dataIssue, totals: { ...a.totals },
      metrics: { ...a.metrics, netEquityUsd, netPnlUsd, maxDrawdownPct: a.drawdown }, last: { ...a.last }, status: a.last.status };
  }

  snapshot() {
    const m = this.market ? this.d.feed.view() : null, now = this.now();
    const session: StockSession | null = m ? { ...m.session, isOpen: this.sessionOpen(m, now) } : null;
    const finished = IDS.every(id => this.state.accounts[id].cap === "retired" && !this.state.accounts[id].position);
    const state = finished ? "finished" : !m ? (this.state.startedAt === null ? "starting" : "stale")
      : !m.error && !session?.isOpen && now - m.session.checkedAt <= this.rules.risk.maxQuoteAgeMs ? "market_closed"
      : this.usable(m) && !this.allAccounts().some(a => a.dataIssue) ? "running" : "stale";
    return { startedAt: this.state.startedAt, marketUpdatedAt: m?.ts ?? null, state, session,
      marketError: m?.error ? "Stock market data is unavailable or incomplete" : null,
      portfolios: { bee1: this.publicAccount(this.state.accounts.bee1), bee2: this.publicAccount(this.state.accounts.bee2) },
      benchmarks: Object.values(this.state.benchmarks).map(a => this.publicAccount(a)) };
  }

  equitySeries(sinceTs = this.now() - 30 * 86_400_000, points = 720): Record<string, Array<[number, number]>> {
    const bucket = Math.max(this.rules.tickMs, Math.ceil(Math.max(1, this.now() - sinceTs) / Math.max(1, points)));
    const rows = this.d.db.raw.prepare("SELECT bee,ts,eq FROM (SELECT bee,ts,equity_usd AS eq,ROW_NUMBER() OVER(PARTITION BY bee,ts/? ORDER BY ts DESC,rowid DESC) AS rank FROM equity_snapshots WHERE ts>=? AND bee IN ('bee1','bee2','cash','buy_hold','rules')) WHERE rank=1 ORDER BY ts").all(bucket, sinceTs) as Array<{ bee: string; ts: number; eq: number }>;
    const out: Record<string, Array<[number, number]>> = {};
    for (const row of rows) (out[row.bee] ??= []).push([row.ts, row.eq]);
    return out;
  }

  activity(limit = 80): Activity[] {
    const rows = this.d.db.raw.prepare("SELECT json FROM events WHERE type='stock_activity' ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as Activity);
  }
}
