#!/bin/bash
set -euo pipefail
curl -fsS http://127.0.0.1:4318/healthz >/dev/null
domain="${PUBLIC_DOMAIN:?Set PUBLIC_DOMAIN to your own hostname}"
if ! [[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]]; then
  echo 'Invalid PUBLIC_DOMAIN' >&2
  exit 1
fi
if ! grep -Fq "$domain {" /etc/caddy/Caddyfile; then
  cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-bot-derby
  cat /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.bot-derby-candidate
  sed "s/botderby.example.com/$domain/g" /opt/bot-derby/current/deploy/derby/Caddyfile >> /etc/caddy/Caddyfile.bot-derby-candidate
  caddy validate --config /etc/caddy/Caddyfile.bot-derby-candidate --adapter caddyfile
  mv /etc/caddy/Caddyfile.bot-derby-candidate /etc/caddy/Caddyfile
  systemctl reload caddy
fi
# Enable paper decisions. Alpaca credentials are used only for market data.
sed -i 's/^COMPETITION_ENABLED=false$/COMPETITION_ENABLED=true/' /etc/bot-derby/runtime.env
systemctl restart bot-derby
systemctl is-active bot-derby
