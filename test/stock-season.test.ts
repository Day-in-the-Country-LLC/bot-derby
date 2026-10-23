import { afterEach, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { derbyConfig } from '../src/derby/config.js';
import { lockSeason, publicArchives } from '../src/derby/seasons.js';

const databases: Db[] = [];
const db = () => { const d = new Db(':memory:'); databases.push(d); return d; };
afterEach(() => databases.splice(0).forEach(d => d.close()));
it('keeps stocks as an explicitly new, cash-only paper experiment', () => {
  const c = derbyConfig({});
  expect(c.stockRules.coins).toEqual(['AAPL','MSFT','NVDA','AMZN','GOOGL']);
  expect(c.stockRules.assetClass).toBe('stocks');
  expect(c.stockRules.risk.maxLeverage).toBe(1);
  expect(c.stockRules.startEquityUsd).toBe(50_000);
  expect(c.cfg.tickMs).toBe(10_000);
  expect(c.providers.bee1.dailyUsdCap).toBeNull();
  expect(c.cfg.dbPath).toContain('stocks-s02');
  expect(() => derbyConfig({MODE:'live'})).toThrow();
});
it('refuses to mix changed balances, models, or market rules into a season', () => {
  const d = db(), rules = {...derbyConfig({}).stockRules,model:'unchanged'};
  lockSeason(d,rules);
  expect(() => lockSeason(d,rules)).not.toThrow();
  for (const change of [{startEquityUsd:1000},{model:'other'},{assetClass:'crypto'}])
    expect(() => lockSeason(d,{...rules,...change})).toThrow('new season');
  const old = db(); old.setMeta('experiment_started_at','123');
  expect(() => lockSeason(old,rules)).toThrow('fresh');
});
it('exposes only aggregate archive fields and fails closed for malformed archives', () => {
  const d = db();
  d.setMeta('derby_archives',JSON.stringify([{season:'01',title:'Crypto pilot',endedAt:123,secret:'hidden',bots:[{name:'Ferdi',equityUsd:199,pnlUsd:-1,totalCostUsd:.02,shares:123,entryPrice:50}]}]));
  expect(publicArchives(d)).toEqual([{season:'01',title:'Crypto pilot',endedAt:123,bots:[{name:'Ferdi',equityUsd:199,pnlUsd:-1,totalCostUsd:.02}]}]);
  d.setMeta('derby_archives','not JSON'); expect(publicArchives(d)).toEqual([]);
});
