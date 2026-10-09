"""Attempt recovery evidence, independent of invocation exit and phase approval.

Proposed JSON contract: runs rows have an outcomes list; show has run_outcomes.
Each assessment has run_seq, ticket, timestamp, revision, failure_category,
deliverable_state, recovery_action and the retained evidence object.
All workflow state and Git mutations below are isolated disposable fixtures.
"""
import json
from pathlib import Path
import sqlite3
import subprocess

from test_orch_routing import RoutingTestCase


class OutcomeProjectionTests(RoutingTestCase):
    """Direct writes by older clients must invalidate the committed projection."""

    def git(self, *args, cwd=None):
        return subprocess.run(
            ['git', '-c', 'core.hooksPath=/dev/null', *args],
            cwd=cwd or self.repo, env=self.env, check=True,
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()

    def setUp(self):
        super().setUp()
        self.add('t1')
        self.run_seq = self.log_run('t1', 'implementor', 'standard')['seq']
        # Reproduce the projection schema before repair-grant trigger migration.
        # Its newer delete-trigger sentinels must also be absent so migration runs.
        for name in ('state_md_run_outcomes_insert', 'state_md_run_outcomes_update',
                     'state_md_run_outcomes_delete', 'state_md_repair_grants_delete',
                     'state_md_second_repair_grants_delete'):
            self.db_exec('DROP TRIGGER IF EXISTS ' + name)
        self.assertEqual(self.outcome_triggers(), [])

    def outcome_triggers(self):
        return self.db_exec("SELECT name FROM sqlite_master WHERE type='trigger' "
                            "AND name LIKE 'state_md_run_outcomes_%' ORDER BY name")

    def migrate(self):
        self.ok('show', 't1')

    def revision(self):
        return self.db_exec('SELECT revision FROM state_md_revision WHERE id=1')[0][0]

    def insert_outcome(self, ticket, marker):
        self.db_exec("INSERT INTO run_outcomes "
                     "(ticket,run_seq,timestamp,revision,failure_category,"
                     "deliverable_state,recovery_action,evidence) "
                     "VALUES (?,?,'legacy','fixture-revision','invocation_failure',"
                     "'none','retry',?)",
                     (ticket, self.run_seq, json.dumps({'detail': marker})))

    def test_legacy_open_installs_all_outcome_revision_triggers(self):
        self.migrate()
        self.assertEqual(self.outcome_triggers(), [
            ('state_md_run_outcomes_delete',), ('state_md_run_outcomes_insert',),
            ('state_md_run_outcomes_update',)])

    def test_direct_real_outcome_mutations_each_increment_revision(self):
        self.migrate()
        before = self.revision()
        self.insert_outcome('t1', 'real-outcome-64')
        self.assertEqual(self.revision(), before + 1, 'direct INSERT')
        before = self.revision()
        self.db_exec("UPDATE run_outcomes SET revision='changed' WHERE ticket='t1'")
        self.assertEqual(self.revision(), before + 1, 'direct UPDATE')
        before = self.revision()
        self.db_exec("DELETE FROM run_outcomes WHERE ticket='t1'")
        self.assertEqual(self.revision(), before + 1, 'direct DELETE')

    def test_selftest_outcome_mutations_do_not_invalidate_or_project(self):
        self.migrate()
        self.add('selftest-outcome-64')
        self.ok('state-md', 'rebuild')
        state = Path(self.root, 'STATE.md')
        baseline = state.read_bytes()
        before = self.revision()
        self.insert_outcome('selftest-outcome-64', 'excluded-outcome-64')
        self.assertEqual(self.revision(), before, 'selftest INSERT')
        self.ok('state-md', 'rebuild')
        self.assertEqual(state.read_bytes(), baseline)
        self.assertNotIn(b'excluded-outcome-64', state.read_bytes())
        self.db_exec("UPDATE run_outcomes SET evidence=? WHERE ticket=?",
                     (json.dumps({'detail': 'excluded-update-64'}), 'selftest-outcome-64'))
        self.assertEqual(self.revision(), before, 'selftest UPDATE')
        self.ok('state-md', 'rebuild')
        self.assertEqual(state.read_bytes(), baseline)
        self.assertNotIn(b'excluded-update-64', state.read_bytes())
        self.db_exec("DELETE FROM run_outcomes WHERE ticket='selftest-outcome-64'")
        self.assertEqual(self.revision(), before, 'selftest DELETE')
        self.ok('state-md', 'rebuild')
        self.assertEqual(state.read_bytes(), baseline)


class OutcomeTests(RoutingTestCase):
    def git(self, *args, cwd=None):
        return subprocess.run(
            ['git', '-c', 'core.hooksPath=/dev/null', *args],
            cwd=cwd or self.repo, env=self.env, check=True,
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()

    def setUp(self):
        super().setUp()
        self.wt = str(Path(self.root, 'code', 't1'))
        self.git('worktree', 'add', '-q', '-b', 't1', self.wt, 'main')
        self.add('t1')
        self.db_exec("UPDATE tickets SET worktree=?, worktree_ref=?, phase='implement' "
                     "WHERE id='t1'", (self.wt, 't1'))
        self.source = self.log_run('t1', 'implementor', 'standard', effort='high')
        self.j('complete-run', 't1', '--run', str(self.source['seq']),
               '--stopped', '--evidence', 'Invocation and all children stopped; simulated failure',
               cwd=self.wt)
        self.source = self.runs('t1')[0]
        self.evidence = {
            'revision': self.git('rev-parse', 'HEAD', cwd=self.wt).strip(),
            'branch': 't1', 'worktree_changes': 'none', 'commits': 'no new commits',
            'handoff': 'No deliverable; invocation failed before work started',
            'gates': 'No stage gates satisfied', 'detail': 'Simulated provider refusal',
        }
        self.file = Path(self.tmp, 'outcome-evidence.json')
        self.save_evidence()

    def save_evidence(self):
        self.file.write_text(json.dumps(self.evidence))

    def args(self, category='invocation_failure', state='none', action='retry',
             ticket='t1', seq=None):
        return ('outcome', ticket, '--run', str(self.source['seq'] if seq is None else seq),
                '--failure-category', category, '--deliverable-state', state,
                '--recovery-action', action, '--evidence-file', str(self.file))

    def assess(self, *args, **kwargs):
        return self.j(*self.args(*args, **kwargs), cwd=self.wt)

    def history(self):
        row = self.runs('t1')[0]
        self.assertIn('outcomes', row, 'runs must expose retained outcome history')
        return row['outcomes']

    def snapshot(self):
        with sqlite3.connect(self.db_path()) as db:
            tables = [r[0] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            return {t: db.execute('SELECT * FROM "' + t + '"').fetchall() for t in tables}

    def reject(self, *args, **kwargs):
        before = self.snapshot()
        result = self.orch(*self.args(*args, **kwargs), cwd=self.wt)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('invalid choice', result.stderr, 'outcome interface must exist')
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual(self.snapshot(), before, 'invalid evidence must be atomic')
        return result

    def test_no_work_retains_evidence_without_changing_run_or_ticket(self):
        ticket = self.show('t1')
        self.assess()
        history = self.history()
        self.assertEqual(len(history), 1)
        assessment = history[0]
        for key, value in dict(run_seq=self.source['seq'], ticket='t1',
                               revision=self.evidence['revision'],
                               failure_category='invocation_failure',
                               deliverable_state='none', recovery_action='retry',
                               evidence=self.evidence).items():
            self.assertEqual(assessment[key], value, key)
        self.assertTrue(assessment['timestamp'])
        row = self.runs('t1')[0]
        for key, value in self.source.items():
            if key != 'outcomes':
                self.assertEqual(row[key], value, key)
        after = self.show('t1')
        self.assertEqual(after['run_outcomes'], history)
        for key in ('phase', 'bounces', 'ci_repairs', 'blocked_reason'):
            self.assertEqual(after.get(key), ticket.get(key), key)
        self.file.unlink()
        self.assertEqual(self.history(), history, 'retain content, not scratch path')

    def test_partial_work_is_preserved_and_existing_retry_replays_original_route(self):
        partial = Path(self.wt, 'partial.py')
        partial.write_text('useful unfinished work\n')
        self.evidence.update(worktree_changes='untracked partial.py',
                             handoff='Continue partial.py from checkpoint; do not overwrite')
        self.save_evidence()
        ticket = self.show('t1')
        self.assess(state='partial', action='continue')
        replay = self.j('retry', 't1', '--run', str(self.source['seq']), cwd=self.wt)
        for key in ('dispatch', 'routing_context', 'role', 'tier', 'effort_requested', 'bounce_count'):
            self.assertEqual(replay[key], self.source[key], key)
        self.assertEqual(replay['retry_of'], self.source['seq'])
        self.assertEqual(partial.read_text(), 'useful unfinished work\n')
        for key in ('phase', 'bounces', 'ci_repairs'):
            self.assertEqual(self.show('t1')[key], ticket[key])
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(self.runs('t1')[-1]['outcomes'], [])

    def test_complete_red_test_writer_handoff_can_be_attested_without_approval(self):
        self.db_exec("UPDATE runs SET role='test-writer' WHERE seq=?", (self.source['seq'],))
        self.db_exec("UPDATE tickets SET phase='tests' WHERE id='t1'")
        self.evidence.update(handoff='Tests written; intended missing behavior assertions fail',
                             gates='Focused suite red for intended missing interface; handoff retained')
        self.save_evidence()
        self.assess(state='complete', action='advance')
        self.assertEqual(self.history()[0]['recovery_action'], 'advance')
        self.assertEqual(self.show('t1')['phase'], 'tests', 'attestation is not phase approval')

    def test_complete_implementor_candidate_retains_whole_suite_attestation(self):
        self.evidence.update(handoff='Implementation and full-suite output retained',
                             gates='Whole suite green; independent review still required',
                             detail='Process failed after writing the completed handoff')
        self.save_evidence()
        self.assess(state='complete', action='advance')
        self.assertEqual(self.history()[0]['evidence'], self.evidence)
        self.assertEqual(self.show('t1')['phase'], 'implement')
        self.assertEqual(self.show('t1')['bounces'], 0)

    def test_successful_invocation_can_have_incomplete_handoff(self):
        self.evidence.update(detail='Invocation exited zero but omitted full-suite evidence',
                             handoff='Implementation present; required green suite not supplied',
                             worktree_changes='partial uncommitted candidate inspected')
        self.save_evidence()
        self.assess('incomplete_handoff', 'partial', 'continue')
        self.assertEqual(self.history()[0]['failure_category'], 'incomplete_handoff')
        self.assertEqual(self.show('t1')['phase'], 'implement')

    def test_unknown_is_explicit_and_block_record_does_not_block_ticket(self):
        self.assess('unknown', 'unknown', 'block')
        self.assertEqual(self.history()[0]['deliverable_state'], 'unknown')
        self.assertEqual(self.show('t1')['phase'], 'implement')
        self.assertEqual(self.show('t1')['bounces'], 0)

    def test_read_only_rejection_records_findings_but_only_real_transition_consumes_bounce(self):
        self.db_exec("UPDATE tickets SET phase='review' WHERE id='t1'")
        self.db_exec("UPDATE runs SET role='reviewer' WHERE seq=?", (self.source['seq'],))
        self.evidence.update(handoff='Read-only review found concrete defect in candidate',
                             detail='Independent finding: empty input raises IndexError in partial.py:12',
                             gates='Review rejects candidate; reviewer made no edits')
        self.save_evidence()
        status = self.git('status', '--porcelain', cwd=self.wt)
        self.assess('review_rejection', 'complete', 'repair')
        self.assertEqual(self.show('t1')['bounces'], 0)
        self.assertEqual(self.show('t1')['phase'], 'review')
        self.assertEqual(self.git('status', '--porcelain', cwd=self.wt), status)
        self.ok('phase', 't1', 'fix', cwd=self.wt)
        self.assertEqual(self.show('t1')['bounces'], 1)

    def test_changed_assessments_append_and_identical_repetition_keeps_history(self):
        self.assess('unknown', 'unknown', 'block')
        first = self.history()
        self.assess('unknown', 'unknown', 'block')
        repeated = self.history()
        self.assertEqual(repeated[:len(first)], first)
        self.evidence['detail'] = 'Fresh inspection confirms provider failed before writing'
        self.save_evidence()
        self.assess()
        history = self.history()
        self.assertEqual(history[:len(repeated)], repeated)
        self.assertEqual(len(history), len(repeated) + 1)
        self.assertEqual(history[-1]['evidence'], self.evidence)

    def test_inconsistent_decisions_refused_after_proving_interface_exists(self):
        self.assess()
        cases = [('invocation_failure', 'partial', 'retry'),
                 ('invocation_failure', 'none', 'continue'),
                 ('incomplete_handoff', 'partial', 'advance'),
                 ('unknown', 'unknown', 'advance'), ('unknown', 'unknown', 'retry'),
                 ('unknown', 'unknown', 'continue'),
                 ('review_rejection', 'complete', 'retry'),
                 ('review_rejection', 'partial', 'repair'),
                 ('invocation_failure', 'complete', 'repair'),
                 ('incomplete_handoff', 'complete', 'repair'),
                 ('unknown', 'complete', 'repair')]
        for case in cases:
            with self.subTest(case=case):
                self.reject(*case)

    def test_malformed_empty_and_stale_evidence_refused_atomically(self):
        self.assess()
        good = dict(self.evidence)
        for key in good:
            with self.subTest(empty=key):
                self.evidence = dict(good, **{key: ' '})
                self.save_evidence()
                self.reject()
            with self.subTest(missing=key):
                self.evidence = dict(good)
                del self.evidence[key]
                self.save_evidence()
                self.reject()
        for raw in ('{', '[]', 'null'):
            self.file.write_text(raw)
            self.reject()
        self.evidence = dict(good, revision='not-a-commit')
        self.save_evidence()
        self.reject()
        self.evidence = good
        self.save_evidence()
        Path(self.wt, 'new.txt').write_text('new revision\n')
        self.git('add', 'new.txt', cwd=self.wt)
        self.git('commit', '-q', '-m', 'fixture newer revision', cwd=self.wt)
        self.reject()

    def test_ticket_run_branch_and_worktree_mismatches_are_atomic(self):
        self.assess()
        self.add('t2')
        self.reject(ticket='t2')
        self.reject(seq=self.source['seq'] + 999)
        self.evidence['branch'] = 'main'
        self.save_evidence()
        self.reject()
        self.evidence['branch'] = 't1'
        self.save_evidence()
        self.db_exec("UPDATE tickets SET worktree_ref='wrong' WHERE id='t1'")
        self.reject()
        self.db_exec("UPDATE tickets SET worktree_ref='t1' WHERE id='t1'")
        result = self.orch(*self.args(), cwd=self.repo)
        self.assertNotEqual(result.returncode, 0, 'must inspect ticket-local linked worktree')

    def test_pending_completion_and_child_attestation_cannot_record_outcome(self):
        self.assess()
        pending = self.log_run('t1', 'implementor', 'standard')
        self.reject(seq=pending['seq'])
        before = self.snapshot()
        result = self.orch(*self.args(), env={'PI_SUBAGENT_CHILD': '1'}, cwd=self.wt)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_runs_have_no_inferred_outcome(self):
        self.db_exec("INSERT INTO runs (ticket,role,model_requested,tier,bounce_count,requested_at) "
                     "VALUES ('t1','implementor','sonnet','standard',0,'legacy')")
        for row in self.runs('t1'):
            self.assertIn('outcomes', row, 'legacy migration must expose an empty history')
            self.assertEqual(row['outcomes'], [])
        self.assertEqual(self.show('t1')['run_outcomes'], [])

    def test_state_md_and_plain_output_publish_retained_classification(self):
        self.evidence['detail'] = 'outcome-evidence-sentinel-54'
        self.save_evidence()
        self.assess()
        path = Path(self.root, 'STATE.md')
        before = path.read_bytes()
        for text in ('invocation_failure', 'none', 'retry', 'outcome-evidence-sentinel-54',
                     self.evidence['revision']):
            self.assertIn(text.encode(), before)
            self.assertIn(text, self.ok('runs', 't1').stdout)
            self.assertIn(text, self.ok('show', 't1').stdout)
        self.ok('state-md', 'check')
        self.ok('state-md', 'rebuild')
        self.assertEqual(path.read_bytes(), before)
