"""Approved #50 branch retention and fail-closed direct-engine inventories."""
import json
import os
import subprocess
import unittest

import test_orch_reconcile as fixtures


class RetirementSafetyTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ReconcileTests('test_standalone_completed_cleanup_and_idempotence')
        self.fx.setUp()
        self.addCleanup(self.fx.tearDown)
        self.path = self.fx.completed(branch=True)
        self.inventory_file = os.path.join(self.fx.tmp, 'inventories.json')
        self.calls = os.path.join(self.fx.tmp, 'herdr-calls')
        self.fx.stub('herdr', 'exec python3 -c ' + self.fx.quote(
            'import json,sys; '
            'a=sys.argv[1:]; '
            'open(' + repr(self.calls) + ',"a").write(" ".join(a)+"\\n"); '
            'data=json.load(open(' + repr(self.inventory_file) + ')); '
            'print(json.dumps({"result":{a[0]+"s":data[a[0]+"s"]}}) if a[1]=="list" else ""); '
            'sys.exit(1 if a[1]=="close" else 0)') + ' "$@"\n')

    def engine(self, **extra):
        env = dict(self.fx.env, **extra)
        env.pop('ORCH_RETIRE_MANAGED', None)
        return subprocess.run([fixtures.ENGINE, '50'], cwd=self.fx.repo, env=env,
                              capture_output=True, text=True, timeout=30)

    def inventories(self, worktrees=None, workspaces=None):
        with open(self.inventory_file, 'w') as f:
            json.dump({'worktrees': [] if worktrees is None else worktrees,
                       'workspaces': [] if workspaces is None else workspaces}, f)

    def record(self):
        with open(os.path.join(self.fx.repo, '.git/orch-retirement/50.json')) as f:
            return json.load(f)

    def malformed(self, kind):
        valid = ({'path': '/other', 'open_workspace_id': None} if kind == 'worktrees'
                 else {'workspace_id': 'other', 'worktree': {'checkout_path': '/other'}})
        rows = [None, [], {}, 'bad', True, 42]
        key = 'open_workspace_id' if kind == 'worktrees' else 'workspace_id'
        rows.extend(dict(valid, **{key: value}) for value in ('', [], {}, True, 7, '\n', '\x00'))
        rows.append({k: v for k, v in valid.items() if k != key})
        if kind == 'workspaces':
            rows.append(dict(valid, workspace_id=None))
            rows.extend(dict(valid, worktree=value) for value in (None, [], {}, 3))
        for bad_path in (None, '', [], {}, True, 7, 'relative', '\x00bad', '/bad\npath'):
            rows.append(dict(valid, path=bad_path) if kind == 'worktrees' else
                        dict(valid, worktree={'checkout_path': bad_path}))
        return [[row] for row in rows] + [[valid, None], [None, valid]]

    def test_initial_discovery_rejects_every_malformed_entry_before_teardown(self):
        for kind in ('worktrees', 'workspaces'):
            for rows in self.malformed(kind):
                with self.subTest(kind=kind, rows=rows):
                    self.inventories(**{kind: rows})
                    p = self.engine()
                    self.assertEqual(p.returncode, 4, p.stdout + p.stderr)
                    self.assertIn('invalid Herdr', p.stderr)
                    self.assertIn('repair Herdr and retry', p.stderr)
                    self.assertTrue(os.path.isfile(os.path.join(self.path, 'README')))
                    self.fx.git('show-ref', '--verify', 'refs/heads/ticket-50')
                    self.assertEqual(self.record()['stage'], 'prepared')
        # A valid closed worktree with a null open_workspace_id is not malformed.
        self.inventories(worktrees=[{'path': self.path, 'open_workspace_id': None}])
        p = self.engine()
        self.assertEqual(p.returncode, 4)
        self.assertIn('MANUAL branch cleanup', p.stderr)
        self.assertFalse(os.path.exists(self.path))

    def test_saved_workspace_survives_malformed_absence_after_checkout_gone(self):
        self.inventories(worktrees=[{'path': self.path, 'open_workspace_id': 'saved'}])
        p = self.engine(HERDR_WORKSPACE_ID='saved')
        self.assertEqual(p.returncode, 4)
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(self.record()['workspace'], 'saved')
        for kind in ('worktrees', 'workspaces'):
            for rows in self.malformed(kind):
                with self.subTest(kind=kind, rows=rows):
                    self.inventories(**{kind: rows})
                    p = self.engine()
                    self.assertEqual(p.returncode, 4, p.stdout + p.stderr)
                    self.assertIn('failed to close herdr workspace saved', p.stderr)
                    self.assertEqual(self.record()['workspace'], 'saved')
                    self.assertEqual(self.record()['stage'], 'ready')
                    self.assertTrue(self.record()['manual_branch'])
                    self.fx.git('show-ref', '--verify', 'refs/heads/ticket-50')
        self.inventories()
        p = self.engine()
        self.assertEqual(p.returncode, 4)
        self.assertNotIn('workspace', self.record())
        self.assertTrue(self.record()['manual_branch'])
        self.fx.git('branch', '-d', 'ticket-50')
        for _ in range(2):
            p = self.engine()
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.record()['stage'], 'complete')

    def test_orca_retirement_never_calls_branch_deleting_adapter(self):
        self.inventories()
        self.fx.db_exec("UPDATE tickets SET platform='orca' WHERE id='50'")
        calls = os.path.join(self.fx.tmp, 'orca-calls')
        inventory_file = os.path.join(self.fx.tmp, 'orca-inventory')
        self.fx.stub('orca', 'echo "$*" >> ' + self.fx.quote(calls) + '\n'
                     'if [ "$1 $2" = "worktree list" ]; then cat ' + self.fx.quote(inventory_file) + '; '
                     'else exit 99; fi\n')
        with open(inventory_file, 'w') as f:
            json.dump({'result': {'worktrees': [{'path': self.path}]}}, f)
        self.fx.assert_manual_pending(self.path, self.fx.reconcile())
        self.fx.git('branch', '-d', 'ticket-50')
        p = self.fx.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('MANUAL Orca cleanup', p.stderr)
        self.assertFalse(self.fx.show('50')['retired'])
        with open(inventory_file, 'w') as f:
            json.dump({'result': {'worktrees': []}}, f)
        self.assertEqual(self.fx.reconcile().returncode, 0)
        self.fx.assert_complete('50', self.path)
        with open(calls) as f:
            self.assertNotIn('worktree rm', f.read())
