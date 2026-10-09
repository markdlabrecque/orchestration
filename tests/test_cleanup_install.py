"""Explicit cleanup installation without contacting systemd or real HOME."""
import os
import subprocess
import tempfile
import unittest

INSTALL = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', 'scripts/install-local'))


class CleanupInstallTests(unittest.TestCase):
    def test_explicit_install_status_disable_uninstall(self):
        with tempfile.TemporaryDirectory(prefix='cleanup-install-') as tmp:
            config = os.path.join(tmp, 'config')
            bin_dir = os.path.join(tmp, 'bin')
            os.makedirs(bin_dir)
            log = os.path.join(tmp, 'systemctl-calls')
            systemctl = os.path.join(bin_dir, 'systemctl')
            with open(systemctl, 'w') as f:
                f.write('#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG"\n'
                        'echo "test-user-manager: active"\n')
            os.chmod(systemctl, 0o755)
            env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=config,
                       PATH=bin_dir + os.pathsep + os.environ['PATH'],
                       TEST_SYSTEMCTL_LOG=log)
            projects = os.path.join(tmp, 'Projects space % $ \\')
            os.makedirs(projects)
            def run(action, *args):
                p = subprocess.run([INSTALL, 'cleanup', action, *args], env=env,
                                   capture_output=True, text=True, timeout=30)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                return p
            run('install', '--projects-dir', projects)
            units_dir = os.path.join(config, 'systemd', 'user')
            units = [os.path.join(units_dir, name) for name in os.listdir(units_dir)
                     if name.endswith(('.service', '.timer'))]
            self.assertEqual(len(units), 2)
            service = next(path for path in units if path.endswith('.service'))
            timer = next(path for path in units if path.endswith('.timer'))
            with open(service) as f:
                text = f.read()
            self.assertIn('Type=oneshot', text)
            self.assertIn('reconcile', text)
            self.assertIn('PATH=', text)
            self.assertIn('%%', text, 'literal percent must not expand as a systemd specifier')
            self.assertIn('StandardOutput=journal', text)
            with open(timer) as f:
                timer_text = f.read()
            self.assertTrue('OnStartupSec=' in timer_text or
                            ('OnCalendar=' in timer_text and 'Persistent=true' in timer_text))
            status = run('status')
            self.assertIn('test-user-manager: active', status.stdout)
            self.assertIn('journalctl', status.stdout)
            run('disable')
            self.assertTrue(all(os.path.isfile(path) for path in units))
            foreign = os.path.join(units_dir, 'unrelated.service')
            with open(foreign, 'w') as f:
                f.write('leave intact')
            run('uninstall')
            self.assertTrue(os.path.isfile(foreign))
            self.assertTrue(all(not os.path.exists(path) for path in units))
            with open(log) as f:
                calls = f.readlines()
            self.assertTrue(calls)
            self.assertTrue(all('--user' in call for call in calls))
            for command in ('daemon-reload', 'enable', 'disable', 'stop'):
                self.assertTrue(any(command in call for call in calls), calls)
            self.assertFalse(any('linger' in call for call in calls))


if __name__ == '__main__':
    unittest.main()
