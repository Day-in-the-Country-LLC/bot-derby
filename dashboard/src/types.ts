// Mirrors the engine's read-only /snapshot and SSE payloads. No account data exists in these shapes.
import { BEE_MARK_URL } from "./BeeMark";

/** The three bee slots. Names, taglines and portraits come from the engine's /profile (set on the Setup page). */
export type BeeName = "bee1" | "bee2" | "bee3";
export const BEE_NAMES: BeeName[] = ["bee1", "bee2", "bee3"];

export type Cap = "trade_cap" | "fee_budget" | "loss_stop" | "retired" | null;

export interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
  /** Who actually made the call (absent on older engines). */
  decidedBy?: DecisionSource | null;
  fallbackReason?: string | null;
}

/** Who actually made a call: the model, Jev, the deterministic code chooser standing in for it, or the rules. */
export type DecisionSource = "gemini" | "jev" | "code" | "rules";

export interface PublicBee {
  bee: BeeName;
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  position: {
    coin: string;
    side: "long" | "short";
    sizeUsd: number | null;
    entryPx: number;
    markPx: number | null;
    stopPx: number | null;
    uplUsd: number;
    minutesHeld: number;
  } | null;
  flatMinutes: number | null;
  tradesToday: number;
  maxTradesPerDay: number;
  feesTodayUsd: number;
  feeBudgetUsd: number;
  cap: Cap;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  maxNotionalUsd: number;
  last: LastDecision | null;
}

export interface Snapshot {
  ts: number;
  mode: "dry" | "demo" | "live";
  closed?: { at: number; flat: boolean } | null;
  startedAt: number;
  startEquityUsd: number;
  tickMs: number;
  bees: PublicBee[];
  leaderboard: Array<{ bee: BeeName; equityUsd: number }>;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; pnlUsd: number };
  /** The chooser (the name "jev" is kept for older engines). provider/name/fullName are absent on engines before Gemini support. */
  jev: {
    spentTodayUsd: number;
    dailyCapUsd: number;
    capTripped: boolean;
    down: boolean;
    /** A call was refused today because its reserved worst case did not fit under the cap. */
    budgetRefused?: boolean;
    /** The latest time the code chooser stood in for the model, and why. */
    lastFallback?: { reason: string; at: number } | null;
    /** The CONFIGURED chooser; who made each call is the decision's own decidedBy. */
    provider?: "gemini" | "jev" | "code";
    name?: string;
    fullName?: string;
  };
  recon: { ok: boolean | null; detail: string; ts: number };
  market: { refreshedAt: number; universe: string[]; spreadBlocked: Array<{ coin: string; spreadBp: number }>; attention: "news" | "volume" };
  visitors?: { total: number; watching: number };
  /** Set when a newer GitHub Release exists than the version this install runs. */
  update?: { current: string; latest: string } | null;
  keeper?: KeeperState;
}

/** One Beekeeper round (src/keeper.ts in the engine). `bee` is the bee it was about, null when it touched nobody. */
export interface KeeperEntry {
  id: number;
  /** Round start, and when it ended the way `action` says (the start while it is still running). */
  ts: number;
  at: number;
  action: "calling" | "rewrote" | "quiet" | "skipped" | "refused" | "failed" | "rolled_back";
  bee: BeeName | null;
  quip: string;
  idea: string | null;
  reason: string | null;
  anger: number | null;
}

export interface KeeperState {
  /** false: no Zap is connected (the card shows the "Connect the Beekeeper" form). */
  on: boolean;
  nextRoundAt: number | null;
  everyHours: number;
  rounds: number;
  rewrites: number;
  lockedUntil: Partial<Record<BeeName, number | null>>;
  entries: KeeperEntry[];
}

export interface KeeperEvent {
  type: "keeper";
  ts: number;
  entry: KeeperEntry;
}

export interface DecisionEvent {
  type: "decision";
  ts: number;
  bee: BeeName;
  choice: string | null;
  probabilities: Array<{ label: string; p: number }>;
  confidence: number | null;
  conviction: string | null;
  latencyMs: number | null;
  tokens: number | null;
  jevUsd: number;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  jev: string;
  /** A benched bee's live row: no Jev call, just its position P&L moving. */
  pulse?: boolean;
  /** Flat bee with nothing to ask Jev: what it is watching for (e.g. "SOL is 0.80% from breakout"). */
  watch?: string;
  /** One legal move (a hold, e.g. a Momentum bee inside its minimum hold): the rules decided and the model was not asked. */
  required?: boolean;
  /** Who actually made the call ("code" = the code chooser stood in for the model; null = nobody was asked). */
  decidedBy?: DecisionSource | null;
  /** Why the code chooser answered. */
  fallbackReason?: string | null;
  /** The bee's money at this moment: open P&L while positioned, total P&L when flat, and the move since its last row. */
  live?: { coin: string | null; side: "long" | "short" | null; valueUsd: number; kind: "open" | "total"; deltaUsd: number };
}

export interface FillEvent {
  type: "fill";
  ts: number;
  bee: BeeName;
  coin: string;
  side: "buy" | "sell";
  purpose: string;
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  label: string;
}

export interface CapEvent {
  type: "cap";
  ts: number;
  bee: BeeName;
  cap: Cap;
  detail: string;
}

export interface FundingEvent {
  type: "funding";
  ts: number;
  bee: BeeName;
  coin: string | null;
  amountUsd: number;
}

export type AnyEvent =
  | DecisionEvent
  | FillEvent
  | CapEvent
  | FundingEvent
  | KeeperEvent
  | { type: "equity"; ts: number; bees: PublicBee[] }
  | { type: "recon"; ts: number; ok: boolean; detail: string }
  | { type: "order" | "heartbeat" | "status"; ts: number; [k: string]: unknown };

export interface BeeMeta {
  /** Card title: "Boozy Bee" for the official three, the owner's own name for a Setup-made bee. */
  title: string;
  short: string;
  tagline: string;
  styleLabel: string;
  /** The owner's rules for this bee (Setup), "" for the original three. */
  rules: string;
  coins: string[];
  img: string;
  color: string;
  glow: string;
}

/** Colours belong to the slot, so two bees on the same style still look different. Filled in from /profile at load. */
export const BEE_META: Record<BeeName, BeeMeta> = {
  bee1: { title: "Bizzy Bee", short: "Bizzy", tagline: "the grinder", styleLabel: "Breakout", rules: "", coins: [], img: "/bees/bizzy.jpg", color: "var(--bizzy)", glow: "var(--bizzy-glow)" },
  bee2: { title: "Breezy Bee", short: "Breezy", tagline: "the calculated one", styleLabel: "Trend", rules: "", coins: [], img: "/bees/breezy.jpg", color: "var(--breezy)", glow: "var(--breezy-glow)" },
  bee3: { title: "Boozy Bee", short: "Boozy", tagline: "the degen", styleLabel: "Momentum", rules: "", coins: [], img: "/bees/boozy.jpg", color: "var(--boozy)", glow: "var(--boozy-glow)" },
};

export interface Profile {
  setup: boolean;
  mode: "dry" | "demo" | "live";
  links: { sponsor: string; code: string } | null;
  /** img null: a Setup-made bee without its portrait (the dashboard shows the placeholder mark). */
  bees: Array<{ id: BeeName; name: string; tagline: string; style: string; styleLabel: string; rules?: string; coins?: string[]; img: string | null }>;
}

export const PROFILE: { links: Profile["links"] } = { links: null };

const OFFICIAL_NAMES = ["Bizzy", "Breezy", "Boozy"];

export function applyProfile(p: Profile): void {
  PROFILE.links = p.links;
  for (const b of p.bees) {
    const m = BEE_META[b.id];
    if (!m) continue;
    m.short = b.name;
    m.title = OFFICIAL_NAMES.includes(b.name) ? `${b.name} Bee` : b.name;
    m.tagline = b.tagline;
    m.styleLabel = b.styleLabel;
    m.rules = b.rules ?? "";
    m.coins = b.coins ?? [];
    m.img = b.img ?? BEE_MARK_URL;
  }
}

/** Shown on Setup and in the dashboard's Hive dialog. */
export const HIVE_DISCLAIMER =
  "You're about to share your bees' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.";

/** The engine's GET /hive/status. No hive id, no key. */
export interface HiveStatus {
  joined: boolean;
  /** false in MODE=live: the Hive is paper only. */
  paper: boolean;
  /** The leaderboard's base URL (HIVE_URL). */
  board: string;
  lastReportAt: number | null;
  verified: Record<string, boolean> | null;
  problem: string | null;
  locked: boolean;
  /** false: no owner password on this server (join/leave impossible until one is set). */
  passwordSet: boolean;
}

/** The chooser's short name for labels ("Argon", "Jev", "Code"). Older engines did not send one: they ran Jev. */
export const chooserShort = (snap: Snapshot | null | undefined): string => snap?.jev?.name ?? "Jev";

/** Why the code chooser made a call instead of the model, in words ("Argon answered off the menu"). */
export function fallbackText(reason: string | null | undefined, who: string): string {
  switch (reason) {
    case "no_key":
      return "no model key";
    case "cap":
      return `${who} daily cap reached`;
    case "reservation":
      return `${who} call refused: it could pass the daily cap`;
    case "backoff":
      return `${who} backing off after errors`;
    case "timeout":
      return `${who} timed out`;
    case "error":
      return `${who} call failed`;
    case "off_menu":
      return `${who} answered off the menu`;
    case "paced":
      return `${who} asked under a minute ago: holding`;
    case "single_option":
      return "one move on the menu";
    default:
      return `${who} not used`;
  }
}

/** The code chooser made this call (it carries a synthetic confidence, so it is never shown as the model's). */
export const byCode = (d: { decidedBy?: DecisionSource | null } | null | undefined): boolean => d?.decidedBy === "code";
