"""Ticket 50: unattended cleanup through the supported retirement path.

All projects, adapters, trust stores and git repositories are disposable.
Public interface: orch reconcile [--project PATH] [--json]. JSON structure
is intentionally unspecified beyond valid JSON. Desktop automation defers;
manual orch retire returns the existing desktop_archive action.

The systemd acceptance smoke belongs to the implementation handoff; these
unit tests never contact the real user manager. Remaining implementation-stage
coverage must exercise notification delivery failure/recurrence, finalization
ownership changes, status failure, platform-close retry, no automatic adapter
force flags, main startup ordering and ordinary reinstall non-enablement.
Real user-unit smoke and escaping roundtrip are required before acceptance.
"""
import concurrent.futures
import json
import os
import shutil
import subprocess
import unittest

from test_orch import OrchTestCase, ORCH, PHASE_STATUS, is_retired

ENGINE = os.path.realpath(os.path.join(os.path.dirname(ORCH), '..',
                                      'skills/retire-worktree/scripts/retire-worktree.sh'))


class ReconcileTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.env['ORCH_RETIRE_ENGINE'] = ENGINE
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.bin)
        self.env['PATH'] = self.bin + os.pathsep + self.env['PATH']
        self.notifications = os.path.join(self.tmp, 'notifications')
        self.stub('notify-send', 'echo "$*" >> ' + self.quote(self.notifications) + '\n')
        # Never invoke an installed desktop/container adapter.
        for name in ('herdr', 'orca', 'ddev'):
            self.stub(name, 'exit 127\n')

    @staticmethod
    def quote(value):
        import shlex
        return shlex.quote(value)

    def stub(self, name, body):
        path = os.path.join(self.bin, name)
        with open(path, 'w') as f:
            f.write('#!/bin/sh\n' + body)
        os.chmod(path, 0o755)
        return path

    def completed(self, tid='50'):
        path = os.path.join(self.root, 'code', tid)
        self.git('worktree', 'add', '-q', '-b', 'ticket-' + tid, path)
        self.to_done(tid, worktree=path)
        return path

    def reconcile(self, **kw):
        return self.orch('reconcile', '--project', self.root, **kw)

    def assert_complete(self, tid, path):
        self.assertTrue(is_retired(self.show(tid)))
        self.assertFalse(os.path.exists(path))
        p = subprocess.run(['git', '-C', self.repo, 'show-ref', '--verify',
                            '--quiet', 'refs/heads/ticket-' + tid], env=self.env)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(sum(e['kind'] == 'retire' for e in self.events(tid)), 1)

    def test_standalone_completed_cleanup_and_idempotence(self):
        path = self.completed()
        adapter_log = os.path.join(self.tmp, 'adapter-log')
        self.stub('ddev', 'echo "$*" >> ' + self.quote(adapter_log) + '\nexit 0\n')
        os.makedirs(os.path.join(path, '.ddev'))
        # Existing contract permits ignored provisioned resources.
        with open(os.path.join(path, '.gitignore'), 'w') as f:
            f.write('.ddev/\n')
        subprocess.run(['git', '-C', path, 'add', '.gitignore'], check=True, env=self.env)
        subprocess.run(['git', '-C', path, 'commit', '-qm', 'ignore provisioned config'],
                       check=True, env=self.env)
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)
        with open(adapter_log) as f:
            self.assertIn('delete', f.read())
        self.assertEqual(self.reconcile().returncode, 0)
        self.assert_complete('50', path)

    def test_eligibility_and_discovery_do_not_initialize_unrelated_projects(self):
        self.init()
        for phase in PHASE_STATUS:
            if phase == 'done':
                continue
            self.add(phase)
            self.db_exec('UPDATE tickets SET phase=? WHERE id=?', (phase, phase))
        self.add('retired')
        self.db_exec("UPDATE tickets SET phase='done', retired_at='2020-01-01' WHERE id='retired'")
        before = self.db_exec('SELECT * FROM tickets ORDER BY id')
        unrelated = os.path.join(self.projects, 'uninitialized')
        os.makedirs(unrelated)
        with open(os.path.join(unrelated, '.orch'), 'w') as f:
            f.write('')
        p = self.orch('reconcile', '--json')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        json.loads(p.stdout)
        self.assertEqual(before, self.db_exec('SELECT * FROM tickets ORDER BY id'))
        self.assertFalse(os.path.exists(os.path.join(unrelated, '.agents')))

    def test_dirty_files_and_hook_edits_preserved_with_deduplicated_attention(self):
        for relative in ('README', 'untracked', 'scripts/retire-worktree.sh'):
            with self.subTest(relative=relative):
                tid = str(60 + len(self.db_exec('SELECT id FROM tickets'))) if os.path.exists(self.db_path()) else '60'
                path = self.completed(tid)
                target = os.path.join(path, relative)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                data = b'#!/bin/sh\n# valuable uncommitted work\n'
                with open(target, 'wb') as f:
                    f.write(data)
                for _ in range(2):
                    p = self.reconcile()
                    self.assertNotEqual(p.returncode, 0)
                    output = p.stdout + p.stderr
                    for value in (self.root, tid, path):
                        self.assertIn(value, output)
                    self.assertFalse(is_retired(self.show(tid)))
                    with open(target, 'rb') as f:
                        self.assertEqual(f.read(), data)
                with open(self.notifications) as f:
                    notices = f.readlines()
                self.assertEqual(len(notices), int(tid) - 59)

    def test_old_but_live_retirement_marker_not_stolen_by_manual_retire(self):
        path = self.completed()
        marker = json.dumps({'token': 'live-owner', 'op': 'retire', 'pid': os.getpid(),
                             'at': '2000-01-01T00:00:00+00:00'})
        self.db_exec('UPDATE tickets SET launching=? WHERE id=?', (marker, '50'))
        p = self.orch('retire', '50')
        self.assertNotEqual(p.returncode, 0, 'live marker stolen solely because it is old')
        self.assertTrue(os.path.isdir(path))
        self.assertFalse(is_retired(self.show('50')))
        self.assertEqual(self.db_exec('SELECT launching FROM tickets WHERE id=?', ('50',))[0][0], marker)

    def test_overlapping_reconciles_emit_one_event(self):
        path = self.completed()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.reconcile(), range(2)))
        for p in results:
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)

    def test_adapter_failure_is_not_complete_and_retry_converges(self):
        path = self.completed()
        os.makedirs(os.path.join(path, '.ddev'))
        # Use git's exclude file so provisioned files are ignored.
        exclude = subprocess.check_output(['git', '-C', path, 'rev-parse',
                                           '--git-path', 'info/exclude'], text=True).strip()
        with open(exclude, 'a') as f:
            f.write('\n.ddev/\n')
        self.stub('ddev', 'echo adapter-offline >&2\nexit 1\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(is_retired(self.show('50')))
        self.stub('ddev', 'exit 0\n')
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)

    def test_branch_delete_failure_after_checkout_removal_survives_retry(self):
        path = self.completed()
        real_git = shutil.which('git', path=os.environ['PATH'])
        fail = os.path.join(self.tmp, 'fail-branch')
        with open(fail, 'w'):
            pass
        self.stub('git', 'case " $* " in\n*" branch -D "*) if [ -f ' + self.quote(fail) +
                  ' ]; then echo branch-delete-failed >&2; exit 1; fi;;\nesac\nexec ' +
                  self.quote(real_git) + ' "$@"\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(is_retired(self.show('50')))
        self.assertFalse(os.path.exists(path), 'fixture must reach partial checkout teardown')
        os.unlink(fail)
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)

    def test_dirty_content_appearing_during_teardown_is_not_force_removed(self):
        path = self.completed()
        target = os.path.join(path, 'late-work')
        hook = self.stub('late-hook', 'printf valuable > ' + self.quote(target) + '\n')
        p = self.reconcile(env={'RETIRE_HOOK': hook})
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(is_retired(self.show('50')))
        self.assertTrue(os.path.isfile(target), p.stdout + p.stderr)
        with open(target) as f:
            self.assertEqual(f.read(), 'valuable')

    def test_failed_ticket_does_not_stop_healthy_ticket(self):
        dirty = self.completed('50')
        healthy = self.completed('51')
        with open(os.path.join(dirty, 'README'), 'a') as f:
            f.write('keep me\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assert_complete('51', healthy)
        self.assertFalse(is_retired(self.show('50')))

    def test_desktop_automatic_cleanup_defers_with_manual_recovery(self):
        path = self.completed()
        self.db_exec("UPDATE tickets SET platform='desktop' WHERE id='50'")
        for _ in range(2):
            p = self.reconcile()
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('retire', p.stdout + p.stderr)
            self.assertIn('50', p.stdout + p.stderr)
            self.assertFalse(is_retired(self.show('50')))
            self.assertTrue(os.path.isdir(path))
        p = self.ok('retire', '50')
        self.assertEqual(json.loads(p.stdout)['action'], 'desktop_archive')

    def test_invalid_project_does_not_stop_other_project(self):
        path = self.completed()
        invalid = os.path.join(self.projects, 'invalid')
        os.makedirs(os.path.join(invalid, '.agents', 'orchestration'))
        with open(os.path.join(invalid, '.orch'), 'w') as f:
            f.write('MAIN_CHECKOUT=missing\n')
        with open(os.path.join(invalid, '.agents', 'orchestration', 'state.db'), 'w') as f:
            f.write('not a database')
        p = self.orch('reconcile')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(invalid, p.stdout + p.stderr)
        self.assert_complete('50', path)

    def test_unregistered_nonempty_directory_is_not_retired(self):
        path = self.completed()
        subprocess.run(['git', '-C', self.repo, 'worktree', 'remove', path],
                       check=True, env=self.env)
        os.makedirs(path)
        target = os.path.join(path, 'valuable')
        with open(target, 'w') as f:
            f.write('keep')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(is_retired(self.show('50')))
        self.assertIn(path, p.stdout + p.stderr)
        with open(target) as f:
            self.assertEqual(f.read(), 'keep')

    def test_project_override_cannot_redirect_cleanup(self):
        path = self.completed()
        wrong = os.path.join(self.tmp, 'wrong-state')
        p = self.reconcile(env={'ORCH_HOME': wrong})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)
        self.assertFalse(os.path.exists(wrong))


if __name__ == '__main__':
    unittest.main()
