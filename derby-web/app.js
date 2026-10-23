const $ = (q, scope = document) => scope.querySelector(q);
const money = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const signedMoney = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${money(n)}` : '—';
const pct = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
const count = n => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
const set = (el, value) => { if (el) el.textContent = value; };
const names = { bee1: 'Ferdi', bee2: 'Bodi', cash: 'Cash', buy_hold: 'Stock basket', basket: 'Stock basket', rules: 'Rules only' };
const lineClasses = { bee1: 'ferdi-line', bee2: 'bodi-line', cash: 'cash-line', buy_hold: 'basket-line', basket: 'basket-line', rules: 'rules-line' };
const hiddenSeries = new Set();
const canonicalSeriesId = id => id === 'basket' ? 'buy_hold' : id;
const chartLayer = id => id === 'bee2' ? 2 : id === 'bee1' ? 1 : 0;
const labels = { ai_choice: 'AI choice', rules_required: 'Required hold', protective_exit: 'Protective exit · rules', api_unavailable: 'API unavailable · holding' };
let scoreboard = null, series = {}, days = 30, inFlight = false;
let serverClockOffset = 0, lastBoardReceivedAt = 0, connectionFailed = false;
const stateLabels = { paused: 'At the starting line · paused', awaiting_keys: 'Stock season setup · waiting for API access', awaiting_market_data: 'Stock season setup · waiting for market data', starting: 'Warming up stock market data', market_closed: 'Market closed · positions carried to the next session', stale: 'Market data delayed · trading paused', running: 'The race is on · stock paper trading', finished: 'Season finished', error: 'Competition unavailable · awaiting recovery' };
const marketTime = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Awaiting session calendar';
};
function renderCountdown() {
  const digits = $('#countdown-digits'), message = $('#countdown-message');
  const title = $('#market-clock-title'), detail = $('#market-clock-detail');
  const session = scoreboard?.session;
  const now = Date.now() + serverClockOffset;
  const hasOpening = Number.isFinite(session?.nextOpen) && session.nextOpen > 0;
  const showMessage = (heading, caption, value, open = false) => {
    digits.hidden = true; message.hidden = false;
    set(title, heading); set(detail, caption); set(message, value);
    $('.market-clock').classList.toggle('session-open', open);
  };
  if (!scoreboard) return showMessage('Checking the market clock.', 'The next regular session comes from the exchange calendar.', 'CHECKING SESSION');
  if (connectionFailed || Date.now() - lastBoardReceivedAt > 30000) return showMessage('Waiting for a fresh market clock.', hasOpening ? `Last reported opening: ${marketTime(session.nextOpen)}. Reconnecting to confirm.` : 'The session calendar is temporarily unavailable.', 'AWAITING UPDATE');
  if (!session || !Number.isFinite(session.checkedAt) || session.checkedAt <= 0) return showMessage('Market calendar not available yet.', 'The countdown will appear once the next regular session is confirmed.', 'CHECKING SESSION');
  const clockAgeLimit = session.isOpen ? 60000 : 120000;
  if (now - session.checkedAt > clockAgeLimit || session.checkedAt > now + 5000 || ['stale', 'error'].includes(scoreboard.state)) return showMessage('Waiting for a fresh market clock.', 'The market feed needs an update before the session can be confirmed.', 'AWAITING UPDATE');
  if (session.isOpen) {
    if (Number.isFinite(session.nextClose) && session.nextClose > now) return showMessage('The regular session is open.', `Scheduled close: ${marketTime(session.nextClose)}.`, 'MARKET OPEN', true);
    return showMessage('Confirming the market session.', 'Waiting for the market clock to confirm the next session.', 'CHECKING SESSION');
  }
  if (!hasOpening) return showMessage('Market calendar not available yet.', 'The countdown will appear once the next regular session is confirmed.', 'CHECKING SESSION');
  if (session.nextOpen <= now) return showMessage('The scheduled opening has arrived.', 'Waiting for the market clock to confirm the session is open.', 'CONFIRMING OPEN');
  const remaining = Math.max(0, Math.ceil((session.nextOpen - now) / 1000));
  const values = { days: Math.floor(remaining / 86400), hours: Math.floor(remaining / 3600) % 24, minutes: Math.floor(remaining / 60) % 60, seconds: remaining % 60 };
  digits.hidden = false; message.hidden = true;
  $('.market-clock').classList.remove('session-open');
  set(title, 'Until the opening bell.');
  set(detail, `Next regular session: ${marketTime(session.nextOpen)}.`);
  for (const [unit, value] of Object.entries(values)) set($(`#countdown-${unit}`), String(value).padStart(2, '0'));
  // This timer is deliberately not a live region: seconds should not interrupt screen-reader users.
  digits.setAttribute('aria-label', `${values.days} days, ${values.hours} hours, ${values.minutes} minutes, ${values.seconds} seconds until the regular market session opens`);
}
function renderBoard(s) {
  scoreboard = s;
  lastBoardReceivedAt = Date.now();
  if (Number.isFinite(s.ts)) serverClockOffset = s.ts - lastBoardReceivedAt;
  connectionFailed = false;
  renderCountdown();
  const rules = s.rules || {}, bots = Array.isArray(s.bots) ? s.bots : [];
  const seasonStarted = Number.isFinite(s.startedAt) && s.startedAt > 0;
  set($('#race-state'), s.state === 'market_closed' && !seasonStarted ? 'Market closed · waiting for the first session' : stateLabels[s.state] || 'Competition status unavailable');
  $('#status-dot').className = `dot ${s.state === 'running' ? 'live' : s.state === 'error' || s.state === 'stale' ? 'offline' : ''}`;
  set($('#updated'), s.marketUpdatedAt ? `Market updated ${new Date(s.marketUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Stock results have not started');
  set($('#season-label'), `A DAY IN THE COUNTRY EXPERIMENT / ${`SEASON ${String(rules.season || '02').replace(/^season[-_ ]*/i, '').replaceAll('_', ' ').replaceAll('-', ' ').toUpperCase()}`}`);
  document.title = `${s.title || 'Bot Derby'} · Ferdi vs Bodi`;
  set($('#session-note'), 'Decisions and paper fills run only during regular sessions. The calendar respects holidays and early closes; positions may remain open overnight.');
  set($('#rule-start'), `${money(rules.startEquityUsd, 0)} each in paper money`);
  set($('#benchmark-start'), `SAME ${money(rules.startEquityUsd, 0)} START`);
  set($('#rule-symbols'), Array.isArray(rules.coins) ? rules.coins.join(' · ') : 'AAPL · MSFT · NVDA · AMZN · GOOGL');
  set($('#rule-feed'), `${rules.feed || 'Alpaca IEX'} · regular U.S. sessions`);
  set($('#rule-cadence'), `One cycle every ${rules.tickMs % 60000 === 0 ? `${rules.tickMs / 60000} minutes` : `${(rules.tickMs || 10000) / 1000} seconds`} while open`);
  set($('#rule-budget'), bots[0]?.dailyCapUsd == null ? 'No daily spending cutoff · costs tracked' : `${money(bots[0].dailyCapUsd, 2)} per bot per UTC day (estimated)`);
  const risk = rules.risk || {};
  if (Number.isFinite(risk.maxExposurePct)) set($('#rule-exposure'), `Cash only · long fractional shares · no leverage · at most ${risk.maxExposurePct}% invested`);
  if (Number.isFinite(risk.maxEntriesPerSession) && Number.isFinite(risk.entryCooldownMs)) set($('#rule-entries'), `${risk.maxEntriesPerSession} new entries per session · ${risk.entryCooldownMs / 3600000}-hour cooldown`);
  if (Number.isFinite(risk.dailyLossStopPct) && Number.isFinite(risk.stopAtrMult)) set($('#rule-protection'), `${risk.dailyLossStopPct}% daily loss stop · ${risk.stopAtrMult}× ATR price stop`);
  if (Number.isFinite(risk.retireDrawdownPct)) set($('#rule-retirement'), `Stop the bot at ${risk.retireDrawdownPct}% loss from starting balance`);
  if (Number.isFinite(risk.feeRate) && Number.isFinite(risk.slippageBps)) set($('#rule-costs'), `${Number((risk.feeRate * 10000).toFixed(2))} bps modeled fee + ${risk.slippageBps} bps slippage per side`);
  if (Number.isFinite(risk.spreadGateBps)) set($('#rule-spread'), `At most ${risk.spreadGateBps} basis points (${(risk.spreadGateBps / 100).toFixed(2)}%)`);
  const portfolios = seasonStarted ? bots.filter(b => Number.isFinite(b.portfolio?.equityUsd)) : [];
  const high = portfolios.length ? Math.max(...portfolios.map(b => b.portfolio.equityUsd)) : null;
  const tie = portfolios.length === 2 && Math.abs(portfolios[0].portfolio.equityUsd - portfolios[1].portfolio.equityUsd) < 0.005;
  for (const b of bots) {
    const card = document.getElementById(b.id), p = b.portfolio;
    if (!card) continue;
    const m = p?.metrics || {};
    const netPnl = seasonStarted ? p?.netPnlUsd ?? m.netPnlUsd : undefined;
    const netEquity = seasonStarted ? p?.netEquityUsd ?? m.netEquityUsd : undefined;
    const drawdown = seasonStarted ? p?.maxDrawdownPct ?? m.maxDrawdownPct : undefined;
    set($('.model', card), `${b.provider === 'jev' ? 'TypeSafe Jev' : 'OpenAI Decisions'} · ${b.model || ''}`);
    set($('.standing', card), !seasonStarted || !p ? 'AWAITING START' : tie ? 'LEVEL' : p.equityUsd === high ? 'PORTFOLIO LEAD' : 'IN PURSUIT');
    set($('.equity', card), money(p?.equityUsd ?? (!seasonStarted ? rules.startEquityUsd : undefined)));
    const pnl = $('.pnl', card);
    set(pnl, seasonStarted && p ? `${signedMoney(p.pnlUsd)} / ${pct(p.pnlPct)} before API costs` : `${money(rules.startEquityUsd, 0)} starting balance · not started`);
    pnl.classList.toggle('negative', seasonStarted && !!p && p.pnlUsd < 0);
    set($('.net-pnl', card), signedMoney(netPnl));
    $('.net-pnl', card).classList.toggle('negative', Number.isFinite(netPnl) && netPnl < 0);
    set($('.net-equity', card), seasonStarted ? `Net portfolio equivalent · ${money(netEquity)}` : 'Net performance begins with the first session');
    set($('.trades', card), count(p?.totals?.completedTrades));
    set($('.drawdown', card), Number.isFinite(drawdown) ? `${Math.abs(drawdown).toFixed(2)}%` : '—');
    set($('.choices', card), count(m.meaningfulChoices));
    set($('.holds', card), count(m.holdAssessments));
    set($('.exits', card), count(m.protectiveExits));
    set($('.calls', card), count(b.successfulCalls));
    set($('.cost', card), money(b.totalCostUsd, 4));
    set($('.latency', card), b.meanLatencyMs == null ? '—' : `${Math.round(b.meanLatencyMs)} ms`);
    set($('.position', card), p?.position ? `LONG ${p.position.symbol || p.position.coin}` : p ? 'Cash · no open position' : 'Portfolio unavailable');
    renderHoldings(card, p, seasonStarted);
    set($('.provider-status', card), !b.ready ? 'API access needed' : b.budgetPaused ? 'Daily API budget reached' : b.lastError ? 'API unavailable · holding' : s.state === 'running' ? 'Ready' : s.state === 'market_closed' ? 'Between sessions' : 'Waiting');
    const last = seasonStarted ? p?.last : null;
    const who = last?.decidedBy === 'openai' ? 'OpenAI' : last?.decidedBy === 'jev' ? 'Jev' : 'Rules';
    set($('.last-action', card), last ? `${labels[last.attribution] || who}: ${last.status || 'Waiting'}` : 'The first stock decision will appear here.');
  }
  renderBenchmarks(seasonStarted ? s.benchmarks || [] : []);
  renderArchives(s.archives || []);
  drawChart();
}
function renderHoldings(card, portfolio, seasonStarted) {
  // Keep the native details element and its rows in place: polling must preserve the visitor's open/closed choice.
  const section = $('.holdings', card);
  const position = portfolio?.position;
  const available = !!portfolio;
  set($('.holdings-count', section), !available ? 'Unavailable' : position ? '1 stock' : seasonStarted ? 'None' : 'Not started');
  const empty = $('.holdings-empty', section);
  empty.hidden = !!position;
  set(empty, !available ? 'Portfolio data is not available yet.' : seasonStarted ? 'No open stock holdings. This bot is currently in cash.' : 'No holdings yet. Trading has not started.');
  $('.holdings-list', section).hidden = !available;
  $('.holding-stock', section).hidden = !position;
  set($('.holding-symbol', section), position ? position.symbol || position.coin || 'Stock position' : '—');
  set($('.holding-value', section), money(position?.sizeUsd));
  set($('.holding-cash-value', section), money(portfolio?.cashUsd));
}
function renderBenchmarks(benchmarks) {
  const body = $('#benchmarks');
  body.replaceChildren();
  if (!benchmarks.length) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'table-empty'; set(cell, 'Benchmarks begin with the stock season.'); row.append(cell); body.append(row); return;
  }
  for (const b of benchmarks) {
    const row = document.createElement('tr');
    for (const [i, value] of [b.name || names[b.id] || 'Benchmark', money(b.equityUsd), `${signedMoney(b.pnlUsd)} / ${pct(b.pnlPct)}`, Number.isFinite(b.maxDrawdownPct) ? `${Math.abs(b.maxDrawdownPct).toFixed(2)}%` : '—', count(b.completedTrades ?? b.totals?.completedTrades)].entries()) {
      const cell = document.createElement(i === 0 ? 'th' : 'td'); if (i === 0) cell.scope = 'row'; set(cell, value); if (i === 2 && b.pnlUsd < 0) cell.className = 'negative'; row.append(cell);
    }
    body.append(row);
  }
}
let lastArchiveContent = null;
function renderArchives(archives) {
  // Polling should not collapse an archive the visitor is reading.
  const content = JSON.stringify(archives);
  if (content === lastArchiveContent) return;
  lastArchiveContent = content;
  $('#archive-panel').hidden = !archives.length;
  const list = $('#archives'); list.replaceChildren();
  for (const a of archives) {
    const details = document.createElement('details'), summary = document.createElement('summary'), info = document.createElement('p'), grid = document.createElement('div');
    set(summary, a.title || a.season || 'Earlier season');
    info.className = 'archive-note'; set(info, a.endedAt ? `Ended ${new Date(a.endedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · separate paper-trading results` : 'Archived paper-trading results');
    grid.className = 'archive-grid';
    for (const b of a.bots || []) {
      const box = document.createElement('div'), name = document.createElement('strong'), balance = document.createElement('p'), costs = document.createElement('small');
      set(name, b.name); set(balance, `${money(b.equityUsd)} portfolio · ${signedMoney(b.pnlUsd)} trading P&L`); set(costs, `${money(b.totalCostUsd, 4)} estimated API costs, shown separately`); box.append(name, balance, costs); grid.append(box);
    }
    details.append(summary, info, grid); list.append(details);
  }
}
const svgElement = (tag, attrs, text) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
};
function drawChart() {
  const svg = $('#chart'); svg.replaceChildren();
  const cutoff = Date.now() - days * 86400000;
  const entries = Object.entries(series).filter(([id, points]) => id in names && Array.isArray(points)).map(([id, points]) => [id, points.filter(p => Array.isArray(p) && p.length >= 2 && p[0] >= cutoff && Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0])]);
  const all = entries.flatMap(([, points]) => points);
  const initial = scoreboard?.rules?.startEquityUsd;
  const hasHistory = all.length > 1 && new Set(all.map(p => p[0])).size > 1 && Number.isFinite(initial) && initial > 0;
  const visibleEntries = entries.filter(([id, points]) => points.length && !hiddenSeries.has(canonicalSeriesId(id)));
  const empty = $('#chart-empty');
  empty.hidden = hasHistory && visibleEntries.length > 0;
  if (!hasHistory || !visibleEntries.length) {
    set($('h3', empty), hasHistory ? 'All chart lines are hidden.' : 'Waiting for stock-season results.');
    set($('p', empty), hasHistory ? 'Select a legend label above to show its portfolio history.' : 'History begins when market data is ready and the session opens. The earlier crypto season stays in its own archive.');
    svg.setAttribute('aria-label', hasHistory ? 'Portfolio chart: all lines are hidden' : 'Portfolio chart: no stock-season history yet');
    return;
  }
  svg.setAttribute('aria-label', `Portfolio return history for ${visibleEntries.map(([id]) => names[id]).join(', ')}`);
  // Keep the axes based on all available series so a visibility toggle cannot exaggerate a move.
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0]), x0 + 60000);
  const returns = all.map(p => (p[1] / initial - 1) * 100);
  let lo = Math.min(0, ...returns), hi = Math.max(0, ...returns);
  const pad = Math.max(.1, (hi - lo) * .12); lo -= pad; hi += pad;
  const x = t => 56 + (t - x0) / (x1 - x0) * 925;
  const y = v => 235 - (v - lo) / (hi - lo) * 210;
  for (let i = 0; i <= 4; i++) {
    const val = lo + (hi - lo) * i / 4;
    svg.append(svgElement('line', { x1: 56, y1: y(val), x2: 981, y2: y(val), class: 'grid-line' }));
    svg.append(svgElement('text', { x: 0, y: y(val) + 4 }, `${val.toFixed(2)}%`));
  }
  for (const [id, points] of [...visibleEntries].sort(([a], [b]) => chartLayer(a) - chartLayer(b))) {
    if (!points.length) continue;
    const path = svgElement('path', { class: `chart-line ${lineClasses[id]}`, d: points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y((v / initial - 1) * 100).toFixed(1)}`).join(' ') });
    path.append(svgElement('title', {}, `${names[id]} portfolio return`));
    svg.append(path);
  }
  const stamp = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  svg.append(svgElement('text', { x: 56, y: 266 }, stamp(x0)));
  svg.append(svgElement('text', { x: 981, y: 266, 'text-anchor': 'end' }, stamp(x1)));
}
function renderActivity(events) {
  const list = $('#activity');
  const display = (Array.isArray(events) ? events : []).filter(e => ['bee1', 'bee2'].includes(e.botId || e.bee)).sort((a, b) => b.ts - a.ts).slice(0, 30);
  list.replaceChildren();
  if (!display.length) { const empty = document.createElement('li'); empty.className = 'empty-activity'; set(empty, 'No stock decisions recorded yet. The first session will appear here.'); list.append(empty); return; }
  for (const event of display) {
    const id = event.botId || event.bee;
    const li = document.createElement('li'), top = document.createElement('div'), bot = document.createElement('strong'), time = document.createElement('span'), detail = document.createElement('p'), tag = document.createElement('span');
    top.className = 'event-top'; bot.className = id === 'bee1' ? 'ferdi-text' : 'bodi-text'; time.className = 'event-time'; detail.className = 'event-detail'; tag.className = `event-kind ${event.attribution === 'protective_exit' ? 'protective' : ''}`;
    set(bot, names[id]); set(time, new Date(event.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })); set(tag, labels[event.attribution] || (event.type === 'fill' ? 'Paper fill' : 'Recorded action'));
    set(detail, [typeof event.action === 'string' ? event.action : event.choice, event.status || event.detail].filter(Boolean).join(' · ') || 'Waiting');
    top.append(bot, time); li.append(top, tag, detail); list.append(li);
  }
}
async function get(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error('Scoreboard unavailable');
  return response.json();
}
async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const [board, history, events] = await Promise.all([get('/api/scoreboard'), get('/api/equity'), get('/api/activity')]);
    series = history; renderBoard(board); renderActivity(events);
  } catch {
    connectionFailed = true;
    renderCountdown();
    set($('#race-state'), 'Connection interrupted · showing last received results');
    $('#status-dot').className = 'dot offline';
    set($('#updated'), scoreboard ? `Last received ${new Date(scoreboard.ts).toLocaleTimeString()}` : 'The scoreboard is not available yet');
  } finally { inFlight = false; }
}
for (const button of document.querySelectorAll('[data-series]')) button.addEventListener('click', () => {
  const id = button.dataset.series;
  if (hiddenSeries.has(id)) hiddenSeries.delete(id); else hiddenSeries.add(id);
  button.setAttribute('aria-pressed', String(!hiddenSeries.has(id)));
  drawChart();
});
for (const button of document.querySelectorAll('[data-days]')) button.addEventListener('click', () => {
  days = Number(button.dataset.days);
  for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-pressed', String(b === button));
  drawChart();
});
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 10000);
setInterval(() => { if (!document.hidden) renderCountdown(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderCountdown(); refresh(); } });
