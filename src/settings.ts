// What the first-run Setup page saves: the chooser key (Gemini or Jev), an optional OpenAI key, the risk acknowledgement, the three
// bees (name, trading style, tagline, optional generated portrait), and whether to join the Hive. Stored as one JSON file in the data volume,
// readable by the engine's user only. Secrets in here are never sent to the dashboard or written to a log.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const STYLES = ["bizzy", "breezy", "boozy"] as const;
/** A trading style is one of the three built-in strategies, named after the bee that first traded it. */
export type StyleId = (typeof STYLES)[number];

export const STYLE_INFO: Record<StyleId, { label: string; blurb: string; name: string; tagline: string }> = {
  bizzy: {
    label: "Breakout",
    blurb: "Grinds both ways on 8 liquid majors: fades stretched moves, and takes confirmed daily breakouts on BTC, ETH, SOL or HYPE. Quick exits.",
    name: "Bizzy",
    tagline: "the grinder",
  },
  breezy: {
    label: "Trend",
    blurb: "Trend following on BTC and ETH only. Sits in cash in chop, rides winners, sized by volatility. The calm one.",
    name: "Breezy",
    tagline: "the calculated one",
  },
  boozy: {
    label: "Momentum",
    blurb: "Chases fresh momentum on high-volume coins, long or short, and adds once to a winner. Waits flat when nothing moves.",
    name: "Boozy",
    tagline: "the degen",
  },
};

/** The original three are the official bees: owners' bees may not use their names ("Bizzy", "bizzy-bee", "Bizzie Bee"). */
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/bee$/, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/(ie|ey|i)$/, "y");
const RESERVED = new Set(STYLES.map((s) => squash(STYLE_INFO[s].name)));

export function isReservedName(name: string): boolean {
  return RESERVED.has(squash(name));
}

const BeeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .regex(/^[\p{L}\p{N} .'_-]+$/u, "letters, numbers, spaces and . ' _ - only"),
  /** The built-in brain this bee runs on (Setup derives it from the bee's coins; see bees/custom.ts). */
  style: z.enum(STYLES),
  tagline: z.string().trim().max(40).default(""),
  /** The owner's rules for this bee in plain English, fed to the chooser with every decision. */
  rules: z.string().trim().max(500).default(""),
  /** Coin tickers this bee is restricted to ([] = any). */
  coins: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{1,15}$/),
    )
    .max(20)
    .default([]),
  /** What the bee looks like (used for its portrait). */
  look: z.string().trim().max(400).optional(),
  /** true once a portrait has been generated for this bee (served from the data volume). */
  image: z.boolean().default(false),
});

export const SettingsSchema = z.object({
  version: z.literal(1),
  /** The chooser's key: Gemini (preferred when both are set) or Jev. Setup asks for at least one. */
  geminiKey: z.string().trim().min(8).optional(),
  jevKey: z.string().trim().min(8).optional(),
  openaiKey: z.string().trim().min(8).optional(),
  /** The owner password, as a salted scrypt hash (gate.ts). Absent in files saved before it existed. */
  ownerPasswordHash: z.string().startsWith("scrypt$").optional(),
  /** When the operator ticked the risk statements on the Setup page. */
  acceptedRiskAt: z.number(),
  bees: z.array(BeeSchema).length(3),
  /** The "Join the Hive?" answer on the Setup page (absent in files saved before the Hive existed). */
  hive: z.boolean().optional(),
  createdAt: z.number(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type BeeSettings = z.infer<typeof BeeSchema>;
export { BeeSchema };

export function loadSettings(path: string): Settings | null {
  if (!existsSync(path)) return null;
  const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not valid (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}). Delete it and run Setup again.`);
  return parsed.data;
}

/** Atomic write, owner-only permissions. */
export function saveSettings(path: string, s: Settings): void {
  writePrivateJson(path, s);
}

/** Atomic JSON write, readable by the engine's user only (Setup file, Hive file). */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
