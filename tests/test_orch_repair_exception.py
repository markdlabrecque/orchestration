"""One human-attested repair grant. Every database and fault target is disposable."""
import concurrent.futures
import contextlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

from test_orch import ORCH
from test_orch_routing import RoutingTestCase


class RepairExceptionTests(RoutingTestCase):
    def setUp(self):
        super().setUp()
        # Tests model the parent caller, never clear markers on a live command.
        for key in tuple(self.env):
            if key.startswith('PI_SUBAGENT_'):
                self.env.pop(key)

    def exhausted(self, ticket='t1', origin='review'):
        self.to_review(ticket)
        for _ in range(3):
            self.phases(ticket, 'fix', 'review')
        if origin == 'verify':
            self.phases(ticket, 'verify')

    def grant_args(self, ticket='t1', **changes):
        event = [e for e in self.events(ticket) if e['from_phase'] != e['to_phase']][-1]
        values = dict(grant_id='approval-1', approved_by='requesting-human',
                      evidence='tracker comment https://example.test/approval/1; retained authorization.md',
                      scope='repair finding in retained review.md only',
                      workflow='single-workflow-191', agent='astra-child-191', event=event['seq'])
        values.update(changes)
        args = ['repair-grant', ticket, '--approved']
        for key, value in values.items():
            args.extend(['--' + key.replace('_', '-'), str(value)])
        return args

    def consume_args(self, ticket='t1', **changes):
        values = dict(repair_grant='approval-1', workflow='single-workflow-191', agent='astra-child-191')
        values.update(changes)
        args = ['phase', ticket, 'fix']
        for key, value in values.items():
            args.extend(['--' + key.replace('_', '-'), value])
        return args

    def snapshot(self):
        with contextlib.closing(sqlite3.connect(self.db_path())) as db:
            return {t: db.execute('SELECT * FROM ' + t).fetchall() for t in
                    ('tickets', 'events', 'runs', 'ci_results', 'repair_grants', 'run_outcomes', 'state_md_revision')}

    def refuses_unchanged(self, args, **kwargs):
        before = self.snapshot()
        result = self.refused(3, *args, **kwargs)
        self.assertEqual(before, self.snapshot())
        return result

    def test_explicit_grant_and_consumption_preserve_history(self):
        self.exhausted()
        self.log_run('t1', 'implementor', 'heavy', effort='high')
        before = self.snapshot()
        grant = self.j(*self.grant_args())
        self.assertEqual(self.snapshot()['tickets'], before['tickets'])
        self.assertIsNone(grant['consumed_at'])
        self.assertEqual(grant['context']['bounces'], 3)
        self.assertEqual(self.show('t1')['repair_grant'], grant)
        self.assertIn('approval-1', self.ok('show', 't1').stdout)
        self.refuses_unchanged(['phase', 't1', 'fix'])
        self.ok(*self.consume_args())
        state = self.show('t1')
        self.assertEqual((state['phase'], state['bounces'], state['ci_repairs'], state['review_rounds']),
                         ('fix', 4, 0, 4))
        self.assertIsNotNone(state['repair_grant']['consumed_at'])
        after = self.snapshot()
        for table in ('runs', 'ci_results', 'run_outcomes'):
            self.assertEqual(after[table], before[table])
        self.assertEqual(after['events'][:len(before['events'])], before['events'])
        self.assertEqual(self.route('t1', 'implementor')['tier'], 'frontier')
        self.refuses_unchanged(['run', 't1', '--role', 'implementor', '--model', 'heavy', '--effort', 'high'])
        self.log_run('t1', 'implementor', 'frontier')
        self.phases('t1', 'review')
        self.refuses_unchanged(['phase', 't1', 'fix'])
        self.refuses_unchanged(self.consume_args())
        self.refuses_unchanged(self.grant_args(grant_id='second'))
        self.assertTrue(self.j('state-md', 'check')['fresh'])

    def test_verify_origin_and_missing_or_mismatched_grant(self):
        self.exhausted(origin='verify')
        self.refuses_unchanged(self.consume_args())
        self.j(*self.grant_args())
        for change in ({'repair_grant': 'other'}, {'workflow': 'other'}, {'agent': 'other'}):
            self.refuses_unchanged(self.consume_args(**change))
        self.ok(*self.consume_args())
        self.assertEqual(self.show('t1')['bounces'], 4)

    def test_exact_grant_replay_is_idempotent_even_after_consumption(self):
        self.exhausted()
        args = self.grant_args()
        self.ok(*args)
        before = self.snapshot()
        self.ok(*args)
        self.assertEqual(before, self.snapshot())
        for field in ('grant_id', 'approved_by', 'evidence', 'scope', 'workflow', 'agent', 'event'):
            self.refuses_unchanged(self.grant_args(**{field: 1 if field == 'event' else 'changed'}))
        self.ok(*self.consume_args())
        before = self.snapshot()
        self.ok(*args)
        self.assertEqual(before, self.snapshot())

    def test_invalid_inputs_and_approval_are_rejected(self):
        self.exhausted()
        for field in ('grant_id', 'approved_by', 'evidence', 'scope', 'workflow', 'agent'):
            self.refuses_unchanged(self.grant_args(**{field: '  '}))
        args = self.grant_args()
        args.remove('--approved')
        self.refuses_unchanged(args)
        self.refuses_unchanged(self.grant_args(event=0))
        self.refuses_unchanged(['phase', 't1', 'fix', '--workflow', 'stray'])
        self.ok(*self.grant_args())
        self.refuses_unchanged(['phase', 't1', 'fix', '--repair-grant', 'approval-1'])

    def test_known_children_cannot_grant_or_consume(self):
        self.exhausted()
        for marker in ('PI_SUBAGENT_CHILD', 'PI_SUBAGENT_ID', 'ORCH_PI_PARENT_SESSION'):
            self.refuses_unchanged(self.grant_args(), env={marker: '1'})
        self.ok(*self.grant_args())
        for marker in ('PI_SUBAGENT_CHILD', 'PI_SUBAGENT_ID', 'ORCH_PI_PARENT_SESSION'):
            self.refuses_unchanged(self.consume_args(), env={marker: '1'})

    def test_concurrent_consumption_exactly_once(self):
        self.exhausted()
        self.ok(*self.grant_args())
        before = self.events('t1')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.orch(*self.consume_args()), range(2)))
        self.assertEqual(sorted(p.returncode for p in results), [0, 3])
        self.assertEqual(self.show('t1')['bounces'], 4)
        added = self.events('t1')[len(before):]
        self.assertEqual([e['kind'] for e in added], ['phase', 'repair-grant-consumed'])

    def test_event_failure_rolls_back_consumption_and_counter(self):
        self.exhausted()
        self.ok(*self.grant_args())
        self.db_exec("CREATE TRIGGER reject_consume BEFORE INSERT ON events "
                     "WHEN NEW.kind='repair-grant-consumed' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        before = self.snapshot()
        result = self.orch(*self.consume_args())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fixture failure', result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_duplicate_id_cannot_authorize_another_ticket(self):
        self.exhausted()
        self.ok(*self.grant_args())
        self.exhausted('t2')
        self.refuses_unchanged(self.grant_args('t2'))
        self.refuses_unchanged(self.consume_args('t2'))

    def test_context_changes_invalidate_without_regrant(self):
        self.exhausted()
        self.ok(*self.grant_args())
        self.ok('block', 't1', '--reason', 'pause')
        self.ok('unblock', 't1')
        self.refuses_unchanged(self.consume_args())
        self.refuses_unchanged(self.grant_args(grant_id='replacement'))

    def test_earlier_phases_never_accept_grants(self):
        self.dispatched('t1', worktree=self.new_worktree('t1'))
        for phase in ('spec', 'tests', 'implement'):
            self.phases('t1', phase)
            self.refuses_unchanged(self.grant_args())
            self.refuses_unchanged(self.consume_args())

    def test_concurrent_different_grants_have_one_winner(self):
        self.exhausted()
        args = [self.grant_args(grant_id=name) for name in ('first', 'second')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda command: self.orch(*command), args))
        self.assertEqual(sorted(p.returncode for p in results), [0, 3])
        self.assertEqual(len(self.snapshot()['repair_grants']), 1)
        self.assertEqual(sum(e['kind'] == 'repair-grant' for e in self.events('t1')), 1)

    def test_legacy_missing_history_remains_unknown(self):
        self.exhausted()
        args = self.grant_args()
        self.db_exec('DROP TABLE repair_grants')
        self.db_exec('ALTER TABLE tickets DROP COLUMN ci_repairs')
        self.db_exec("DELETE FROM events WHERE ticket='t1' AND kind='add'")
        self.assertIsNone(self.show('t1')['ci_repairs'])
        self.refuses_unchanged(args)

    def test_illegal_origins_and_retired_tickets(self):
        self.to_review('t1')
        self.refuses_unchanged(self.grant_args())  # not exhausted
        self.phases('t1', 'fix', 'review', 'fix', 'review', 'fix', 'review')
        self.ok('block', 't1', '--reason', 'exhausted')
        self.refuses_unchanged(self.grant_args())
        self.refuses_unchanged(self.consume_args())
        self.ok('unblock', 't1')
        self.ok(*self.grant_args())
        for phase in ('report', 'mr', 'ci'):
            self.phases('t1', phase)
            self.refuses_unchanged(self.grant_args(grant_id='other'))
            self.refuses_unchanged(self.consume_args())
        self.ok('retire', 't1', '--force', '--keep-worktree')
        self.refuses_unchanged(self.grant_args())
        self.refuses_unchanged(self.consume_args())

    def test_unknown_and_inconsistent_history_refuse(self):
        mutations = (
            "UPDATE tickets SET bounces=NULL WHERE id='t1'",
            "UPDATE tickets SET ci_repairs=NULL WHERE id='t1'",
            "UPDATE tickets SET ci_repairs=-1 WHERE id='t1'",
            "UPDATE tickets SET ci_repairs=3 WHERE id='t1'",
            "UPDATE tickets SET bounces=4 WHERE id='t1'",
            "UPDATE tickets SET review_rounds=9 WHERE id='t1'",
            "DELETE FROM events WHERE ticket='t1' AND kind='add'",
            "DELETE FROM events WHERE ticket='t1' AND from_phase='tests'",
        )
        for index, mutation in enumerate(mutations):
            with self.subTest(mutation=mutation):
                if index:
                    self.tearDown()
                    self.setUp()
                self.exhausted()
                args = self.grant_args()
                self.db_exec(mutation)  # isolated corrupt fixture
                self.refuses_unchanged(args)

    def test_stale_counters_session_runs_and_reservations_refuse(self):
        mutations = (
            "UPDATE tickets SET ci_repairs=NULL WHERE id='t1'",
            "UPDATE tickets SET session_id='other' WHERE id='t1'",
            "UPDATE tickets SET attempt=attempt+1 WHERE id='t1'",
            "UPDATE tickets SET baseline_refresh='unknown-reservation' WHERE id='t1'",
            "DELETE FROM events WHERE ticket='t1' AND kind='add'",
            "INSERT INTO ci_results(ticket,sha,verdict,ts) VALUES('t1','new','failed','now')",
        )
        for index, mutation in enumerate(mutations):
            with self.subTest(mutation=mutation):
                if index:
                    self.tearDown()
                    self.setUp()
                self.exhausted()
                self.ok(*self.grant_args())
                self.db_exec(mutation)
                self.refuses_unchanged(self.consume_args())
        self.tearDown()
        self.setUp()
        self.exhausted()
        self.ok(*self.grant_args())
        self.log_run('t1', 'reviewer', 'standard')
        self.refuses_unchanged(self.consume_args())

    def test_active_launch_guards_grant_and_consume(self):
        self.exhausted()
        marker = json.dumps(dict(pid=os.getpid(), op='fixture', at='now'))
        args = self.grant_args()
        self.db_exec("UPDATE tickets SET launching=? WHERE id='t1'", (marker,))
        self.refuses_unchanged(args)
        self.db_exec("UPDATE tickets SET launching=NULL WHERE id='t1'")
        self.ok(*args)
        self.db_exec("UPDATE tickets SET launching=? WHERE id='t1'", (marker,))
        self.refuses_unchanged(self.consume_args())

    def test_legacy_database_adds_table_and_triggers_without_recounting(self):
        self.exhausted()
        before = self.snapshot()
        self.db_exec('DROP TABLE repair_grants')
        self.db_exec('ALTER TABLE tickets DROP COLUMN ci_repairs')
        self.ok('show', 't1')
        after = self.snapshot()
        for table in ('runs', 'events', 'ci_results', 'run_outcomes'):
            self.assertEqual(before[table], after[table])
        self.assertEqual(self.show('t1')['bounces'], 3)
        self.assertEqual(self.show('t1')['ci_repairs'], 0)
        self.ok(*self.grant_args())
        self.ok(*self.consume_args())
        self.assertTrue(self.j('state-md', 'check')['fresh'])

    def test_projection_revision_and_synthetic_isolation(self):
        self.exhausted()
        self.ok(*self.grant_args())
        path = Path(self.root, 'STATE.md')
        self.assertIn('approval-1', path.read_text())
        revision = lambda: self.db_exec('SELECT revision FROM state_md_revision')[0][0]
        before = revision()
        self.db_exec("UPDATE repair_grants SET evidence='fixture updated' WHERE ticket='t1'")
        self.assertGreater(revision(), before)
        self.refused(3, 'state-md', 'check')
        self.ok('state-md', 'rebuild')
        self.assertIn('fixture updated', path.read_text())
        self.exhausted('selftest-hidden')
        before_bytes, before_revision = path.read_bytes(), revision()
        self.ok(*self.grant_args('selftest-hidden', grant_id='synthetic-grant'))
        self.ok(*self.consume_args('selftest-hidden', repair_grant='synthetic-grant'))
        self.assertEqual(revision(), before_revision)
        self.assertEqual(path.read_bytes(), before_bytes)
        self.db_exec("DELETE FROM repair_grants WHERE ticket='t1'")
        self.assertGreater(revision(), before_revision)
        self.refused(3, 'state-md', 'check')

    def test_retry_and_outcome_keep_consumed_grant_and_snapshots(self):
        self.exhausted()
        linked = str(Path(self.root, 'code', 't1'))
        self.git('worktree', 'add', '-q', '-b', 't1', linked, 'main')
        self.db_exec("UPDATE tickets SET worktree=?, worktree_branch='t1' WHERE id='t1'", (linked,))
        self.ok(*self.grant_args())
        self.ok(*self.consume_args())
        run = self.log_run('t1', 'implementor', 'standard')
        grant = self.show('t1')['repair_grant']
        retry = self.j('retry', 't1', '--run', str(run['seq']))
        self.assertEqual(retry['retry_of'], run['seq'])
        self.assertEqual(retry['bounce_count'], 4)
        worktree = self.show('t1')['worktree']
        self.ok('complete-run', 't1', '--run', str(retry['seq']), '--stopped',
                '--evidence', 'isolated fixture invocation stopped', cwd=worktree)
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=worktree, text=True).strip()
        branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=worktree, text=True).strip()
        evidence = Path(self.tmp, 'outcome.json')
        evidence.write_text(json.dumps(dict(revision=head, branch=branch, worktree_changes='none',
            commits='fixture init', handoff='fixture handoff', gates='pending tests', detail='invocation failed before work')))
        self.ok('outcome', 't1', '--run', str(retry['seq']), '--failure-category', 'invocation_failure',
                '--deliverable-state', 'none', '--recovery-action', 'retry', '--evidence-file', str(evidence), cwd=worktree)
        state = self.show('t1')
        self.assertEqual(state['repair_grant'], grant)
        self.assertEqual((state['bounces'], state['ci_repairs'], state['review_rounds']), (4, 0, 4))
        self.assertEqual(len(state['run_outcomes']), 1)
        self.assertIn('invocation_failure', Path(self.root, 'STATE.md').read_text())

    def test_process_death_is_atomic_before_and_after_commit(self):
        fault = '''
import os, runpy, sqlite3, sys
mode, script, *args = sys.argv[1:]
original = sqlite3.connect
class Connection(sqlite3.Connection):
    def execute(self, sql, *args, **kwargs):
        result = super().execute(sql, *args, **kwargs)
        if mode == 'before' and sql.startswith('UPDATE repair_grants SET consumed_at='):
            os._exit(77)
        if mode == 'after' and sql == 'COMMIT':
            row = super().execute("SELECT consumed_at FROM repair_grants WHERE ticket='t1'").fetchone()
            if row and row[0]: os._exit(78)
        return result
def connect(*args, **kwargs):
    kwargs['factory'] = Connection
    return original(*args, **kwargs)
sqlite3.connect = connect
sys.argv = [script, *args]
runpy.run_path(script, run_name='__main__')
'''
        self.exhausted()
        self.ok(*self.grant_args())
        before = self.snapshot()
        result = subprocess.run([sys.executable, '-c', fault, 'before', ORCH, *self.consume_args()],
                                cwd=self.repo, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 77, result.stderr)
        self.assertEqual(self.snapshot(), before)
        result = subprocess.run([sys.executable, '-c', fault, 'after', ORCH, *self.consume_args()],
                                cwd=self.repo, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 78, result.stderr)
        self.refused(3, 'state-md', 'check')
        state = self.show('t1')
        self.assertEqual(state['bounces'], 4)
        self.assertIsNotNone(state['repair_grant']['consumed_at'])
        self.assertTrue(self.j('state-md', 'check')['fresh'])
        self.refuses_unchanged(self.consume_args())

    def test_frontier_guard_is_independent(self):
        self.exhausted()
        self.log_run('t1', 'implementor', 'frontier', effort='high')
        self.ok(*self.grant_args())
        result = self.refuses_unchanged(self.consume_args())
        self.assertIn('frontier', result.stderr)
        self.assertIsNone(self.show('t1')['repair_grant']['consumed_at'])
