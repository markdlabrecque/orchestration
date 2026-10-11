"""A suite run from inside Herdr/Orca/Claude must not be detected as such."""
import os
import unittest
from unittest import mock

import test_orch
import test_setup_project

LEAKS = {'HERDR_PANE_ID': '1', 'HERDR_WORKSPACE_ID': 'w', 'ORCA_WORKTREE': 'x',
         'CLAUDE_CODE_ENTRYPOINT': 'cli', 'CLAUDECODE': '1'}


class EnvScrubTests(unittest.TestCase):
    def check(self, case):
        with mock.patch.dict(os.environ, LEAKS):
            case.setUp()
        self.addCleanup(case.doCleanups)
        self.assertEqual({k for k in LEAKS if k in case.env}, set())

    def test_orch_cases_scrub_platform_env(self):
        self.check(test_orch.OrchTestCase('run'))

    def test_setup_project_scrubs_platform_env(self):
        self.check(test_setup_project.SetupProjectTests('run'))


if __name__ == '__main__':
    unittest.main()
