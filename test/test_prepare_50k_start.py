"""Safety fixtures for the stopped, unstarted-stock-season balance preparation helper."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'derby' / 'prepare-50k-start.py'
SPEC = importlib.util.spec_from_file_location('prepare_50k_start', SCRIPT)
helper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = helper
SPEC.loader.exec_module(helper)


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def account(identity):
    return {'id': identity, 'name': helper.ACCOUNT_NAMES[identity], 'cash': 200, 'equity': 200,
            'peak': 200, 'drawdown': 0, 'position': None, 'basket': [], 'session': '', 'dayStart': 200,
            'entries': 0, 'lastEntryAt': None, 'cap': None, 'dataIssue': None, 'startedAt': None,
            'totals': {'orders': 0, 'completedTrades': 0, 'feesUsd': 0, 'realisedUsd': 0, 'decisions': 0},
            'metrics': {'meaningfulChoices': 0, 'holdAssessments': 0, 'protectiveExits': 0},
            'last': {'at': 1792700000000, 'attribution': 'rules_required',
                     'status': 'Waiting for the first fresh regular market session', 'decidedBy': 'rules'}}


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name).resolve()
        self.paths = helper.Paths(source=root / 'stocks-season02.sqlite', target=root / 'stocks-season02-50k.sqlite',
                                  environment=root / 'runtime.env', current_release=root / 'current',
                                  releases=root / 'releases', archives=root / 'archives')
        release = self.paths.releases / 'release-one'
        release.mkdir(parents=True)
        self.paths.current_release.symlink_to(release, target_is_directory=True)
        self.environment = (f'# private test configuration\nDB_PATH={self.paths.source}\n'
                            'BEE_START_EQUITY_USD=200\nCOMPETITION_ENABLED=true\nTICK_MS=10000\n'
                            'OPENAI_API_KEY=fake-test-openai-key\nALPACA_API_SECRET="fake=secret"\n').encode()
        self.paths.environment.write_bytes(self.environment)
        self.engine_rules = {'version': 3, 'season': '02', 'assetClass': 'stocks', 'startEquityUsd': 200,
                             'risk': {'feeRate': 0.0005, 'maxExposurePct': 95}}
        self.rules = {**self.engine_rules, 'providers': [{'name': 'Ferdi', 'provider': 'jev'}, {'name': 'Bodi', 'provider': 'openai'}]}
        self.state = {'version': 1, 'rulesHash': hashlib.sha256(encoded(self.engine_rules).encode()).hexdigest(),
                      'startedAt': None, 'accounts': {k: account(k) for k in ('bee1', 'bee2')},
                      'benchmarks': {k: account(k) for k in ('cash', 'buy_hold', 'rules')}}
        self.archives = [{'season': '01', 'title': 'Crypto pilot', 'endedAt': 1792700000000,
                          'bots': [{'name': 'Ferdi', 'equityUsd': 198, 'pnlUsd': -2, 'totalCostUsd': .1},
                                   {'name': 'Bodi', 'equityUsd': 200, 'pnlUsd': 0, 'totalCostUsd': .2}]}]
        with sqlite3.connect(self.paths.source) as db:
            db.execute('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT NOT NULL)')
            for table in helper.LEDGER_TABLES:
                db.execute('CREATE TABLE "' + table + '"(id INTEGER)')
            db.executemany('INSERT INTO meta VALUES (?,?)', [
                ('derby_rules', encoded(self.rules)),
                ('derby_rules_hash', hashlib.sha256(encoded(self.rules).encode()).hexdigest()),
                ('stock_engine_v1', encoded(self.state)), ('derby_archives', encoded(self.archives))])
        self.checks = 0

    def tearDown(self):
        self.directory.cleanup()

    def stopped(self):
        self.checks += 1

    def run_helper(self, check=None):
        return helper.prepare(self.paths, service_check=check or self.stopped,
                              owner=(os.getuid(), os.getgid()), timestamp=1792700000)

    def save_state(self):
        with sqlite3.connect(self.paths.source) as db:
            db.execute("UPDATE meta SET v=? WHERE k='stock_engine_v1'", (encoded(self.state),))

    def assert_refused_untouched(self, check=None):
        old_bytes = self.paths.source.read_bytes()
        with self.assertRaises(helper.UnsafePreparation):
            self.run_helper(check)
        self.assertEqual(self.paths.source.read_bytes(), old_bytes)
        self.assertEqual(self.paths.environment.read_bytes(), self.environment)
        self.assertFalse(self.paths.target.exists())

    def test_prepares_metadata_only_database_and_preserves_all_credentials_source_and_archive(self):
        before = self.paths.source.read_bytes()
        result = self.run_helper()
        self.assertEqual(self.checks, 3)
        self.assertTrue(result['prepared'])
        self.assertFalse(result['serviceStarted'])
        self.assertEqual(self.paths.source.read_bytes(), before)
        with sqlite3.connect(self.paths.target) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(tables, {'meta'})
            metadata = dict(db.execute('SELECT k,v FROM meta'))
            self.assertEqual(set(metadata), {'derby_archives', helper.AUDIT_KEY})
            self.assertEqual(json.loads(metadata['derby_archives']), self.archives)
            audit = json.loads(metadata[helper.AUDIT_KEY])
            self.assertEqual(audit['fromStartingBalanceUsd'], 200)
            self.assertEqual(audit['toStartingBalanceUsd'], 50000)
            self.assertTrue(audit['verifiedUnstarted'])
        expected = self.environment.replace(str(self.paths.source).encode(), str(self.paths.target).encode()).replace(b'BEE_START_EQUITY_USD=200', b'BEE_START_EQUITY_USD=50000')
        self.assertEqual(self.paths.environment.read_bytes(), expected)
        backup = Path(result['backup'])
        self.assertEqual((backup / 'runtime.env').read_bytes(), self.environment)
        self.assertEqual((backup / 'previous-release.txt').read_text().strip(), str(self.paths.current_release.resolve()))
        with sqlite3.connect(backup / self.paths.source.name) as db:
            self.assertEqual(helper.verify_pristine(db)['archives'], self.archives)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        for p in (self.paths.environment, self.paths.target, backup / 'runtime.env', backup / self.paths.source.name):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        self.assertNotIn('fake-test-openai-key', json.dumps(result))
        with self.assertRaises(helper.UnsafePreparation):
            self.run_helper()

    def test_refuses_running_service_without_making_any_files(self):
        def running():
            raise helper.UnsafePreparation('Service is running')
        self.assert_refused_untouched(running)
        self.assertFalse(self.paths.archives.exists())

    def test_refuses_global_or_account_started_flag(self):
        for location in ('global', 'bot', 'benchmark'):
            with self.subTest(location=location):
                pristine = copy.deepcopy(self.state)
                if location == 'global': self.state['startedAt'] = 1792700000001
                elif location == 'bot': self.state['accounts']['bee1']['startedAt'] = 1792700000001
                else: self.state['benchmarks']['cash']['startedAt'] = 1792700000001
                self.save_state(); self.assert_refused_untouched()
                self.state = pristine; self.save_state()

    def test_refuses_any_ledger_activity_even_if_state_claims_unstarted(self):
        for table in helper.LEDGER_TABLES:
            with self.subTest(table=table):
                with sqlite3.connect(self.paths.source) as db:
                    db.execute('INSERT INTO "' + table + '" VALUES (1)')
                self.assert_refused_untouched()
                with sqlite3.connect(self.paths.source) as db:
                    db.execute('DELETE FROM "' + table + '"')

    def test_refuses_orders_fees_assessments_holdings_drawdowns_and_resets_in_private_state(self):
        mutations = [
            lambda a: a.update(cash=199), lambda a: a.update(equity=199), lambda a: a.update(peak=201),
            lambda a: a.update(drawdown=.1), lambda a: a.update(entries=1),
            lambda a: a.update(lastEntryAt=1792700000000), lambda a: a.update(session='2026-10-22'),
            lambda a: a.update(position={'symbol': 'AAPL'}), lambda a: a.update(basket=[{'symbol': 'AAPL'}]),
            lambda a: a.update(cap='loss_stop'), lambda a: a['totals'].update(orders=1),
            lambda a: a['totals'].update(feesUsd=.01), lambda a: a['totals'].update(decisions=1),
            lambda a: a['metrics'].update(holdAssessments=1), lambda a: a['last'].update(status='Chose to hold'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                pristine = copy.deepcopy(self.state)
                mutate(self.state['accounts']['bee2']); self.save_state(); self.assert_refused_untouched()
                self.state = pristine; self.save_state()

    def test_refuses_unexpected_metadata_or_tables_and_inconsistent_rules_hash(self):
        with sqlite3.connect(self.paths.source) as db:
            db.execute("INSERT INTO meta VALUES ('experiment_started_at','1')")
        self.assert_refused_untouched()
        with sqlite3.connect(self.paths.source) as db:
            db.execute("DELETE FROM meta WHERE k='experiment_started_at'")
            db.execute('CREATE TABLE unexpected(id INTEGER)')
        self.assert_refused_untouched()
        with sqlite3.connect(self.paths.source) as db:
            db.execute('DROP TABLE unexpected')
            db.execute("UPDATE meta SET v='wrong' WHERE k='derby_rules_hash'")
        self.assert_refused_untouched()

    def test_refuses_existing_target_wal_or_dangling_symlink(self):
        for suffix in ('', '-wal', '-shm', '-journal'):
            path = Path(str(self.paths.target) + suffix)
            path.write_bytes(b'preserve me')
            with self.assertRaises(helper.UnsafePreparation): self.run_helper()
            self.assertEqual(path.read_bytes(), b'preserve me')
            self.assertEqual(self.paths.environment.read_bytes(), self.environment)
            path.unlink()
        self.paths.target.symlink_to(self.paths.target.parent / 'missing')
        with self.assertRaises(helper.UnsafePreparation): self.run_helper()
        self.assertTrue(self.paths.target.is_symlink())

    def test_refuses_wrong_runtime_database_or_duplicate_keys(self):
        for content in (self.environment.replace(str(self.paths.source).encode(), b'/other.sqlite'),
                        self.environment + b'DB_PATH=/other.sqlite\n'):
            self.paths.environment.write_bytes(content)
            with self.assertRaises(helper.UnsafePreparation): self.run_helper()
            self.assertEqual(self.paths.environment.read_bytes(), content)
            self.assertFalse(self.paths.target.exists())

    def test_rechecks_service_and_environment_before_publishing_any_target(self):
        def restarted():
            self.checks += 1
            if self.checks == 2: raise helper.UnsafePreparation('Service restarted')
        self.assert_refused_untouched(restarted)
        self.assertEqual(len(list(self.paths.archives.iterdir())), 1)

    def test_refuses_environment_race_and_preserves_the_other_writer(self):
        replacement = self.environment + b'# changed by someone else\n'
        def changed():
            self.checks += 1
            if self.checks == 2: self.paths.environment.write_bytes(replacement)
        with self.assertRaises(helper.UnsafePreparation): self.run_helper(changed)
        self.assertEqual(self.paths.environment.read_bytes(), replacement)
        self.assertFalse(self.paths.target.exists())


if __name__ == '__main__':
    unittest.main()
