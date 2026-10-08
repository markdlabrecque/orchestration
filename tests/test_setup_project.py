"""Black-box setup-project relocation tests; every checkout is disposable."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "skills/setup-project/scripts/setup-project.sh"


class SetupProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="setup-project-test-")
        self.addCleanup(self.temp.cleanup)
        self.projects = Path(self.temp.name) / "Projects with spaces"
        self.root = self.projects / "project with spaces"
        self.root.mkdir(parents=True)
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("ORCH_", "GIT_"))}
        self.env.update(ORCH_PROJECTS_DIR=str(self.projects),
                        GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.com",
                        GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.com",
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

    def git(self, directory, *args):
        return subprocess.run(["git", "-C", str(directory), *args], env=self.env,
                              text=True, capture_output=True, check=True).stdout.strip()

    def checkout(self, directory=None, origin_head=True):
        directory = directory or self.root
        directory.mkdir(parents=True, exist_ok=True)
        self.git(directory, "init", "-q", "-b", "feature")
        (directory / "tracked.txt").write_text("tracked\n")
        self.git(directory, "add", "tracked.txt")
        self.git(directory, "commit", "-qm", "fixture")
        if origin_head:
            self.git(directory, "update-ref", "refs/remotes/origin/main", "HEAD")
            self.git(directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        return directory

    def run_setup(self, *args, cwd=None):
        return subprocess.run(["bash", str(SCRIPT), *args], cwd=cwd or self.root,
                              env=self.env, input="", capture_output=True, text=True, timeout=30)

    def snapshot(self, directory=None):
        directory = directory or self.root
        result = {}
        for parent, dirs, files in os.walk(directory, followlinks=False):
            for name in dirs + files:
                path = Path(parent) / name
                key = str(path.relative_to(directory))
                if path.is_symlink():
                    result[key] = ("link", os.readlink(path))
                elif path.is_dir():
                    result[key] = ("directory", path.stat().st_mode)
                else:
                    result[key] = ("file", path.stat().st_mode, path.read_bytes())
        return result

    def assert_refused_unchanged(self, *args, cwd=None):
        before = self.snapshot()
        result = self.run_setup(*args, cwd=cwd)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.snapshot(), before, result.stderr)
        return result

    def assert_config(self, checkout="main", base="main"):
        text = (self.root / ".orch").read_text()
        for line in ["PROJECT_NAME=project with spaces", f"MAIN_CHECKOUT=code/{checkout}",
                     "WORKTREE_ROOT=code", f"BASE_BRANCH={base}",
                     "ACCESSIBILITY_TESTS=false", "# DB_DUMP=", "# PROVISION_HOOK=", "# RETIRE_HOOK="]:
            self.assertIn(line + "\n", text)
        self.assertTrue((self.root / ".agents/orchestration").is_dir())

    def test_no_confirmation_and_force_alone_refuse_without_mutation(self):
        self.checkout()
        for args in [(), ("--force",)]:
            with self.subTest(args=args):
                result = self.assert_refused_unchanged(*args)
                self.assertIn("--relocate-checkout", result.stderr,
                              "Refusal must explain the separate relocation consent flag")

    def test_approved_move_preserves_checkout_history_hidden_files_and_outer_state(self):
        self.checkout()
        head = self.git(self.root, "rev-parse", "HEAD")
        (self.root / ".hidden").write_bytes(b"hidden\x00data")
        (self.root / "..double-hidden").write_text("double")
        (self.root / "untracked folder").mkdir()
        (self.root / "untracked folder/file").write_text("untracked")
        (self.root / "link").symlink_to("tracked.txt")
        (self.root / "dangling").symlink_to("absent")
        (self.root / ".agents/orchestration").mkdir(parents=True)
        (self.root / ".agents/orchestration/state").write_bytes(b"keep state")
        state = self.snapshot(self.root / ".agents")
        before = self.snapshot()
        result = self.run_setup("--relocate-checkout")
        self.assertEqual(result.returncode, 0, result.stderr)
        main = self.root / "code/main"
        self.assertEqual(self.snapshot(main), {k: v for k, v in before.items()
                                             if k != ".agents" and not k.startswith(".agents/")})
        self.assertEqual(self.snapshot(self.root / ".agents"), state)
        self.assertEqual(self.git(main, "rev-parse", "HEAD"), head)
        self.assertEqual(self.git(main, "branch", "--show-current"), "feature")
        self.assertEqual(self.root.name, "project with spaces")
        self.assertEqual(set(p.name for p in self.root.iterdir()), {"code", ".orch", ".agents"})
        self.assert_config()

    def test_missing_origin_head_warns_and_keeps_empty_default(self):
        self.checkout(origin_head=False)
        result = self.run_setup("--relocate-checkout")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_config(base="")
        self.assertIn("could not read origin/HEAD", result.stderr)

    def test_existing_orch_requires_force_then_stays_at_outer_root(self):
        self.checkout()
        (self.root / ".orch").write_text("old config\n")
        self.assert_refused_unchanged("--relocate-checkout")
        result = self.run_setup("--force", "--relocate-checkout")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_config()
        self.assertFalse((self.root / "code/main/.orch").exists())

    def test_any_existing_code_entry_is_refused_before_mutation(self):
        self.checkout()
        external = Path(self.temp.name) / "external"
        external.mkdir()
        (external / "sentinel").write_text("keep")
        external_before = self.snapshot(external)
        code = self.root / "code"
        for kind in ["empty directory", "file", "symlink", "dangling symlink", "populated directory"]:
            with self.subTest(kind=kind):
                if kind.endswith("directory"):
                    code.mkdir()
                    if kind == "populated directory":
                        (code / "sentinel").write_text("keep")
                elif kind == "file":
                    code.write_text("keep")
                else:
                    code.symlink_to(external if kind == "symlink" else external / "absent")
                self.assert_refused_unchanged("--relocate-checkout", "--force")
                self.assertEqual(self.snapshot(external), external_before)
                if code.is_symlink() or code.is_file():
                    code.unlink()
                else:
                    for child in code.iterdir():
                        child.unlink()
                    code.rmdir()

    def test_symlinked_git_is_refused_without_touching_target(self):
        self.checkout()
        target = Path(self.temp.name) / "git metadata"
        (self.root / ".git").rename(target)
        (self.root / ".git").symlink_to(target, target_is_directory=True)
        before = self.snapshot(target)
        self.assert_refused_unchanged("--relocate-checkout")
        self.assertEqual(self.snapshot(target), before)

    def test_linked_worktree_git_file_is_not_relocated(self):
        source = Path(self.temp.name) / "source"
        self.checkout(source)
        self.git(source, "worktree", "add", "--detach", str(self.root))
        self.assertTrue((self.root / ".git").is_file())
        self.assert_refused_unchanged("--relocate-checkout")

    def test_subdirectory_invocation_never_relocates_root_checkout(self):
        self.checkout()
        subdir = self.root / "subdir"
        subdir.mkdir()
        self.assert_refused_unchanged("--relocate-checkout", cwd=subdir)

    def test_arranged_layout_is_unchanged_with_or_without_flag(self):
        main = self.checkout(self.root / "code/existing checkout")
        for args in [(), ("--relocate-checkout", "--force")]:
            with self.subTest(args=args):
                before = self.snapshot(main)
                result = self.run_setup(*args, cwd=main)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.snapshot(main), before)
                self.assert_config(checkout="existing checkout")

    def test_root_checkout_cannot_bypass_consent_via_arranged_child(self):
        self.checkout()
        self.checkout(self.root / "code/child")
        self.assert_refused_unchanged()
        self.assert_refused_unchanged("--force")


if __name__ == "__main__":
    unittest.main()
