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
            calls = f.read()
        self.assertIn('delete', calls)
        self.assertNotIn('--force', calls)
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
        self.stub('git', 'case " $* " in\n*" update-ref --no-deref -d "*) if [ -f ' + self.quote(fail) +
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

    def notices(self):
        if not os.path.exists(self.notifications):
            return []
        with open(self.notifications) as f:
            return f.readlines()

    def test_failed_notification_retries_and_concurrent_failures_deduplicate(self):
        path = self.completed()
        with open(os.path.join(path, 'untracked'), 'w') as f:
            f.write('keep')
        self.stub('notify-send', 'exit 1\n')
        self.assertNotEqual(self.reconcile().returncode, 0)
        self.assertFalse(self.notices())
        self.stub('notify-send', 'echo "$*" >> ' + self.quote(self.notifications) + '\n')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: self.reconcile(), range(3)))
        self.assertEqual(len(self.notices()), 1)
        self.assertFalse(is_retired(self.show('50')))
        with open(os.path.join(path, 'second-file'), 'w') as f:
            f.write('changed failure')
        self.reconcile()
        self.assertEqual(len(self.notices()), 2)
        os.unlink(os.path.join(path, 'untracked'))
        os.unlink(os.path.join(path, 'second-file'))
        self.assertEqual(self.reconcile().returncode, 0)
        with open(os.path.join(self.state_dir, 'cleanup-notifications.json')) as f:
            self.assertNotIn('50', json.load(f))

    def test_notification_storage_failure_does_not_stop_cleanup(self):
        path = self.completed()
        os.mkdir(os.path.join(self.state_dir, 'cleanup-notifications.json.lock'))
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('notification', p.stderr)
        self.assert_complete('50', path)

    def test_unavailable_discovery_root_reports_json_attention(self):
        missing = os.path.join(self.tmp, 'unavailable-projects')
        p = self.orch('reconcile', '--json', env={'ORCH_PROJECTS_DIR': missing})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(missing, p.stderr)
        self.assertNotIn('Traceback', p.stderr)
        self.assertEqual(json.loads(p.stdout)['outcomes'][0]['outcome'], 'attention')
        self.assertFalse(os.path.exists(missing))

    def test_project_notification_resolution_and_recurrence(self):
        self.init()
        with open(os.path.join(self.root, '.orch')) as f:
            original = f.read()
        for count in (1, 2):
            self.write_orch('MAIN_CHECKOUT=missing\n')
            for _ in range(2):
                self.assertNotEqual(self.reconcile().returncode, 0)
            self.assertEqual(len(self.notices()), count)
            with open(os.path.join(self.root, '.orch'), 'w') as f:
                f.write(original)
            self.assertEqual(self.reconcile().returncode, 0)

    def test_live_nonleader_session_refuses_before_checkout_removal(self):
        import sys
        path = self.completed()
        sid = 'disposable-session-identity'
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', sid])
        try:
            self.db_exec("UPDATE tickets SET pid=?, pid_start=NULL, session_id=?, activity=NULL WHERE id='50'",
                         (child.pid, sid))
            p = self.reconcile()
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('group leader', p.stderr)
            self.assertIsNone(child.poll())
            self.assertTrue(os.path.isdir(path))
            self.assertFalse(is_retired(self.show('50')))
        finally:
            child.terminate()
            child.wait(timeout=5)
        self.assertEqual(self.reconcile().returncode, 0)
        self.assert_complete('50', path)

    def test_orca_hook_writes_refuse_before_adapter_removal(self):
        path = self.completed()
        self.db_exec("UPDATE tickets SET platform='orca' WHERE id='50'")
        target = os.path.join(path, 'late-edit')
        called = os.path.join(self.tmp, 'orca-called')
        self.stub('orca', 'touch ' + self.quote(called) + '\nexit 1\n')
        hook = self.stub('write-hook', 'printf valuable > ' + self.quote(target) + '\n')
        p = self.reconcile(env={'RETIRE_HOOK': hook})
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(os.path.exists(called), 'dirty hook content reached external deletion')
        with open(target) as f:
            self.assertEqual(f.read(), 'valuable')
        self.assertFalse(is_retired(self.show('50')))

    def test_git_status_failure_preserves_worktree(self):
        path = self.completed()
        real_git = shutil.which('git', path=os.environ['PATH'])
        self.stub('git', 'case " $* " in *" status "*) echo status-unavailable >&2; exit 1;; esac\nexec ' +
                  self.quote(real_git) + ' "$@"\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('status', p.stderr)
        self.assertTrue(os.path.isdir(path))
        self.assertFalse(is_retired(self.show('50')))

    def test_trust_failure_retains_pending_cleanup(self):
        path = self.completed()
        self.db_exec("UPDATE tickets SET trust_marked=1 WHERE id='50'")
        with open(self.claude_json, 'w') as f:
            f.write('invalid config, preserve exactly')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('trust', p.stderr)
        self.assertTrue(os.path.isdir(path))
        self.assertFalse(is_retired(self.show('50')))
        with open(self.claude_json) as f:
            self.assertEqual(f.read(), 'invalid config, preserve exactly')
        with open(self.claude_json, 'w') as f:
            json.dump({'projects': {path: {'hasTrustDialogAccepted': True}}}, f)
        self.assertEqual(self.reconcile().returncode, 0)
        self.assert_complete('50', path)

    def test_session_close_retry_requires_confirmed_absence(self):
        path = self.completed()
        self.db_exec("UPDATE tickets SET platform='herdr', launch_ref=? WHERE id='50'",
                     (json.dumps({'workspace': 'disposable-workspace'}),))
        calls = os.path.join(self.tmp, 'herdr-calls')
        body = 'echo "$*" >> ' + self.quote(calls) + '\n'
        self.stub('herdr', body + 'echo \'{"error":{"code":"offline","message":"offline"}}\'\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertTrue(os.path.isdir(path))
        self.assertFalse(is_retired(self.show('50')))
        self.stub('herdr', body + 'case "$*" in *list*) echo \'{"result":{"workspaces":[]}}\';; *) echo \'{"error":{"code":"missing","message":"already absent"}}\';; esac\n')
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assert_complete('50', path)
        with open(calls) as f:
            self.assertNotIn('--force', f.read())

    def assert_malformed_inventory_continues(self, platform, resource, field, launch_ref):
        path = self.completed()
        self.db_exec("UPDATE tickets SET platform=?, launch_ref=? WHERE id='50'",
                     (platform, json.dumps(launch_ref)))
        # Discover a second real disposable project after the failing project.
        other = ReconcileTests('test_standalone_completed_cleanup_and_idempotence')
        other.setUp()
        self.addCleanup(other.tearDown)
        root = os.path.join(self.projects, 'zz-healthy')
        os.rename(other.root, root)
        other.root = root
        other.repo = os.path.join(root, 'code', 'main')
        other.state_dir = os.path.join(root, '.agents', 'orchestration')
        other.env['ORCH_PROJECTS_DIR'] = self.projects

        inventory = os.path.join(self.tmp, 'inventory.json')
        calls = os.path.join(self.tmp, 'inventory-calls')
        body = ('echo "$*" >> ' + self.quote(calls) + '\n'
                'if [ "$1 $2" = ' + self.quote(resource + ' list') + ' ]; then\n'
                '  cat ' + self.quote(inventory) + '\n  exit 0\nfi\n')
        if resource == 'terminal':
            body += ('if [ "$1 $2" = "worktree rm" ]; then\n'
                     '  git -C ' + self.quote(self.repo) + ' worktree remove ' +
                     self.quote(path) + ' || exit 1\n'
                     '  echo \'{"result":{}}\'\n  exit 0\nfi\n')
        if resource == 'worktree':
            # An adapter may delete the checkout then lose its reply. A malformed
            # inventory must not discharge the remaining adapter obligation.
            body += ('if [ -d ' + self.quote(path) + ' ]; then\n'
                     '  git -C ' + self.quote(self.repo) + ' worktree remove ' +
                     self.quote(path) + ' || exit 1\nfi\n')
        body += 'echo \'{"error":{"code":"offline","message":"adapter-offline"}}\'\n'
        self.stub(platform, body)
        replies = [{}, {'result': None}, {'result': []},
                   {'result': ['malformed inventory']}, {'result': 'invalid'},
                   {'result': 1}, {'result': True}, {'result': {}},
                   *({'result': {field: value}} for value in
                     (None, {}, 'invalid', 1, True, [None], [[]], [{}]))]
        if field in ('workspaces', 'worktrees'):
            key = 'workspace_id' if field == 'workspaces' else 'path'
            replies.extend({'result': {field: [{key: value}]}}
                           for value in (None, '', [], ['invalid'], {}, {'invalid': 1}, 1, True))
            replies.append({'result': {field: [{key: 'disposable-workspace' if
                                                    field == 'workspaces' else path}]}})
        for index, reply in enumerate(replies):
            with self.subTest(platform=platform, resource=resource, reply=reply):
                tid = str(100 + index)
                healthy = self.completed(tid)
                other_path = other.completed(tid)
                with open(inventory, 'w') as f:
                    json.dump(reply, f)
                p = self.orch('reconcile', '--json')
                self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
                # Check continuation before parsing output, so an uncaught adapter
                # exception cannot masquerade as an ordinary attention result.
                self.assert_complete(tid, healthy)
                other.assert_complete(tid, other_path)
                self.assertNotIn('Traceback', p.stdout + p.stderr)
                outcomes = json.loads(p.stdout)['outcomes']
                self.assertTrue(any(o['outcome'] == 'attention' for o in outcomes))
                for value in (self.root, '50', path, 'adapter-offline'):
                    self.assertIn(value, p.stderr)
                self.assertFalse(is_retired(self.show('50')))
                self.assertFalse(any(e['kind'] == 'retire' for e in self.events('50')))
                if resource != 'worktree':
                    self.assertTrue(os.path.isdir(path))
                else:
                    self.assertFalse(os.path.exists(path))
                    self.git('show-ref', '--verify', 'refs/heads/ticket-50')
        # Confirmed empty inventory, unlike malformed inventory, allows recovery.
        with open(inventory, 'w') as f:
            json.dump({'result': {field: []}}, f)
        p = self.orch('reconcile', '--json')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)
        with open(calls) as f:
            self.assertNotIn('--force', f.read())

    def test_malformed_herdr_session_inventory_does_not_stop_reconcile(self):
        self.assert_malformed_inventory_continues(
            'herdr', 'workspace', 'workspaces', {'workspace': 'disposable-workspace'})

    def test_malformed_orca_worktree_inventory_does_not_stop_reconcile(self):
        self.assert_malformed_inventory_continues('orca', 'worktree', 'worktrees', {})

    def test_malformed_orca_session_inventory_does_not_stop_reconcile(self):
        self.assert_malformed_inventory_continues(
            'orca', 'terminal', 'terminals', {'terminal': 'disposable-terminal'})

    def test_manual_retirement_claim_defers_concurrent_reconcile(self):
        import time
        path = self.completed()
        entered = os.path.join(self.tmp, 'entered')
        release = os.path.join(self.tmp, 'release')
        hook = self.stub('blocking-hook', 'touch ' + self.quote(entered) + '\nwhile [ ! -e ' +
                         self.quote(release) + ' ]; do sleep 0.05; done\n')
        env = dict(self.env, RETIRE_HOOK=hook)
        process = subprocess.Popen([ORCH, 'retire', '50'], cwd=self.repo, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not os.path.exists(entered) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(os.path.exists(entered))
            p = self.reconcile()
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn('in progress', p.stderr)
            self.assertTrue(os.path.isdir(path))
        finally:
            with open(release, 'w'):
                pass
            stdout, stderr = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assert_complete('50', path)

    def test_finalization_rechecks_phase_and_owner(self):
        for column, value in [('phase', 'blocked'), ('launching', json.dumps({'token': 'new-owner', 'pid': os.getpid(), 'op': 'retire'}))]:
            with self.subTest(column=column):
                tid = '71' if column == 'phase' else '72'
                path = self.completed(tid)
                hook = self.stub('change-' + column, 'exec python3 -c ' + self.quote(
                    'import sqlite3; db=sqlite3.connect(' + repr(self.db_path()) + '); db.execute(' +
                    repr('UPDATE tickets SET ' + column + '=? WHERE id=?') + ', ' + repr((value, tid)) +
                    '); db.commit()') + '\n')
                p = self.reconcile(env={'RETIRE_HOOK': hook})
                self.assertFalse(is_retired(self.show(tid)), p.stdout + p.stderr)
                self.assertFalse(any(e['kind'] == 'retire' for e in self.events(tid)))
                self.assertEqual(self.db_exec('SELECT ' + column + ' FROM tickets WHERE id=?', (tid,))[0][0], value)
                self.assertFalse(os.path.exists(path), 'fixture must reach finalization after teardown')

    def test_branch_moved_after_partial_removal_is_preserved(self):
        path = self.completed()
        real_git = shutil.which('git', path=os.environ['PATH'])
        self.stub('git', 'case " $* " in *" update-ref --no-deref -d "*) exit 1;; esac\nexec ' + self.quote(real_git) + ' "$@"\n')
        self.assertNotEqual(self.reconcile().returncode, 0)
        self.assertFalse(os.path.exists(path))
        os.unlink(os.path.join(self.bin, 'git'))
        self.git('commit', '--allow-empty', '-qm', 'move branch identity')
        self.git('branch', '-f', 'ticket-50', 'HEAD')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('branch changed', p.stderr)
        self.assertFalse(is_retired(self.show('50')))
        self.git('show-ref', '--verify', 'refs/heads/ticket-50')

    def late_branch_move(self, retire, boundary='remove'):
        path = self.completed()

        def output(*args):
            return subprocess.check_output(['git', '-C', self.repo, *args],
                                           text=True, env=self.env)

        saved = output('rev-parse', 'ticket-50').strip()
        content = 'valuable commit created while retirement removes the checkout\n'
        with open(os.path.join(self.repo, 'late-content'), 'w') as f:
            f.write(content)
        self.git('add', 'late-content')
        self.git('commit', '-qm', 'concurrent work')
        moved = output('rev-parse', 'HEAD').strip()
        real_git = self.quote(shutil.which('git', path=os.environ['PATH']))
        move = (real_git + ' -C ' + self.quote(self.repo) +
                ' update-ref refs/heads/ticket-50 ' + moved + ' ' + saved + '\n')
        if boundary == 'remove':
            body = ('case " $* " in *" worktree remove "*)\n' + real_git +
                    ' "$@" || exit $?\n' + move + 'exit $?;;\nesac\n')
        else:
            # Move after every userspace identity check, at the deletion boundary.
            body = ('case " $* " in *" update-ref "*|*" branch -D "*)\n' +
                    move + ';;\nesac\n')
        self.stub('git', body + 'exec ' + real_git + ' "$@"\n')
        p = retire()
        self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse(os.path.exists(path), 'must reach checkout removal')
        os.unlink(os.path.join(self.bin, 'git'))
        for result in (p, retire()):
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('branch', result.stderr)
            self.assertIn('retirement', result.stderr)
            self.assertIn('saved identity', result.stderr)
            self.assertIn(saved, result.stderr)
            self.assertIn('retrying', result.stderr)
            self.assertFalse(is_retired(self.show('50')))
            self.assertFalse(any(e['kind'] == 'retire' for e in self.events('50')))
            self.assertEqual(output('rev-parse', 'ticket-50').strip(), moved)
            self.assertEqual(output('show', 'ticket-50:late-content'), content)
        # Explicit operator repair: keep the new commit on a recovery branch,
        # then restore the saved identity using an expected-old-value update.
        self.git('branch', 'recovered-work', moved)
        self.git('update-ref', 'refs/heads/ticket-50', saved, moved)
        p = retire()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)
        self.assertEqual(output('show', 'recovered-work:late-content'), content)

    def test_branch_moved_during_checkout_removal_stays_pending_until_repaired(self):
        self.late_branch_move(self.reconcile)

    def test_manual_retire_preserves_branch_moved_during_checkout_removal(self):
        self.late_branch_move(lambda: self.orch('retire', '50'))

    def test_branch_deletion_atomically_checks_saved_head(self):
        self.late_branch_move(self.reconcile, boundary='delete')

    def test_branch_claimed_by_other_worktree_during_removal_is_preserved(self):
        path = self.completed()
        other = os.path.join(self.root, 'code', 'other')
        real_git = self.quote(shutil.which('git', path=os.environ['PATH']))
        self.stub('git', 'case " $* " in *" worktree remove "*)\n' + real_git +
                  ' "$@" || exit $?\n' + real_git + ' -C ' + self.quote(self.repo) +
                  ' worktree add -q ' + self.quote(other) + ' ticket-50\nexit $?;;\nesac\nexec ' +
                  real_git + ' "$@"\n')
        p = self.reconcile()
        self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse(os.path.exists(path))
        self.assertIn('another worktree', p.stderr)
        self.assertFalse(is_retired(self.show('50')))
        self.git('show-ref', '--verify', 'refs/heads/ticket-50')
        self.assertTrue(os.path.isfile(os.path.join(other, 'README')))
        os.unlink(os.path.join(self.bin, 'git'))
        self.assertNotEqual(self.reconcile().returncode, 0)
        self.git('worktree', 'remove', other)
        p = self.reconcile()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)

    def test_project_override_cannot_redirect_cleanup(self):
        path = self.completed()
        wrong = os.path.join(self.tmp, 'wrong-state')
        p = self.reconcile(env={'ORCH_HOME': wrong})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assert_complete('50', path)
        self.assertFalse(os.path.exists(wrong))


if __name__ == '__main__':
    unittest.main()
