"""Git metadata relocation regression, using only disposable checkouts."""
import unittest

import test_setup_project as fixtures


class SetupProjectGitSymlinkSafetyTests(unittest.TestCase):
    setUp = fixtures.SetupProjectTests.setUp
    git = fixtures.SetupProjectTests.git
    checkout = fixtures.SetupProjectTests.checkout
    run_setup = fixtures.SetupProjectTests.run_setup
    snapshot = fixtures.SetupProjectTests.snapshot
    assert_refused_unchanged = fixtures.SetupProjectTests.assert_refused_unchanged

    def test_relative_object_store_symlink_refuses_without_mutation(self):
        self.checkout()
        store = self.projects / "object-store"
        objects = self.root / ".git/objects"
        objects.rename(store)
        objects.symlink_to("../../object-store", target_is_directory=True)
        self.assertEqual(self.git(self.root, "cat-file", "-t", "HEAD"), "commit")
        before = self.snapshot(self.projects)

        result = self.assert_refused_unchanged("--relocate-checkout")

        self.assertIn("symlink", result.stderr.lower())
        self.assertEqual(self.snapshot(self.projects), before)
        self.assertEqual(self.git(self.root, "cat-file", "-t", "HEAD"), "commit")


if __name__ == "__main__":
    unittest.main()
