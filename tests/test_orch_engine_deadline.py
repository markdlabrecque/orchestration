"""Provisioning has no retirement deadline; engine cleanup precedes return."""
import contextlib
import io
import os
import signal
import subprocess
import tempfile
import unittest
from unittest import mock

from test_orch_adapters import load_orch_module


class EngineDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.orch = load_orch_module()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.tmp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.path = os.path.join(self.tmp, '66')
        os.mkdir(self.path)
        self.stderr = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.command = self.patch('engine_command', return_value=(['fake-engine'], {}))

    def patch(self, name, **kwargs):
        return self.stack.enter_context(mock.patch.object(self.orch, name, **kwargs))

    def process(self, communicate, rc=0):
        process = mock.Mock(pid=660066, returncode=rc)
        process.communicate.side_effect = communicate
        popen = self.stack.enter_context(mock.patch.object(
            self.orch.subprocess, 'Popen', return_value=process))
        return process, popen

    def provision_process(self):
        def communicate(*args, **kwargs):
            self.assertIsNone(kwargs.get('timeout'),
                              'create provisioning must not inherit the 300-second retirement deadline')
            return 'provisioned\n', None
        return self.process(communicate)

    def test_initial_create_engine_has_no_retirement_deadline(self):
        process, popen = self.provision_process()
        self.patch('main_checkout', return_value=self.tmp)
        self.patch('base_branch', return_value=('main', '.orch'))
        self.patch('git_worktrees', side_effect=[[], [self.path]])
        self.patch('git_branches', return_value=set())
        self.assertEqual(self.orch.create_worktree('headless', '66'), (self.path, None))
        self.command.assert_called_once_with('create', self.tmp)
        self.assertEqual(popen.call_args.args[0], ['fake-engine', '66'])
        self.assertEqual(popen.call_args.kwargs['env']['BASE_BRANCH'], 'main')
        process.communicate.assert_called_once()

    def test_orca_reprovision_engine_has_no_retirement_deadline(self):
        process, popen = self.provision_process()
        self.patch('main_checkout', return_value=self.tmp)
        self.patch('base_branch', return_value=('main', '.orch'))
        tool = self.patch('call_tool_json', return_value={
            'result': {'worktree': {'path': self.path, 'id': 'wt66'}}})
        self.assertEqual(self.orch.create_worktree('orca', '66'),
                         (self.path, {'orca_worktree': 'wt66'}))
        self.command.assert_called_once_with('create', self.tmp)
        self.assertEqual(popen.call_args.args[0], ['fake-engine', '--provision'])
        self.assertEqual(popen.call_args.kwargs['cwd'], self.path)
        self.assertEqual(popen.call_args.kwargs['env']['BASE_BRANCH'], 'main')
        # Orca's separate worktree-create API timeout is not this engine deadline.
        self.assertEqual(tool.call_args.kwargs['timeout'], 300)
        process.communicate.assert_called_once()

    def test_retirement_timeout_kills_group_then_reaps_before_return(self):
        events = []
        def communicate(*args, **kwargs):
            events.append(('communicate', kwargs.get('timeout')))
            if len(events) == 1:
                raise subprocess.TimeoutExpired('fake-engine', 300)
            self.assertEqual(events[-2], ('killpg', 660066, signal.SIGKILL))
            return 'partial retirement output\n', None
        self.process(communicate)
        self.stack.enter_context(mock.patch.object(
            self.orch.os, 'killpg', side_effect=lambda pid, sig: events.append(('killpg', pid, sig))))
        result = self.orch.run_engine('retire', self.tmp, ['66'], self.tmp)
        events.append(('returned',))
        self.assertEqual(events, [('communicate', 300),
                                 ('killpg', 660066, signal.SIGKILL),
                                 ('communicate', None), ('returned',)])
        self.assertEqual(result, (124, 'worktree engine timed out after 300 seconds'))
        self.assertEqual(self.stderr.getvalue(), 'partial retirement output\n')

    def test_interrupt_kills_and_reaps_before_reraising_for_both_kinds(self):
        for kind in ('create', 'retire'):
            with self.subTest(kind=kind):
                events = []
                def communicate(*args, **kwargs):
                    events.append('communicate')
                    if len(events) == 1:
                        raise KeyboardInterrupt()
                    self.assertEqual(events, ['communicate', 'killpg', 'communicate'])
                    return 'interrupted output\n', None
                process, _ = self.process(communicate)
                with mock.patch.object(self.orch.os, 'killpg',
                                       side_effect=lambda pid, sig: events.append('killpg')) as kill:
                    with self.assertRaises(KeyboardInterrupt):
                        self.orch.run_engine(kind, self.tmp, [], self.tmp)
                    kill.assert_called_once_with(process.pid, signal.SIGKILL)
                self.assertEqual(process.communicate.call_count, 2)
        self.assertEqual(self.stderr.getvalue(), 'interrupted output\n' * 2)

    def test_already_exited_group_still_reaps_after_timeout(self):
        process, _ = self.process([subprocess.TimeoutExpired('fake-engine', 300),
                                   ('final output\n', None)])
        with mock.patch.object(self.orch.os, 'killpg', side_effect=ProcessLookupError):
            self.assertEqual(self.orch.run_engine('retire', self.tmp, [], self.tmp)[0], 124)
        self.assertEqual(process.communicate.call_args_list,
                         [mock.call(timeout=300), mock.call()])
        self.assertEqual(self.stderr.getvalue(), 'final output\n')

    def test_normal_output_tail_status_and_process_contract(self):
        output = ''.join('line %d\n' % n for n in range(20))
        for kind in ('create', 'retire'):
            with self.subTest(kind=kind):
                _, popen = self.process([(output, None)], rc=7)
                self.assertEqual(self.orch.run_engine(kind, self.tmp, ['66'], self.tmp),
                                 (7, '\n'.join(output.splitlines()[-12:])))
                options = popen.call_args.kwargs
                self.assertTrue(options['start_new_session'])
                self.assertEqual(options['stdin'], subprocess.DEVNULL)
                self.assertEqual(options['stdout'], subprocess.PIPE)
                self.assertEqual(options['stderr'], subprocess.STDOUT)
                self.assertTrue(options['text'])
                self.assertEqual(options['errors'], 'replace')
        self.assertEqual(self.stderr.getvalue(), output * 2)

    def test_spawn_error_returns_127_without_killing_any_group(self):
        with mock.patch.object(self.orch.subprocess, 'Popen', side_effect=OSError('unavailable')):
            with mock.patch.object(self.orch.os, 'killpg') as kill:
                self.assertEqual(self.orch.run_engine('create', self.tmp, [], self.tmp),
                                 (127, 'fake-engine: unavailable'))
                kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
