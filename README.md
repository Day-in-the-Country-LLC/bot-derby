# Bot Derby: Ferdi vs Bodi

Public scoreboard: **https://botderby.dayinthecountry.co**

Source code: [Day-in-the-Country-LLC/bot-derby](https://github.com/Day-in-the-Country-LLC/bot-derby).

Built by Kristin Day / Day in the Country. Meet Ferdi (TypeSafe Jev) and Bodi (OpenAI Decisions): two decision engines competing in a controlled paper-trading experiment.

Inspired by [Mike Russell / Creator Magic's YouTube experiment](https://www.youtube.com/watch?v=8ijN8LGljKg) and adapted from his [beebots](https://github.com/imikerussell/beebots), MIT licensed. Upstream commit: `6cf999a224e67c7e2b6a74be0a064c409523d519`. The original README is preserved in [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).

Season 02 is a **stocks-only paper-trading experiment**. Ferdi and Bodi each start with $50,000 of simulated cash. They use the same stock data, menu construction, execution model and trading limits; their own portfolio states diverge as they make different choices. These changes improve the experiment's controls and reporting. They do not establish that either bot will make a profit.

| Bot | Decision API | Model |
| --- | --- | --- |
| Ferdi | TypeSafe `/v1/systemone` | `jev-1.13.0` |
| Bodi | OpenAI `/v1/decisions` | `gpt-6-luna` |

The current code requires stock-data credentials as well as the two AI keys. A reachable website or successful unit tests do not prove the stock competition is active. Check the public state, market timestamp and cloud verification steps below; `awaiting_market_data` means stock data setup is incomplete.

## Markets, schedule and evidence

The fixed universe is **AAPL, MSFT, NVDA, AMZN and GOOGL**. The Alpaca feed uses free IEX data, not consolidated all-exchange quotes or the national best bid and offer (NBBO). This distinction matters when interpreting quoted spreads and simulated fills. An Alpaca account's paper API key and secret are required for the market clock and data endpoints. The application makes read-only market requests; it does not place Alpaca orders or use brokerage balances.

The engine schedules a cycle every **10 seconds**, and asks both providers concurrently only while Alpaca reports an actual regular U.S. trading session and the necessary data is fresh. Holidays and early closes follow the market clock. A standard 6.5-hour session permits approximately **2,340 requests per bot** before interruptions; there are no scheduled AI decision requests overnight or on closed-market days. Existing positions can remain open overnight. No paper fills are manufactured outside the regular session, and an overnight gap can exceed a stop price.

Signals use up to **420 completed daily bars**, with at least **361** required for every stock. The nine Donchian lookbacks are 5, 10, 20, 30, 60, 90, 150, 250 and 360 trading bars. The current day's unfinished bar is excluded. Historical signals refresh for the next New York trading date; quotes and market-session status refresh during scheduled cycles. This is daily trend following observed frequently, not a new independent signal every ten seconds.

Each provider receives the same captured market evidence and instructions:

- Private bid/ask/latest-trade evidence, quote age and spread for the five stocks.
- Completed-bar trend score, number of available trend windows, 14-bar ATR, annualized volatility over 90 daily returns, one- and five-day returns, and prior completed close.
- Its own cash, equity, current position exposure, position return, distance to its stop, entries this session and active restrictions.
- The legal action menu, conviction scale and relevant execution rules.

The providers do not receive each other's portfolio, news feeds, browsing tools, prior conversation or a training loop. The application stores decision evidence privately for audit; the public API returns aggregate performance and curated action descriptions, never raw stock quotes, candles, execution prices or share counts.

## Trading limits

| Rule | Season 02 behavior |
| --- | --- |
| Direction and funding | Cash-funded, long-only fractional shares; no shorting, leverage or borrowed funds |
| Holdings | At most one stock position per competing bot; no adding to a position |
| New entry size | Up to 95% of current equity, further limited by available cash and fees |
| Entry signal | All nine trend windows available, positive trend score at least 3, valid ATR and acceptable fresh quote |
| Entry pace | At most two new entries per session; four elapsed hours between entries |
| Entry spread | At most 25 basis points, or 0.25% |
| AI entry gate | Selected action probability at least 0.55 and conviction at least `fair` |
| Position choices | Hold, sell half, or close; new buys appear only when permitted |
| Price protection | Initial stop two ATRs below entry; subsequent stop can tighten, never loosen |
| Session loss protection | At 8% loss relative to that session's starting equity, close when valid market execution is possible and stop opening that session |
| Retirement | At 60% loss from the original starting balance ($20,000 remaining from $50,000), retire from new entries and close an existing position when execution is possible |
| Data protection | Invalid, missing or stale evidence prevents discretionary execution; suspicious overnight discontinuities pause the affected account for review |

The model chooses from permitted actions. Code sizes positions and enforces all limits, including rechecking the session and quote before executing an API response. Weak or absent trends leave the bot in cash; no rule forces a trade just to make the competition active.

A request with multiple legal actions is counted as an **AI choice**. When hold is the only legal action, both APIs assess signal strength but cannot change the required hold; these are counted separately as **required-hold assessments**. **Protective exits** are attributed to code. API failures, invalid answers and provider backoff produce no discretionary trade and never substitute a different model. Option probabilities describe the choice distribution, not a calibrated probability of profit.

## Accounting and comparisons

Paper buys execute at the IEX ask plus 5 basis points of modeled slippage; sells execute at the bid minus 5 basis points. Both sides also pay a modeled 5-basis-point fee. These are experiment assumptions, not a claim about actual brokerage commissions. Open positions are marked at the bid/ask midpoint.

The scoreboard distinguishes:

- Portfolio equity and trading return after modeled execution costs, **before** AI API costs. The history chart uses this measure.
- Net portfolio equivalent and net P&L after subtracting estimated API costs. These are comparison measures; API charges do not withdraw simulated trading cash.
- Maximum observed decline from a previous portfolio peak, completed trades, AI choices, required holds and protective exits. Selling half is an order but does not complete a trade; a full position close does.

Before the first session, the scoreboard shows each bot’s initial cash and a live countdown to the next opening reported by Alpaca. The countdown uses the exchange calendar and does not start trading by itself; session and data checks still control execution.

The history chart uses solid green for Ferdi and dashed purple for Bodi so both remain visible when their returns overlap. Legend samples share the plotted line styles, including benchmark patterns. Select a legend name to show or hide that series; the time and return axes remain fixed to the full selected range for consistent comparison.

Each bot card has a collapsible **Current holdings** section showing the current stock ticker, its paper position value and uninvested cash. It reports no stocks held when the bot is entirely in cash, and stays expanded across automatic updates. The current rules allow one stock position per bot; the public view continues to omit share quantities and individual stock prices.

Three benchmarks each start with the same $50,000 alongside the stock season. They are reference portfolios, not extra AI contestants:

| Benchmark | Behavior |
| --- | --- |
| Cash | Retains $50,000 without interest |
| Equal-weight buy and hold | Invests 95% initially, equally across the five stocks, with the same modeled entry costs; holds without rebalancing |
| Rules only | Buys the highest-scoring permitted positive trend, using alphabetical ticker order to break ties; exits if its trend score is zero or negative. Uses the bots' entry, sizing, cooldown, stop, loss and retirement constraints without an AI bill |

There is no futures funding charge. Dividends, interest, taxes, queue priority, market impact and actual broker fills are not modeled. Daily history is split-adjusted, but held fractional quantities are not automatically reconciled for corporate actions. The feed compares raw and split-adjusted closes for the same completed bar and refreshes this check at the opening session. An intervening split, suspicious overnight discontinuity, or missed whole trading session pauses affected valuations/trading for review. Historical corrections and realistic execution still require judgment; paper results do not predict live performance.

## Local development

Node 22.13+ (built-in SQLite), pnpm 10.34.5:

```sh
git clone https://github.com/Day-in-the-Country-LLC/bot-derby.git
cd bot-derby
pnpm install --frozen-lockfile
cp .env.example .env
# Fill in the two AI keys and Alpaca paper data key/secret.
# Keep COMPETITION_ENABLED=false for a preview without scheduled calls.
pnpm dev
# http://127.0.0.1:8080
pnpm derby:check    # tiny real AI connection requests; no trades
pnpm stocks:check   # read-only stock feed/clock check; no AI calls or orders
pnpm typecheck
pnpm test
pnpm build
```

Set `COMPETITION_ENABLED=true` to enable the stock engine. Both AI keys and both stock-data credential fields must be present; actual provider entitlement, session and data freshness must also pass. `MODE=live`, `MODE=demo` and `DRY_RUN=false` are rejected. Keep `.env` private. Do not run the same season independently on two hosts.

Use the derby commands above. The root `docker-compose.yml`, `Dockerfile`, `dashboard/` and `legacy:*` scripts preserve the original three-bee application and are not Bot Derby entrypoints. Deployment files are in `deploy/derby/`.

## API costs

`BOT_DAILY_USD_CAP=unlimited` disables the application's daily AI spending cutoff. Costs are recorded in a durable ledger, including conservative reservations when a response is interrupted or usage is unknown. A finite nonnegative value restores a daily estimated threshold; zero blocks paid requests.

A five-second request timeout, provider failure/backoff, an in-flight cycle, missing/stale market evidence or a closed session can interrupt the request schedule. Required holds still incur paid signal assessments during an eligible session. The previous crypto season's per-cycle cost estimate should not be reused for the larger stock input.

Costs are estimates, not guaranteed invoice amounts. Provider pricing, framing, caching and unknown usage can differ. Check provider billing dashboards for actual charges. Sources: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [TypeSafe API](https://docs.typesafe.ai/api).

## Cloud runtime and seasons

Run your own instance on a host with persistent storage and Node 22.13+; cloud hosting lets it run while your laptop is off. The included systemd and Caddy files are examples to adapt to your own server and domain. See [the deployment guide](deploy/derby/DEPLOYMENT.md).

Start each new season with a fresh SQLite database. Preserve earlier seasons separately and carry over only sanitized aggregate archive summaries. The engine rejects incompatible changes to a started season's rules or models. Back up the database consistently, including WAL state, to a separate location.

The close marker stops scheduling; it is not a liquidation order. Stopped positions retain their last recorded valuation. Verify market data, both decision APIs, the exchange session clock, and persistence before relying on unattended execution.

## Project provenance

This public release starts from Bot Derby source revision `370940804139f761ddb1708ac8194d5a19ac33ab`, adapted from upstream beebots revision `6cf999a224e67c7e2b6a74be0a064c409523d519`. It includes the stock-season engine, read-only dashboard, collapsible holdings, tests and deployment examples. Private runtime data, credentials and operator-specific deployment notes are excluded.

Mike Russell's original MIT copyright and license are preserved in [LICENSE](LICENSE). The vendored OKX client keeps its own [license](src/okx/kit/LICENSE). The original three-bee application remains as legacy reference code; the Bot Derby entrypoints above are the supported path for this experiment.
