import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Db } from "../db.js";

export interface PublicDerby {
  db: Db;
  snapshot(): unknown;
  /** Curated stock-season responses exclude licensed quotes and private decision evidence. */
  equitySeries?(): unknown;
  activity?(): unknown;
  webDir: string;
}
/** Exact allowlist: no setup, owner, trading, webhook, upload, proxy or write routes exist. */
export function derbyServer(d: PublicDerby) {
  const assets = new Map([
    ["/", { type: "text/html; charset=utf-8", body: readFileSync(join(d.webDir, "index.html")) }],
    ["/app.js", { type: "text/javascript; charset=utf-8", body: readFileSync(join(d.webDir, "app.js")) }],
    ["/styles.css", { type: "text/css; charset=utf-8", body: readFileSync(join(d.webDir, "styles.css")) }],
    ["/favicon.svg", { type: "image/svg+xml", body: readFileSync(join(d.webDir, "favicon.svg")) }],
  ]);
  const cache = new Map<string, { at: number; body: string }>();
  const cached = (key: string, produce: () => unknown) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.body;
    const body = JSON.stringify(produce());
    cache.set(key, { at: Date.now(), body });
    return body;
  };
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status: number, body: string | Buffer, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return send(405, '{"error":"This website is read-only"}');
    }
    try {
      const path = new URL(req.url || "/", "http://localhost").pathname;
      const asset = assets.get(path);
      if (asset) return send(200, asset.body, asset.type);
      if (path === "/healthz") return send(200, '{"ok":true,"service":"bot-derby"}');
      if (path === "/api/scoreboard") return send(200, cached(path, d.snapshot));
      if (path === "/api/equity") return send(200, cached(path, () => d.equitySeries ? d.equitySeries() : d.db.equitySeries(Date.now() - 30 * 86_400_000, 720)));
      if (path === "/api/activity") return send(200, cached(path, () => d.activity ? d.activity() : d.db.recentEvents(80).map(line => JSON.parse(line))));
      return send(404, '{"error":"Not found"}');
    } catch {
      return send(500, '{"error":"Scoreboard temporarily unavailable"}');
    }
  });
}
