# Bot Derby architecture

`src/derby/index.ts` starts the stock application. `src/derby/decisions.ts` adapts shared market and account evidence to TypeSafe Jev and OpenAI Decisions. `src/derby/stocks/` owns market data, signals, paper execution, risk controls, benchmarks and season state. `derby-web/` is the read-only dashboard.

Both providers receive the same market capture and their own account state; contexts can diverge after different actions. Alpaca supplies IEX quotes, completed daily bars and the exchange session clock. No brokerage orders are submitted by the derby entrypoint.

SQLite persists decisions, costs, simulated portfolios and season metadata. Raw inputs are private and retained for seven days; public endpoints expose curated aggregates and actions. API failures never substitute another model. Code enforces risk limits and distinguishes required holds from discretionary choices.

Deploy with persistent storage, private server-side credentials and an HTTPS proxy. Adapt the examples in `deploy/derby/` to your own host. Verify API access, fresh market data, session gating and restart persistence before relying on unattended execution.

Root Docker files, `dashboard/` and older engine modules preserve the upstream crypto application. Follow the stock-season commands in the README for Bot Derby.
