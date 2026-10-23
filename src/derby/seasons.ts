import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";

/** meta.derby_rules is the immutable public experiment protocol; the hash guards restarts. */
export function lockSeason(db: Db, rules: unknown): void {
  const signature = createHash("sha256").update(JSON.stringify(rules)).digest("hex");
  const previous = db.getMeta("derby_rules_hash");
  if (previous && previous !== signature) throw new Error("Competition rules differ from this database. Start a new season with a new DB_PATH.");
  if (!previous && db.getMeta("experiment_started_at")) throw new Error("Use a fresh Bot Derby database, not an existing trading run.");
  db.setMeta("derby_rules_hash", signature);
  db.setMeta("derby_rules", JSON.stringify(rules));
}

const archiveSchema = z.array(z.object({
  season: z.string().max(20), title: z.string().max(120), endedAt: z.number().finite(),
  bots: z.array(z.object({ name: z.string().max(40), equityUsd: z.number().finite(), pnlUsd: z.number().finite(), totalCostUsd: z.number().finite().nonnegative() })).max(2),
})).max(20);

/** meta.derby_archives contains aggregate end-of-season results, never a raw trading ledger. */
export function publicArchives(db: Db) {
  try { return archiveSchema.parse(JSON.parse(db.getMeta("derby_archives") || "[]")); }
  catch { return []; }
}
