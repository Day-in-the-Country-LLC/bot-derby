#!/bin/bash
set -euo pipefail
# Install only this application, isolated from the existing site. Run as root.
id botderby >/dev/null 2>&1 || useradd --system --home-dir /var/lib/bot-derby --shell /usr/sbin/nologin botderby
install -d -m 755 /opt/bot-derby /opt/bot-derby/releases
install -d -m 700 /etc/bot-derby
install -d -o botderby -g botderby -m 700 /var/lib/bot-derby
if [ ! -x /opt/bot-derby/node/bin/node ]; then
  curl -fsSL https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz -o /tmp/bot-derby-node.tar.xz
  echo '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  /tmp/bot-derby-node.tar.xz' | sha256sum -c -
  install -d -m 755 /opt/bot-derby/node
  tar -xJf /tmp/bot-derby-node.tar.xz -C /opt/bot-derby/node --strip-components=1
  rm /tmp/bot-derby-node.tar.xz
fi
release="/opt/bot-derby/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$release"
tar -xzf /tmp/bot-derby-release.tar.gz -C "$release"
cp "$release/deploy/derby/runtime-package.json" "$release/package.json"
PATH=/opt/bot-derby/node/bin:$PATH npm --prefix "$release" install --omit=dev --ignore-scripts --no-audit --no-fund
ln -sfn "$release" /opt/bot-derby/current
install -m 644 "$release/deploy/derby/bot-derby.service" /etc/systemd/system/bot-derby.service
systemctl daemon-reload
/opt/bot-derby/node/bin/node --version
printf 'Bot Derby release installed; credentials and start remain separate.\n'
