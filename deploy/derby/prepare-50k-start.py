#!/usr/bin/env python3
"""Prepare the untouched stock season for $50,000 per bot. Run as root, service STOPPED.

This helper never stops/starts a service, places orders, edits the source database,
or copies trading state into the new database. Any trading evidence aborts it.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import sqlite3
import stat
import subprocess
import tempfile
import time
from dataclasses import dataclass


class UnsafePreparation(RuntimeError):
    pass


@dataclass(frozen=True)
class Paths:
    source: Path
    target: Path
    environment: Path
    current_release: Path
    releases: Path
    archives: Path


PRODUCTION = Paths(
    source=Path('/var/lib/bot-derby/stocks-season02.sqlite'),
    target=Path('/var/lib/bot-derby/stocks-season02-50k.sqlite'),
    environment=Path('/etc/bot-derby/runtime.env'),
    current_release=Path('/opt/bot-derby/current'),
    releases=Path('/opt/bot-derby/releases'),
    archives=Path('/var/lib/bot-derby/archives'),
)
LEDGER_TABLES = {
    'decisions', 'orders', 'fills', 'funding', 'equity_snapshots', 'reconciliations',
    'caps', 'bee_state', 'events', 'chooser_spend',
}
EXPECTED_META = {'derby_rules', 'derby_rules_hash', 'derby_archives', 'stock_engine_v1'}
ACCOUNT_NAMES = {'bee1': 'Ferdi', 'bee2': 'Bodi', 'cash': 'Cash',
                 'buy_hold': 'Equal-weight buy and hold', 'rules': 'Rules only'}
AUDIT_KEY = 'stock_start_balance_preparation_v1'


def require(condition, message):
    if not condition:
        raise UnsafePreparation(message)


def numeric(value, expected=None):
    return type(value) in (int, float) and math.isfinite(value) and (expected is None or value == expected)


def require_stopped():
    result = subprocess.run(
        ['systemctl', 'show', 'bot-derby', '--property=LoadState', '--property=ActiveState',
         '--property=SubState', '--property=MainPID', '--property=ControlPID'],
        check=True, capture_output=True, text=True,
    )
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    require(fields.get('LoadState') == 'loaded' and fields.get('ActiveState') == 'inactive'
            and fields.get('SubState') == 'dead' and fields.get('MainPID') == '0'
            and fields.get('ControlPID') == '0',
            'bot-derby must already be stopped, inactive/dead, with no running or control process.')


def regular_file(path):
    require(path.exists() and not path.is_symlink() and stat.S_ISREG(path.stat().st_mode),
            'An expected regular file is missing or is a symlink.')
    require(path.resolve() == path, 'Unexpected symlink in a protected file path.')


def read_environment(path, expected_source):
    regular_file(path)
    content = path.read_bytes()
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        raise UnsafePreparation('Runtime configuration must be UTF-8.') from None
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        require(match is not None, 'Unexpected runtime configuration syntax; no changes made.')
        key, value = match.groups()
        require(key not in values, 'Duplicate runtime configuration key; no changes made.')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key] = value
    require(values.get('DB_PATH') == str(expected_source), 'Runtime DB_PATH is not the exact expected stock-season database.')
    require(values.get('BEE_START_EQUITY_USD') == '200', 'Runtime starting balance is not the expected untouched $200 setup.')
    require(values.get('MODE', 'dry') == 'dry' and values.get('DRY_RUN', 'true').lower() not in ('false', '0', 'no'),
            'Runtime is not paper-only.')
    return content


def validate_archives(value):
    require(isinstance(value, list) and len(value) <= 20, 'Invalid predecessor archive metadata.')
    for item in value:
        require(isinstance(item, dict) and set(item) == {'season', 'title', 'endedAt', 'bots'}, 'Unexpected predecessor archive fields.')
        require(isinstance(item['season'], str) and len(item['season']) <= 20
                and isinstance(item['title'], str) and len(item['title']) <= 120
                and numeric(item['endedAt']) and isinstance(item['bots'], list) and len(item['bots']) <= 2,
                'Invalid predecessor archive values.')
        for bot in item['bots']:
            require(isinstance(bot, dict) and set(bot) == {'name', 'equityUsd', 'pnlUsd', 'totalCostUsd'}, 'Unexpected predecessor bot fields.')
            require(isinstance(bot['name'], str) and len(bot['name']) <= 40
                    and all(numeric(bot[k]) for k in ('equityUsd', 'pnlUsd', 'totalCostUsd'))
                    and bot['totalCostUsd'] >= 0, 'Invalid predecessor bot values.')


def verify_account(account, expected_id):
    require(isinstance(account, dict), 'Missing stock account state.')
    required = {'id', 'name', 'cash', 'equity', 'peak', 'drawdown', 'position', 'basket', 'session',
                'dayStart', 'entries', 'lastEntryAt', 'cap', 'dataIssue', 'startedAt', 'totals', 'metrics', 'last'}
    require(set(account) == required, 'Unexpected stock account state fields; refusing to reinterpret them.')
    require(account['id'] == expected_id and account['name'] == ACCOUNT_NAMES[expected_id], 'Unexpected stock account identity.')
    require(all(numeric(account[k], 200) for k in ('cash', 'equity', 'peak', 'dayStart'))
            and numeric(account['drawdown'], 0) and numeric(account['entries'], 0), 'Stock balances or counters are no longer untouched.')
    require(all(account[k] is None for k in ('position', 'lastEntryAt', 'cap', 'dataIssue', 'startedAt'))
            and account['basket'] == [] and account['session'] == '', 'Stock season has started or contains holdings/risk state.')
    totals = account['totals']
    require(isinstance(totals, dict) and set(totals) == {'orders', 'completedTrades', 'feesUsd', 'realisedUsd', 'decisions'}
            and all(numeric(n, 0) for n in totals.values()), 'Stock account contains trading, fee, or decision activity.')
    metrics = account['metrics']
    require(isinstance(metrics, dict) and set(metrics) == {'meaningfulChoices', 'holdAssessments', 'protectiveExits'}
            and all(numeric(n, 0) for n in metrics.values()), 'Stock account contains prior assessments or protective actions.')
    last = account['last']
    require(isinstance(last, dict) and set(last) == {'at', 'attribution', 'status', 'decidedBy'}
            and numeric(last['at']) and last['at'] > 0 and last['attribution'] == 'rules_required'
            and last['decidedBy'] == 'rules'
            and last['status'] == 'Waiting for the first fresh regular market session', 'Stock account has a noninitial last action.')


def verify_pristine(connection):
    require(connection.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Source database integrity check failed.')
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    require(tables == LEDGER_TABLES | {'meta'}, 'Unexpected or incomplete source database schema.')
    for table in LEDGER_TABLES:
        # Table identifiers are a fixed internal allowlist, never supplied by the database or user.
        require(connection.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] == 0,
                'Source database contains ledger activity; refusing to reset a started experiment.')
    metadata = dict(connection.execute('SELECT k,v FROM meta'))
    require(set(metadata) == EXPECTED_META, 'Unexpected source metadata; refusing to discard history or state.')
    try:
        rules = json.loads(metadata['derby_rules'])
        state = json.loads(metadata['stock_engine_v1'])
        archives = json.loads(metadata['derby_archives'])
    except (ValueError, TypeError):
        raise UnsafePreparation('Source metadata is malformed.') from None
    require(isinstance(rules, dict) and rules.get('season') == '02' and rules.get('assetClass') == 'stocks'
            and numeric(rules.get('startEquityUsd'), 200), 'Source rules are not the expected $200 stock season 02.')
    require(hashlib.sha256(metadata['derby_rules'].encode()).hexdigest() == metadata['derby_rules_hash'], 'Source rules hash is inconsistent.')
    require(isinstance(state, dict) and set(state) == {'version', 'rulesHash', 'startedAt', 'accounts', 'benchmarks'}
            and type(state['version']) is int and state['version'] == 1 and state['startedAt'] is None,
            'Stock season was started or has an unexpected state version.')
    engine_rules = {k: v for k, v in rules.items() if k != 'providers'}
    engine_hash = hashlib.sha256(json.dumps(engine_rules, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    require(state['rulesHash'] == engine_hash, 'Stock engine rules differ from the public protocol.')
    require(isinstance(state['accounts'], dict) and set(state['accounts']) == {'bee1', 'bee2'}, 'Unexpected competitor roster.')
    require(isinstance(state['benchmarks'], dict) and set(state['benchmarks']) == {'cash', 'buy_hold', 'rules'}, 'Unexpected benchmark roster.')
    for identity, account in {**state['accounts'], **state['benchmarks']}.items():
        verify_account(account, identity)
    validate_archives(archives)
    return {'archives': archives, 'sourceRulesHash': metadata['derby_rules_hash']}


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_target_absent(target):
    require(not any(os.path.lexists(str(target) + suffix) for suffix in ('', '-wal', '-shm', '-journal')),
            'The destination database or an associated artifact already exists; refusing to overwrite it.')


def prepare(paths=PRODUCTION, service_check=require_stopped, owner=None, timestamp=None):
    """Dependency injection exists for local tests. The command-line entry point uses fixed production paths."""
    service_check()
    regular_file(paths.source)
    require(paths.source != paths.target and paths.source.parent == paths.target.parent, 'Unexpected destination path.')
    ensure_target_absent(paths.target)
    original_environment = read_environment(paths.environment, paths.source)
    release = paths.current_release.resolve(strict=True)
    require(release.is_dir() and release.parent == paths.releases.resolve(strict=True), 'Current release is outside the expected release directory.')
    if owner is None:
        account = pwd.getpwnam('botderby')
        owner = (account.pw_uid, account.pw_gid)
    source = sqlite3.connect(paths.source.as_uri() + '?mode=ro', uri=True)
    temporary_target = None
    temporary_environment = None
    try:
        evidence = verify_pristine(source)
        moment = time.time() if timestamp is None else timestamp
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(moment))
        require(not paths.archives.is_symlink(), 'Archive directory cannot be a symlink.')
        paths.archives.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(paths.archives.resolve() == paths.archives, 'Unexpected archive path.')
        backup_dir = paths.archives / (stamp + '-stock02-before-50k')
        backup_dir.mkdir(mode=0o700)  # Fails on collisions; never reuses an existing backup.
        os.chmod(backup_dir, 0o700)
        backup_db = backup_dir / paths.source.name
        with sqlite3.connect(backup_db) as backup:
            source.backup(backup)
        os.chmod(backup_db, 0o600)
        with sqlite3.connect(backup_db.as_uri() + '?mode=ro', uri=True) as backup:
            require(verify_pristine(backup) == evidence, 'Backup verification did not match the source.')
        private_write(backup_dir / 'runtime.env', original_environment)
        private_write(backup_dir / 'previous-release.txt', (str(release) + '\n').encode())
        audit = {
            'version': 1, 'preparedAt': int(moment * 1000), 'operation': 'increase_unstarted_stock_balances',
            'season': '02', 'fromStartingBalanceUsd': 200, 'toStartingBalanceUsd': 50000,
            'sourceDatabase': str(paths.source), 'destinationDatabase': str(paths.target),
            'backupDirectory': str(backup_dir), 'previousRelease': str(release),
            'sourceRulesHash': evidence['sourceRulesHash'], 'verifiedUnstarted': True,
            'preservedArchiveCount': len(evidence['archives']), 'serviceStartedByHelper': False,
        }
        private_write(backup_dir / 'preparation-audit.json', (json.dumps(audit, indent=2) + '\n').encode())
        sync_directory(backup_dir)

        descriptor, filename = tempfile.mkstemp(prefix='.stock02-50k-', suffix='.sqlite', dir=paths.target.parent)
        os.close(descriptor)
        temporary_target = Path(filename)
        with sqlite3.connect(temporary_target) as target:
            target.execute('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
            target.executemany('INSERT INTO meta(k,v) VALUES (?,?)', [
                ('derby_archives', json.dumps(evidence['archives'], separators=(',', ':'), ensure_ascii=False)),
                (AUDIT_KEY, json.dumps(audit, separators=(',', ':'))),
            ])
        os.chown(temporary_target, *owner)
        os.chmod(temporary_target, 0o600)
        with temporary_target.open('rb') as handle:
            os.fsync(handle.fileno())

        # Recheck immediately before publication. No service lifecycle command occurs in this helper.
        service_check()
        require(paths.environment.read_bytes() == original_environment, 'Runtime configuration changed during preparation; refusing to replace it.')
        require(verify_pristine(source) == evidence, 'Source changed during preparation; refusing to reset it.')
        ensure_target_absent(paths.target)
        os.link(temporary_target, paths.target)  # Atomic exclusive publication; never replaces a target.
        temporary_target.unlink()
        temporary_target = None
        sync_directory(paths.target.parent)

        updates = {'DB_PATH': str(paths.target), 'BEE_START_EQUITY_USD': '50000'}
        lines = original_environment.decode('utf-8').splitlines(keepends=True)
        for index, line in enumerate(lines):
            key = line.split('=', 1)[0]
            if key in updates:
                ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
                lines[index] = key + '=' + updates[key] + ending
        descriptor, filename = tempfile.mkstemp(prefix='.runtime.env-50k-', dir=paths.environment.parent)
        temporary_environment = Path(filename)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(''.join(lines).encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_environment, 0o600)
        require(paths.environment.read_bytes() == original_environment, 'Runtime configuration changed before commit; new database preserved but environment unchanged.')
        service_check()
        os.replace(temporary_environment, paths.environment)
        temporary_environment = None
        sync_directory(paths.environment.parent)
        return {'prepared': True, 'startingBalancePerBotUsd': 50000, 'database': str(paths.target),
                'backup': str(backup_dir), 'preservedArchiveCount': len(evidence['archives']), 'serviceStarted': False}
    finally:
        source.close()
        for path in (temporary_target, temporary_environment):
            if path is not None:
                path.unlink(missing_ok=True)


def main():
    require(os.geteuid() == 0, 'Run this helper as root after stopping bot-derby.')
    try:
        result = prepare()
    except UnsafePreparation as error:
        raise SystemExit(str(error) + ' No service was started.') from None
    except (sqlite3.Error, OSError, subprocess.SubprocessError):
        # Do not echo environment contents, provider credentials, or private database rows.
        raise SystemExit('Preparation refused or incomplete. No service was started. Review the stopped source and any new private backup/target artifacts before retrying.') from None
    print(json.dumps(result))
    print('Prepared only. Verify the new release and configuration before starting bot-derby.')


if __name__ == '__main__':
    main()
