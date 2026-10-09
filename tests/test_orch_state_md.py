"""Committed STATE.md contract. All commands and fault targets use disposable roots."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

from test_orch import ORCH, OrchTestCase


# Intercept public Python/SQLite operations, not implementation-only test hooks.
FAULT_CLI = r'''
import os, runpy, sqlite3, sys, time
mode, target, script, *args = sys.argv[1:]
original_replace = os.replace
original_connect = sqlite3.connect
class Connection(sqlite3.Connection):
    def execute(self, sql, *args, **kwargs):
        result = super().execute(sql, *args, **kwargs)
        if mode == 'commit-death' and sql.strip().upper() == 'COMMIT':
            row = super().execute("SELECT title FROM tickets WHERE id='T-1'").fetchone()
            if row and row[0] == 'committed-before-death':
                os._exit(79)
        return result

def connect(*args, **kwargs):
    kwargs['factory'] = Connection
    return original_connect(*args, **kwargs)

def replace(src, dst, *args, **kwargs):
    if os.path.abspath(os.fspath(dst)) == target:
        if mode == 'replace-failure':
            raise PermissionError('injected STATE.md replacement failure')
        if mode == 'delayed-replace':
            with open(target + '.paused', 'w') as marker:
                marker.write('ready')
            deadline = time.monotonic() + 15
            while not os.path.exists(target + '.release'):
                if time.monotonic() >= deadline:
                    raise TimeoutError('test did not release delayed publisher')
                time.sleep(.01)
        result = original_replace(src, dst, *args, **kwargs)
        if mode == 'replace-death':
            os._exit(78)
        return result
    return original_replace(src, dst, *args, **kwargs)
sqlite3.connect = connect
os.replace = replace
sys.argv = [script, *args]
runpy.run_path(script, run_name='__main__')
'''


class StateMdContractTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.env['ORCH_HOME'] = self.state_dir
        self.path = Path(self.root, 'STATE.md')
        self.init()

    def md(self):
        self.assertTrue(self.path.is_file(), 'committed workflow must publish STATE.md')
        return self.path.read_bytes()

    def fresh(self):
        self.j('state-md', 'check')

    def stale(self):
        before = self.path.read_bytes() if self.path.exists() else None
        p = self.orch('state-md', 'check', '--json')
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('invalid choice', p.stderr, 'check must be a real CLI operation')
        try:
            json.loads(p.stdout)
        except ValueError:
            self.fail('stale --json check must return structured output: %r' % p)
        self.assertEqual(self.path.read_bytes() if self.path.exists() else None, before,
                         'check must report staleness without repairing it')

    def rebuild(self):
        self.j('state-md', 'rebuild')
        self.fresh()
        return self.md()

    def fault(self, mode, *args, payload=None):
        return subprocess.run([sys.executable, '-c', FAULT_CLI, mode,
                               str(self.path), ORCH, *args], cwd=self.repo,
                              env=self.env, input=payload, capture_output=True,
                              text=True, timeout=30)

    def test_baseline_internal_commit_publishes_recorded_evidence(self):
        self.add('affected')
        self.add('fix')
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo,
                             env=self.env, capture_output=True, text=True,
                             check=True, timeout=10).stdout.strip()
        self.ok('baseline', 'confirm', 'baseline-sentinel', '--owner', 'fix',
                '--affected', 'affected', '--gate', 'full-suite', '--base-sha', sha,
                '--command', 'fixture-check', '--output', 'recorded-baseline-evidence',
                '--verified')
        for value in (b'baseline-sentinel', b'recorded-baseline-evidence', sha.encode()):
            self.assertIn(value, self.md())
        self.fresh()

    def test_run_completion_and_no_event_sibling_completion_are_rendered(self):
        self.add('T-1')
        self.ok('run', 'T-1', '--role', 'implementor', '--model', 'standard', '--effort', 'low')
        seq = self.db_exec("SELECT seq FROM runs WHERE ticket='T-1'")[0][0]
        self.ok('complete-run', 'T-1', '--run', str(seq), '--stopped',
                '--evidence', 'recorded completion sentinel')
        self.assertIn(b'recorded completion sentinel', self.md())
        self.db_exec("UPDATE runs SET completion_evidence='sibling completion sentinel' WHERE seq=?", (seq,))
        self.stale()
        self.assertIn(b'sibling completion sentinel', self.rebuild())

    def hook_fixture(self):
        self.add('T-1')
        self.db_exec("UPDATE tickets SET worktree=?, session_id='fixture-session', "
                     "activity='working', last_seen_at='2000-01-01T00:00:00+00:00' WHERE id='T-1'",
                     (self.worktree,))
        self.rebuild()
        return json.dumps({'hook_event_name': 'Stop', 'session_id': 'fixture-session',
                           'cwd': self.worktree})

    def test_hook_without_event_publishes_activity_and_observation(self):
        payload = self.hook_fixture()
        count = self.db_exec('SELECT count(*) FROM events')[0][0]
        p = subprocess.run([ORCH, 'hook'], input=payload, cwd=self.repo,
                           env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        activity, observed = self.db_exec("SELECT activity,last_seen_at FROM tickets WHERE id='T-1'")[0]
        self.assertEqual(activity, 'idle')
        self.assertEqual(self.db_exec('SELECT count(*) FROM events')[0][0], count)
        self.assertIn(activity.encode(), self.md())
        self.assertIn(observed.encode(), self.md())
        self.fresh()

    def test_hook_export_failure_is_non_disruptive_but_visible_and_durable(self):
        payload = self.hook_fixture()
        p = self.fault('replace-failure', 'hook', payload=payload)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertRegex(p.stderr.lower(), r'state.md')
        self.assertRegex(p.stderr.lower(), r'stale|synchron')
        self.assertEqual(self.db_exec("SELECT activity FROM tickets WHERE id='T-1'")[0][0], 'idle')
        self.stale()
        self.assertIn(b'idle', self.rebuild())

    def test_merge_and_retire_publish_current_state(self):
        self.to_done('T-1')
        done = self.md()
        self.assertIn(b'done', done)
        self.fresh()
        self.ok('retire', 'T-1')
        self.assertNotEqual(self.md(), done)
        self.assertIn(b'retired', self.md().lower())
        self.fresh()

    def test_failed_spawn_restoration_has_no_obsolete_dispatch_history(self):
        self.add('T-1')
        self.rebuild()
        before_events = self.db_exec("SELECT * FROM events WHERE ticket='T-1'")
        p = self.orch('spawn', 'T-1', '--worktree', self.worktree,
                      '--brief-file', self.brief, env={'ORCH_CLAUDE_BIN': '/nonexistent-provider'})
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.db_exec("SELECT phase FROM tickets WHERE id='T-1'")[0][0], 'ready')
        self.assertEqual(self.db_exec("SELECT * FROM events WHERE ticket='T-1'"), before_events)
        self.fresh()
        before = self.md()
        self.assertEqual(self.rebuild(), before)
        self.assertNotIn(b'dispatched', before)


    def test_add_publishes_snapshot_revision_and_event_watermark(self):
        self.add('T-1', 'Snapshot title')
        text = self.md().decode()
        for value in ('T-1', 'Snapshot title', 'ready'):
            self.assertIn(value, text)
        self.assertRegex(text.lower(), r'revision[^\n]*\d+')
        self.assertRegex(text.lower(), r'(watermark|event[^\n]*(seq|revision))[^\n]*\d+')
        self.fresh()

    def test_check_missing_then_explicit_and_automatic_repair(self):
        self.add('T-1')
        expected = self.rebuild()
        self.path.unlink()
        self.stale()
        self.assertEqual(self.rebuild(), expected)
        self.path.unlink()
        self.ok('list')
        self.assertEqual(self.md(), expected)
        self.fresh()

    def test_rebuild_is_byte_identical_and_offline(self):
        self.add('T-1')
        before = self.rebuild()
        calls = self.calls()
        self.env['ORCH_CLAUDE_BIN'] = '/nonexistent-provider'
        self.env['ORCH_PLATFORM'] = 'headless'
        self.assertEqual(self.rebuild(), before)
        self.assertEqual(self.calls(), calls)

    def test_block_unblock_and_phase_replace_current_snapshot(self):
        self.dispatched('T-1')
        self.ok('block', 'T-1', '--reason', 'unique blocker evidence')
        blocked = self.md()
        self.ok('unblock', 'T-1')
        unblocked = self.md()
        self.assertNotEqual(blocked, unblocked, 'unblock must refresh the record')
        self.phases('T-1', 'spec', 'tests')
        self.assertNotEqual(self.md(), unblocked)
        self.assertIn(b'unique blocker evidence', self.md(), 'history is retained')
        self.assertIn(b'tests', self.md())
        self.fresh()

    def test_stored_order_timestamps_and_details(self):
        self.add('Z-9', 'zulu-title')
        self.add('A-1', 'alpha-title')
        with sqlite3.connect(self.db_path()) as db:
            db.execute("UPDATE events SET ts='2001-02-03T04:05:06+00:00'")
            for ts, detail in [('2003-01-01T00:00:00+00:00', 'first-sequence-detail'),
                               ('2002-01-01T00:00:00+00:00', 'second-sequence-detail')]:
                db.execute('INSERT INTO events(ticket,ts,kind,detail) VALUES(?,?,?,?)',
                           ('A-1', ts, 'recorded', detail))
        text = self.rebuild().decode()
        self.assertLess(text.index('alpha-title'), text.index('zulu-title'))
        self.assertLess(text.index('first-sequence-detail'), text.index('second-sequence-detail'))
        self.assertIn('2001-02-03', text)
        self.assertEqual(self.rebuild().decode(), text)

    def test_old_sibling_no_event_commit_is_stale_and_reconciled(self):
        self.add('T-1')
        before = self.rebuild()
        count = self.db_exec('SELECT count(*) FROM events')[0][0]
        self.db_exec("UPDATE tickets SET activity='recorded activity sentinel', "
                     "last_seen_at='2004-05-06T07:08:09+00:00' WHERE id='T-1'")
        self.assertEqual(self.db_exec('SELECT count(*) FROM events')[0][0], count)
        self.stale()
        self.ok('list')
        self.fresh()
        self.assertNotEqual(self.md(), before)
        self.assertIn(b'recorded activity sentinel', self.md())
        self.assertIn(b'2004-05-06', self.md())

    def test_rollback_never_changes_snapshot_or_freshness(self):
        self.add('T-1')
        before = self.rebuild()
        with sqlite3.connect(self.db_path()) as db:
            db.execute("UPDATE tickets SET title='UNCOMMITTED-SENTINEL'")
            self.fresh()
            self.assertEqual(self.md(), before)
            db.rollback()
        self.assertEqual(self.rebuild(), before)

    def test_lossless_legacy_migration_and_later_notes(self):
        legacy = b'# Human state\r\n\r\n## Notes\r\n  odd spacing \t\r\n## Activity\r\n- irreplaceable legacy entry'
        self.path.write_bytes(legacy)
        self.add('T-1')
        self.assertIn(legacy, self.md())
        note = b'\nHuman note added after migration.\n'
        self.path.write_bytes(self.md() + note)
        self.ok('block', 'T-1', '--reason', 'new reason')
        self.assertIn(legacy, self.md())
        self.assertIn(note, self.md())
        self.assertEqual(self.md().count(legacy), 1)
        self.fresh()

    def test_managed_tamper_is_detected_and_repaired(self):
        self.add('T-1', 'unique-managed-title')
        before = self.rebuild()
        self.assertIn(b'unique-managed-title', before)
        self.path.write_bytes(before.replace(b'unique-managed-title', b'TAMPERED'))
        self.stale()
        self.assertEqual(self.rebuild(), before)

    def test_ambiguous_duplicate_markers_never_destroy_text(self):
        self.add('T-1')
        before = self.rebuild()
        markers = re.findall(rb'<!--[^>]+-->', before)
        self.assertTrue(markers, 'generated ownership must be explicitly delimited')
        damaged = before + b'\nHuman sentinel\n' + b'\n'.join(markers)
        self.path.write_bytes(damaged)
        self.stale()
        p = self.orch('state-md', 'rebuild')
        self.assertNotEqual(p.returncode, 0, 'ambiguous ownership must be refused')
        self.assertEqual(self.md(), damaged)

    def test_missing_managed_end_marker_refuses_destructive_rebuild(self):
        self.add('T-1')
        before = self.rebuild()
        markers = re.findall(rb'<!--[^>]+-->', before)
        self.assertTrue(markers, 'generated ownership must be explicitly delimited')
        damaged = before.replace(markers[-1], b'', 1) + b'\nDo not delete these human notes.\n'
        self.path.write_bytes(damaged)
        self.stale()
        p = self.orch('state-md', 'rebuild')
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.md(), damaged)

    def test_selftest_records_and_their_events_are_excluded(self):
        self.add('T-1')
        self.add('selftest-hidden', 'SYNTHETIC-TITLE')
        self.ok('block', 'selftest-hidden', '--reason', 'SYNTHETIC-DETAIL')
        self.db_exec("INSERT INTO runs(ticket,role,model_requested,tier,requested_at,completion_evidence) "
                     "VALUES('selftest-hidden','implementor','synthetic-model','standard',"
                     "'2000-01-01T00:00:00+00:00','SYNTHETIC-RUN')")
        text = self.rebuild()
        for excluded in (b'selftest-hidden', b'SYNTHETIC-TITLE', b'SYNTHETIC-DETAIL', b'SYNTHETIC-RUN'):
            self.assertNotIn(excluded, text)
        self.assertEqual(self.rebuild(), text)

    def test_concurrent_cli_writers_leave_complete_latest_snapshot(self):
        self.rebuild()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.orch('add', 'C-%02d' % i,
                                                       '--title', 'Concurrent %02d' % i), range(16)))
        for p in results:
            self.assertEqual(p.returncode, 0, p.stderr)
        before = self.md()
        for i in range(16):
            self.assertIn(('Concurrent %02d' % i).encode(), before)
        self.fresh()
        self.assertEqual(self.rebuild(), before, 'last publisher must include every commit')

    def test_delayed_older_publisher_cannot_overwrite_newer_and_readers_see_whole_files(self):
        self.add('T-1')
        before = self.rebuild()
        comments = re.findall(rb'<!--[^>]+-->', before)
        self.assertTrue(comments, 'managed ownership requires delimiters')
        procs = []
        observations = []
        try:
            old = subprocess.Popen(
                [sys.executable, '-c', FAULT_CLI, 'delayed-replace', str(self.path),
                 ORCH, 'block', 'T-1', '--reason', 'older-publisher-evidence'],
                cwd=self.repo, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            procs.append(old)
            deadline = time.monotonic() + 10
            while not Path(str(self.path) + '.paused').exists():
                self.assertIsNone(old.poll(), 'publisher exited before replacement barrier')
                self.assertLess(time.monotonic(), deadline, 'publisher never reached replacement')
                time.sleep(.01)
            newer = subprocess.Popen([ORCH, 'add', 'T-2', '--title', 'newer-publisher-evidence'],
                                     cwd=self.repo, env=self.env,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            procs.append(newer)
            # Give the newer writer a chance to reach publication while the old
            # writer is paused. A stable lock must serialize their replacements.
            until = time.monotonic() + .3
            while time.monotonic() < until:
                observations.append(self.path.read_bytes())
                time.sleep(.005)
            Path(str(self.path) + '.release').touch()
            deadline = time.monotonic() + 20
            while any(p.poll() is None for p in procs):
                observations.append(self.path.read_bytes())
                self.assertLess(time.monotonic(), deadline, 'publisher deadlock')
                time.sleep(.005)
            for p in procs:
                out, err = p.communicate(timeout=2)
                self.assertEqual(p.returncode, 0, (out, err))
        finally:
            Path(str(self.path) + '.release').touch()
            for p in procs:
                if p.poll() is None:
                    p.kill()
                p.communicate(timeout=5)
        for observed in observations:
            self.assertTrue(observed, 'reader observed an empty replacement')
            # Revision comments may change; delimiter count and full tail may not.
            self.assertEqual(len(re.findall(rb'<!--[^>]+-->', observed)), len(comments))
            self.assertTrue(observed.rstrip().endswith(before.rstrip().splitlines()[-1]))
        latest = self.md()
        self.assertIn(b'newer-publisher-evidence', latest)
        self.assertIn(b'older-publisher-evidence', latest)
        self.fresh()
        self.assertEqual(self.rebuild(), latest)

    def test_replace_failure_reports_committed_mutation_and_preserves_file(self):
        self.add('T-1')
        before = self.rebuild()
        p = self.fault('replace-failure', 'block', 'T-1', '--reason', 'committed fault reason')
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('Traceback', p.stderr)
        self.assertRegex(p.stderr.lower(), r'commit')
        self.assertRegex(p.stderr.lower(), r'stale|synchron')
        self.assertEqual(self.db_exec("SELECT phase FROM tickets WHERE id='T-1'")[0][0], 'blocked')
        self.assertEqual(self.md(), before)
        self.stale()
        self.assertIn(b'committed fault reason', self.rebuild())

    def test_process_death_after_commit_is_detectable(self):
        self.rebuild()
        p = self.fault('commit-death', 'add', 'T-1', '--title', 'committed-before-death')
        self.assertEqual(p.returncode, 79, p.stderr)
        self.assertEqual(self.db_exec("SELECT title FROM tickets WHERE id='T-1'")[0][0],
                         'committed-before-death')
        self.stale()
        self.assertIn(b'committed-before-death', self.rebuild())

    def test_process_death_after_replace_can_be_reconciled(self):
        self.add('T-1')
        self.rebuild()
        p = self.fault('replace-death', 'block', 'T-1', '--reason', 'replace-window')
        self.assertEqual(p.returncode, 78, p.stderr)
        self.assertIn(b'replace-window', self.md(), 'replacement must be complete')
        # A byte-valid replacement may already be fresh; an unacknowledged revision
        # may be stale. Either model must converge without losing the DB commit.
        self.ok('list')
        self.fresh()
        before = self.md()
        self.assertEqual(self.rebuild(), before)
