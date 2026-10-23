import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";
import type { Settings } from "../src/settings.js";

describe("config", () => {
  it("DRY_RUN defaults to true, which forces dry whatever MODE says", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "demo", DRY_RUN: "true" }).mode).toBe("dry");
  });

  it("starts without any chooser key in dry and demo (code chooser), but live needs a Gemini or Jev key", () => {
    expect(loadConfig({}).jev).toMatchObject({ provider: "code", apiKey: "" });
    expect(loadConfig({ TYPESAFE_API_KEY: "  ", GEMINI_API_KEY: " " }).jev.provider).toBe("code");
    const demo: Record<string, string> = { DRY_RUN: "false", MODE: "demo" };
    const live: Record<string, string> = { DRY_RUN: "false", MODE: "live", LIVE_ACK: LIVE_ACK_PHRASE };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) {
      demo[`${b}_OKX_DEMO_API_${f}`] = `${b}-${f}`;
      live[`${b}_OKX_API_${f}`] = `${b}-${f}`;
    }
    expect(loadConfig(demo).mode).toBe("demo");
    expect(() => loadConfig(live)).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({ ...live, GEMINI_API_KEY: "  " })).toThrow(/GEMINI_API_KEY/);
    expect(loadConfig({ ...live, GEMINI_API_KEY: "g" }).mode).toBe("live");
    expect(loadConfig({ ...live, TYPESAFE_API_KEY: "k" }).mode).toBe("live");
  });

  it("a Gemini key picks Gemini 4 Argon with its own settings; a Jev key alone picks Jev", () => {
    const g = loadConfig({ GEMINI_API_KEY: "g" });
    expect(g.jev).toMatchObject({ provider: "gemini", apiKey: "g", model: "gemini-4-argon", usdPerMTok: 4, usdPerMTokOut: 20, dailyUsdCap: 3, timeoutMs: 3000, minIntervalMs: 60_000 });
    const j = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(j.jev).toMatchObject({ provider: "jev", apiKey: "k", model: "jev-1.13.0", usdPerMTok: 0.042, usdPerMTokOut: 0, dailyUsdCap: 2, minIntervalMs: 0 });
  });

  it("with both keys Gemini wins, and leftover Jev settings never reach the Gemini chooser", () => {
    const c = loadConfig({ GEMINI_API_KEY: "g", TYPESAFE_API_KEY: "jev-key", JEV_MODEL: "jev-1.13.0", JEV_USD_PER_MTOK: "0.042", JEV_DAILY_USD_CAP: "5", JEV_TIMEOUT_MS: "2000" });
    expect(c.jev).toMatchObject({ provider: "gemini", apiKey: "g", model: "gemini-4-argon", usdPerMTok: 4, usdPerMTokOut: 20, dailyUsdCap: 3, timeoutMs: 3000 });
  });

  it("rejects a negative Gemini cap and a zero timeout", () => {
    expect(() => loadConfig({ GEMINI_DAILY_USD_CAP: "-1" })).toThrow(/GEMINI_DAILY_USD_CAP/);
    expect(() => loadConfig({ GEMINI_TIMEOUT_MS: "0" })).toThrow(/GEMINI_TIMEOUT_MS/);
  });

  it("rejects zero, negative and non-finite Gemini prices, naming the variable but never the value", () => {
    const key = { GEMINI_API_KEY: "fake-key", DRY_RUN: "true" };
    for (const name of ["GEMINI_USD_PER_MTOK", "GEMINI_USD_PER_MTOK_OUT"]) {
      for (const v of ["0", "-1", "-0.000001", "Infinity", "-Infinity", "NaN", "abc"]) {
        let msg = "";
        try {
          loadConfig({ ...key, [name]: v });
        } catch (err) {
          msg = (err as Error).message;
        }
        expect(msg, `${name}=${v}`).toContain(name);
        if (v !== "0") expect(msg).not.toContain(v.replace(/^-/, ""));
      }
    }
    // Both at once: both named.
    expect(() => loadConfig({ ...key, GEMINI_USD_PER_MTOK: "0", GEMINI_USD_PER_MTOK_OUT: "-1" })).toThrow(/GEMINI_USD_PER_MTOK:[\s\S]*GEMINI_USD_PER_MTOK_OUT/);
    // Valid: positive and finite, including the launch prices.
    expect(loadConfig({ ...key, GEMINI_USD_PER_MTOK: "2", GEMINI_USD_PER_MTOK_OUT: "10" }).jev).toMatchObject({ usdPerMTok: 2, usdPerMTokOut: 10 });
    expect(loadConfig({ ...key, GEMINI_USD_PER_MTOK: "0.0001", GEMINI_USD_PER_MTOK_OUT: "0.0001" }).jev.usdPerMTok).toBe(0.0001);
  });

  it("with Jev in use, its price must be above 0 and its cap 0 or more", () => {
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_USD_PER_MTOK: "0" })).toThrow(/JEV_USD_PER_MTOK/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_USD_PER_MTOK: "-1" })).toThrow(/JEV_USD_PER_MTOK/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_DAILY_USD_CAP: "-1" })).toThrow(/JEV_DAILY_USD_CAP/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "0" })).toThrow(/JEV_TIMEOUT_MS/);
    expect(loadConfig({ TYPESAFE_API_KEY: "k", JEV_DAILY_USD_CAP: "0" }).jev.dailyUsdCap).toBe(0);
  });

  it("demo needs all three demo keys and lists the missing NAMES only", () => {
    const env = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo", BEE1_OKX_DEMO_API_KEY: "secret-value-1" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BEE1_OKX_DEMO_API_SECRET/);
    expect(msg).toMatch(/BEE3_OKX_DEMO_API_KEY/);
    expect(msg).not.toMatch(/secret-value-1/);
    expect(msg).not.toMatch(/BEE1_OKX_API_KEY\b/); // live keys not required in demo
  });

  it("demo with every key set loads per-bee creds", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo" };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_DEMO_API_${f}`] = `${b}-${f}`;
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe("demo");
    expect(cfg.creds.bee3?.apiKey).toBe("BEE3-KEY");
  });

  it("live needs the written risk acknowledgement, and demo/dry do not", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live" };
    for (const b of ["BEE1", "BEE2", "BEE3"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_API_${f}`] = `${b}-${f}`;
    expect(() => loadConfig(env)).toThrow(/LIVE_ACK/);
    expect(() => loadConfig({ ...env, LIVE_ACK: "yes" })).toThrow(/LIVE_ACK/);
    expect(loadConfig({ ...env, LIVE_ACK: LIVE_ACK_PHRASE }).mode).toBe("live");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).mode).toBe("dry");
  });

  it("with no Setup file the bees are the original three", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.slots.bee1).toMatchObject({ style: "bizzy", name: "Bizzy", customImage: false });
    expect(c.slots.bee2).toMatchObject({ style: "breezy", name: "Breezy" });
    expect(c.slots.bee3).toMatchObject({ style: "boozy", name: "Boozy" });
  });

  it("a Setup file supplies the chooser key and the bees; the environment still wins", () => {
    const settings: Settings = {
      version: 1,
      jevKey: "from-setup",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        { name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips.", coins: ["BTC"], image: true },
        { name: "Zippy", style: "boozy", tagline: "", rules: "", coins: [], image: false },
        { name: "Rex", style: "boozy", tagline: "", rules: "", coins: [], image: false },
      ],
    };
    const c = loadConfig({}, settings);
    expect(c.jev).toMatchObject({ provider: "jev", apiKey: "from-setup" });
    expect(c.mode).toBe("dry");
    expect(c.slots.bee1).toMatchObject({ name: "Granny", style: "breezy", customImage: true, rules: "Buy BTC dips.", coins: ["BTC"], fromSetup: true });
    expect(c.slots.bee3.style).toBe("boozy");
    expect(loadConfig({ TYPESAFE_API_KEY: "env" }, settings).jev.apiKey).toBe("env");
    // A Gemini key from Setup (or the environment) takes over from the Jev key.
    expect(loadConfig({}, { ...settings, geminiKey: "gemini-from-setup" }).jev).toMatchObject({ provider: "gemini", apiKey: "gemini-from-setup" });
    expect(loadConfig({ GEMINI_API_KEY: "g-env" }, settings).jev).toMatchObject({ provider: "gemini", apiKey: "g-env" });
  });

  it("defaults match the strategy files", () => {
    const c = loadConfig({ GEMINI_API_KEY: "g" });
    expect(c.bees.bizzy).toMatchObject({ maxTradesPerDay: 4, feeBudgetUsdDay: 1.2, spreadGateBps: 5, cooldownMinutes: 30, stopAtrMult: 2, maxFlatMinutes: 1440 });
    expect(c.bees.boozy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 1.5, spreadGateBps: 8, cooldownMinutes: 60, stopAtrMult: 2.5, maxFlatMinutes: 1440 });
    expect(c.bees.breezy).toMatchObject({ maxTradesPerDay: 2, feeBudgetUsdDay: 0.75, spreadGateBps: 5, cooldownMinutes: 240, stopAtrMult: 2, maxFlatMinutes: 1440 });
    expect(c.breezy.minOpenProb).toBe(0.55);
    expect(c.bizzy).toMatchObject({ sizeFraction: 0.5, timeStopMinutes: 240 });
    expect(c.tickMs).toBe(10_000);
    expect(c.jev.dailyUsdCap).toBe(3);
    expect(c.dataRefreshMs).toBe(60_000);
    expect(c.risk.maxLeverage).toBe(2);
  });
});
