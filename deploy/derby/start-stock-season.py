#!/usr/bin/env python3
"""One-time, local-on-server season transition. Run as root BEFORE activating the stocks release.
Archives the stopped crypto DB and public closing values. Never prints credentials.
Existing stocks DB is never reset. Runtime keys are delivered separately via stdin.
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import time

root = Path('/var/lib/bot-derby')
old_path = root / 'competition.sqlite'
new_path = root / 'stocks-season02.sqlite'
env_path = Path('/etc/bot-derby/runtime.env')
if new_path.exists():
    raise SystemExit('Stock-season database already exists; refusing to reset or re-archive.')
if not old_path.exists() or not env_path.exists():
    raise SystemExit('Expected existing Bot Derby database and runtime configuration.')
# Credentials are kept outside release bundles and the public archive.
shutil.copy2(env_path, env_path.with_name('runtime.env.before-stocks'))
os.chmod(env_path.with_name('runtime.env.before-stocks'), 0o600)
subprocess.run(['systemctl', 'stop', 'bot-derby'], check=True)
ended = int(time.time() * 1000)
archive = root / 'archives' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-crypto-season01')
archive.mkdir(mode=0o700, parents=True)
old = sqlite3.connect(old_path)
backup = sqlite3.connect(archive / 'competition.sqlite')
old.backup(backup)
backup.close()
os.chmod(archive / 'competition.sqlite', 0o600)
(archive / 'previous-release.txt').write_text(str(Path('/opt/bot-derby/current').resolve()) + '\n')
rule_row = old.execute("SELECT v FROM meta WHERE k='derby_rules'").fetchone()
start = json.loads(rule_row[0])['startEquityUsd'] if rule_row else 200
bots = []
for bot_id, name in [('bee1', 'Ferdi'), ('bee2', 'Bodi')]:
    row = old.execute('SELECT equity_usd FROM equity_snapshots WHERE bee=? ORDER BY ts DESC,rowid DESC LIMIT 1', (bot_id,)).fetchone()
    equity = row[0] if row else start
    cost = old.execute('SELECT COALESCE(SUM(charged_usd),0) FROM chooser_spend WHERE bee=?', (bot_id,)).fetchone()[0]
    bots.append(dict(name=name, equityUsd=equity, pnlUsd=equity-start, totalCostUsd=cost))
summary = dict(season='01', title='Crypto pilot · closing portfolio values', endedAt=ended, bots=bots)
(archive / 'public-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
old.close()
new = sqlite3.connect(new_path)
# Existing Db meta contract: app-owned key/value metadata, never market-data rows.
new.execute('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
new.execute('INSERT INTO meta(k,v) VALUES (?,?)', ('derby_archives', json.dumps([summary])))
new.commit()
new.close()
account = pwd.getpwnam('botderby')
os.chown(new_path, account.pw_uid, account.pw_gid)
os.chmod(new_path, 0o600)
lines = env_path.read_text().splitlines()
updates = {'DB_PATH':str(new_path), 'COMPETITION_ENABLED':'true', 'BEE_START_EQUITY_USD':'200', 'TICK_MS':'10000', 'BOT_DAILY_USD_CAP':'unlimited'}
lines = [line for line in lines if line.split('=',1)[0] not in updates]
lines += [key+'='+value for key,value in updates.items()]
env_path.write_text('\n'.join(lines)+'\n')
os.chmod(env_path,0o600)
print(json.dumps({'archived':str(archive),'newDatabase':str(new_path),'publicSummary':summary}))
print('Stock season prepared. Start bot-derby only after credential and release verification.')
