"""Engines run under whatever bash is first on PATH; stock macOS ships 3.2."""
import glob
import os
import re
import unittest

ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), '../..'))
SCRIPTS = sorted(glob.glob(os.path.join(ROOT, 'scripts/worktree/*/scripts/*.sh'))
                 + [os.path.join(ROOT, 'scripts/orch-project.sh')])
BASH4_ONLY = re.compile(r'^[^#\n]*\b(mapfile|readarray)\b', re.M)


class Bash32CompatTests(unittest.TestCase):
    def test_no_bash4_array_builtins_in_engine_scripts(self):
        self.assertTrue(SCRIPTS)
        for path in SCRIPTS:
            with self.subTest(script=os.path.relpath(path, ROOT)):
                with open(path) as f:
                    self.assertIsNone(BASH4_ONLY.search(f.read()),
                                      'mapfile/readarray need bash 4; stock macOS has 3.2')


if __name__ == '__main__':
    unittest.main()
