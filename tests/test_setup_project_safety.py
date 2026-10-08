"""Additional relocation safety cases, using only temporary fixtures."""
import os
from pathlib import Path
import shutil
import unittest

import test_setup_project as fixtures


class SetupProjectSafetyTests(unittest.TestCase):
    setUp = fixtures.SetupProjectTests.setUp
    git = fixtures.SetupProjectTests.git
    checkout = fixtures.SetupProjectTests.checkout
    run_setup = fixtures.SetupProjectTests.run_setup
    snapshot = fixtures.SetupProjectTests.snapshot
    assert_refused_unchanged = fixtures.SetupProjectTests.assert_refused_unchanged

    def test_unsafe_retained_paths_refuse_without_mutation(self):
        self.checkout()
        for name in [".orch", ".agents"]:
            with self.subTest(name=name):
                path = self.root / name
                path.symlink_to(Path(self.temp.name) / "absent")
                self.assert_refused_unchanged("--force", "--relocate-checkout")
                path.unlink()
        (self.root / ".agents").write_text("not a directory")
        self.assert_refused_unchanged("--relocate-checkout")

    def test_failed_move_rolls_back_checkout_and_preserves_old_config(self):
        self.checkout()
        (self.root / ".orch").write_text("old config")
        (self.root / "z-last").write_text("keep")
        tools = Path(self.temp.name) / "tools"
        tools.mkdir()
        real_mv = shutil.which("mv")
        wrapper = tools / "mv"
        wrapper.write_text('#!/bin/bash\ncase "$1" in */z-last) exit 73 ;; esac\n'
                           + f'exec "{real_mv}" "$@"\n')
        wrapper.chmod(0o755)
        self.env["PATH"] = str(tools) + os.pathsep + self.env["PATH"]
        self.assert_refused_unchanged("--force", "--relocate-checkout")

    def test_linked_worktrees_prevent_main_checkout_relocation(self):
        self.checkout()
        linked = Path(self.temp.name) / "linked"
        self.git(self.root, "worktree", "add", "--detach", str(linked))
        self.assert_refused_unchanged("--relocate-checkout")
        self.assertEqual(self.git(linked, "rev-parse", "HEAD"),
                         self.git(self.root, "rev-parse", "HEAD"))
