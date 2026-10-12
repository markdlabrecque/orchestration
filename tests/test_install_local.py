"""install-local links ~/bin/orch-update, without touching real HOME or harnesses."""
import os
import subprocess
import tempfile
import unittest

INSTALL = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', 'scripts/install-local'))


class OrchUpdateLinkTests(unittest.TestCase):
    def run_install(self, home):
        # No claude, codex or pi on PATH: only the link step does anything.
        env = dict(os.environ, HOME=home, PATH='/usr/bin:/bin')
        p = subprocess.run([INSTALL], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p

    def test_links_and_repoints_orch_update(self):
        with tempfile.TemporaryDirectory(prefix='install-local-') as home:
            link = os.path.join(home, 'bin', 'orch-update')
            self.run_install(home)
            self.assertEqual(os.readlink(link), INSTALL)
            os.remove(link)
            os.symlink('/elsewhere/install-local', link)
            self.run_install(home)
            self.assertEqual(os.readlink(link), INSTALL)

    def test_leaves_a_real_file_alone(self):
        with tempfile.TemporaryDirectory(prefix='install-local-') as home:
            os.makedirs(os.path.join(home, 'bin'))
            path = os.path.join(home, 'bin', 'orch-update')
            with open(path, 'w') as f:
                f.write('mine\n')
            p = self.run_install(home)
            self.assertFalse(os.path.islink(path))
            self.assertIn('not a symlink', p.stderr)


if __name__ == '__main__':
    unittest.main()
