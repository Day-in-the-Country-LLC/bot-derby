# Deploy your own Bot Derby

The stock experiment uses `src/derby/` and `derby-web/`. Root Docker/compose files and `dashboard/` preserve the original crypto application and are not the stock deployment entrypoints.

## Build

Use Node 22.13+ and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Package `dist/`, `derby-web/`, `LICENSE` and `deploy/derby/` into your deployment bundle. Do not package credentials, `.git`, databases, development dependencies or private market evidence.

## Configure your host

The example Linux service uses a dedicated `botderby` account, `/opt/bot-derby/current` for the active release, `/var/lib/bot-derby` for persistent state and `/etc/bot-derby/runtime.env` for credentials. Adapt paths and resource limits for your host. `install-server.sh` targets Linux x86_64 and expects `/tmp/bot-derby-release.tar.gz`; inspect it before running as root.

Copy the settings from `.env.example` into your private runtime configuration. Supply TypeSafe, OpenAI and Alpaca paper-data credentials. Keep `COMPETITION_ENABLED=false` until setup is verified. Match `ENGINE_BIND=127.0.0.1` and `ENGINE_PORT=4318` to the reverse proxy. Set `DB_PATH` to a writable persistent path such as `/var/lib/bot-derby/stocks-season02-50k.sqlite`.

Keep the configuration root-readable with mode 0600 and use your secret manager for durable credential storage. Do not commit secrets or expose private state directories. Set `PUBLIC_DOMAIN` to your own domain; update the Caddy host before enabling HTTPS.

The example service runs the stock engine only. It does not place brokerage orders. Real provider API calls can cost money; review the configured spending limit before enabling the experiment.

## Verify and start

1. Verify both AI providers with `pnpm derby:check` and the stock feed with `pnpm stocks:check`. The AI check makes small paid calls; neither submits orders.
2. Check that the service can read its private configuration and write its persistent database. Start it disabled, inspect `/healthz`, and confirm the public scoreboard accurately reports setup state.
3. Configure DNS and validate Caddy for your own domain. The `publish-server.sh` helper expects the service already running on loopback and Caddy installed; it adds only this host and then enables the paper experiment.
4. Verify fresh in-session market data, correct session gating, API readiness and read-only routes. A successful HTTP health check alone does not prove the experiment is active.
5. Restart only this service and verify that season start, portfolios, history, costs and archives persist. Enable systemd boot start if you want unattended operation.

## Seasons and backups

Do not change model, starting balance or rule fingerprints on a running season. Start a separate database for a new experiment. `start-stock-season.py` and `prepare-50k-start.py` are historical migration helpers with strict preconditions, not routine installation steps.

Use SQLite's backup API or another consistent backup method; keep off-server copies. Do not copy only the main SQLite file while ignoring live WAL writes.

To stop scheduling without creating artificial fills:

```sh
sudo -u botderby touch /var/lib/bot-derby/close-stock-derby
# Or stop the service:
sudo systemctl stop bot-derby
```

This preserves open paper positions at their last recorded valuation. Removing a stop marker and restarting resumes the same season only with compatible settings.
