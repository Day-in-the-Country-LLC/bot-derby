import { Db } from '../db.js';
import { derbyConfig } from './config.js';
import { DerbyDecisions, ROSTER } from './decisions.js';
const { providers } = derbyConfig();
const db = new Db(':memory:');
const client = new DerbyDecisions(providers, db);
for (const id of ROSTER) {
  const p = providers[id];
  const r = await client.decide({ key: id, strategy: 'This is an API connection test. Choose HOLD. Do not trade.', state: { connection_test: true }, menu: { HOLD: { desc: 'Pass the connection test without trading', intent: { kind: 'hold' } }, WAIT: { desc: 'Wait without trading', intent: { kind: 'hold' } } }, convictionLabels: ['weak','fair','strong','overwhelming'] });
  console.log(JSON.stringify({ bot: p.name, provider: p.provider, configured: !!p.apiKey, ok: r.ok, ...(r.ok ? { model: r.model, choice: r.choice, latencyMs: r.latencyMs, estimatedCostUsd: r.costUsd } : { reason: r.reason, code: r.error?.code }) }));
}
db.close();
