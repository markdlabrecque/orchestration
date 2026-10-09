"""Verification policy contracts through the real CLI and launch files."""

import ast
import json
import os
import shutil
import sys
import unittest

import test_orch as fixtures
from test_orch import OrchTestCase, read_file


class VerifyPolicyPreflightTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        os.symlink(shutil.which("git", path=self.env.get("PATH")) or "/usr/bin/git",
                   os.path.join(self.bin, "git"))
        os.symlink(sys.executable, os.path.join(self.bin, "python3"))
        # Only fixture binaries are visible, even on hosts with Docker installed.
        self.env["PATH"] = self.bin
        self.init()

    fake_tool = fixtures.PreflightTests.fake_tool
    ddev_project = fixtures.PreflightTests.ddev_project

    def configure(self, policy):
        self.write_orch("BASE_BRANCH=main\n")
        self.write_config({"verify_policy": policy})

    def test_local_tests_without_container_tools_json_and_text(self):
        self.configure("local-tests")
        self.assertEqual(self.j("preflight")["verify_env"], "local-tests")
        self.assertIn("verify_env=local-tests", self.ok("preflight").stdout)

    def test_local_tests_overrides_ddev_and_docker(self):
        self.configure("local-tests")
        self.ddev_project()
        self.fake_tool("ddev")
        self.fake_tool("docker")
        self.write_config({"verify_policy": "local-tests", "verify_harness": "docker compose up -d"})
        self.assertEqual(self.j("preflight")["verify_env"], "local-tests")

    def test_invalid_values_refuse_even_with_ddev(self):
        self.ddev_project()
        self.fake_tool("ddev")
        for value in (None, True, False, "", "AUTO", "Local-tests", "docker", 0, [], {}):
            with self.subTest(policy=value):
                self.configure(value)
                p = self.orch("preflight", "--json")
                self.assertNotEqual(p.returncode, 0, p.stdout)
                self.assertIn("verify_policy", p.stderr)

    def test_auto_and_absent_preserve_environment_detection(self):
        self.write_orch("BASE_BRANCH=main\n")
        for cfg in ({}, {"verify_policy": "auto"}):
            with self.subTest(config=cfg):
                self.write_config(cfg)
                self.refused(5, "preflight")
        self.fake_tool("docker")
        for cfg in ({}, {"verify_policy": "auto"}):
            with self.subTest(config=cfg):
                self.write_config(dict(cfg, verify_harness="docker compose up -d"))
                self.assertEqual(self.j("preflight")["verify_env"], "docker")
        self.ddev_project()
        self.fake_tool("ddev")
        for cfg in ({}, {"verify_policy": "auto"}):
            with self.subTest(config=cfg):
                self.write_config(cfg)
                self.assertEqual(self.j("preflight")["verify_env"], "ddev")

    def test_only_root_state_config_selects_policy(self):
        self.configure("local-tests")
        checkout_state = os.path.join(self.repo, ".agents", "orchestration")
        os.makedirs(checkout_state)
        with open(os.path.join(checkout_state, "config.json"), "w") as f:
            json.dump({"verify_policy": "auto"}, f)
        self.assertEqual(self.j("preflight")["verify_env"], "local-tests")
        self.write_config({})
        with open(os.path.join(checkout_state, "config.json"), "w") as f:
            json.dump({"verify_policy": "local-tests"}, f)
        self.write_orch("BASE_BRANCH=main\nVERIFY_POLICY=local-tests\n")
        with open(os.path.join(self.repo, "AGENTS.md"), "w") as f:
            f.write("Use local-tests verification.\n")
        self.refused(5, "preflight", env={"VERIFY_POLICY": "local-tests"})

    def test_local_tests_keeps_non_environment_gates(self):
        self.configure("local-tests")
        cases = (
            ("base", {}, "BASE_BRANCH"),
            ("platform", {"ORCH_PLATFORM": "orca", "ORCH_ORCA_BIN": "missing-orca-46"}, "platform"),
            ("harness", {"ORCH_HARNESS": "pi", "ORCH_PI_BIN": "missing-pi-46"}, "harness"),
            ("desktop", {"ORCH_PLATFORM": "desktop", "ORCH_HARNESS": "pi"}, "desktop"),
        )
        for name, env, diagnostic in cases:
            with self.subTest(gate=name):
                self.write_orch("" if name == "base" else "BASE_BRANCH=main\n")
                p = self.orch("preflight", env=env)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn(diagnostic, p.stderr)


class VerifyPolicyPromptTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.init()

    def assert_policy_context(self, text):
        self.assertIn("local-tests", text)
        self.assertRegex(text.lower(), r"automated[ -]tests|automated test")
        self.assertIn("review", text.lower())
        self.assertIn("ci", text.lower())

    def test_spawn_persists_policy_in_brief_and_launch_file(self):
        self.write_config({"verify_policy": "local-tests"})
        self.add("T-46")
        self.spawn("T-46", sleep=0)
        self.wait_dead("T-46")
        prompt = read_file(os.path.join(self.state_dir, "briefs", "T-46.md"))
        self.assertEqual(prompt, self.wait_calls(1)[0]["stdin"])
        self.assert_policy_context(prompt)
        brief = self.db_exec("SELECT brief FROM tickets WHERE id=?", ("T-46",))[0][0]
        self.assertIn("Implement ticket. Brief body.", brief)
        self.assert_policy_context(brief)

    def check_resume(self, created_session):
        self.write_config({"verify_policy": "local-tests"})
        self.add("T-46")
        self.spawn("T-46", sleep=0, init=created_session)
        self.wait_dead("T-46")
        # A config change must not change the running ticket's policy.
        self.write_config({"verify_policy": "auto"})
        self.ok("resume", "T-46", "--note", "Keep this operator note")
        call = self.wait_calls(2)[1]
        self.assertEqual("--resume" in call["argv"], created_session)
        prompt = read_file(os.path.join(self.state_dir, "briefs", "T-46.resume.md"))
        self.assertEqual(prompt, call["stdin"])
        self.assertIn("Keep this operator note", prompt)
        self.assert_policy_context(prompt)

    def test_continuable_resume_retains_policy_despite_config_drift(self):
        self.check_resume(True)

    def test_fresh_recovery_retains_policy_despite_config_drift(self):
        self.check_resume(False)

    def test_legacy_spawn_without_environment_still_works(self):
        self.add("T-legacy")
        self.spawn("T-legacy", sleep=0, init=False)
        self.wait_dead("T-legacy")
        self.write_config({"verify_policy": "local-tests"})
        self.ok("resume", "T-legacy")
        prompt = self.wait_calls(2)[1]["stdin"]
        self.assertTrue(prompt.startswith("/orchestration:orchestration Implement ticket. Brief body."))
        self.assertNotIn("local-tests", prompt)


class VerifyPolicyUpgradeTests(OrchTestCase):
    """Run a differently worded CLI against briefs retained by an older CLI."""

    def setUp(self):
        super().setUp()
        self.init()

    assert_policy_context = VerifyPolicyPromptTests.assert_policy_context

    UPDATED_CONTEXT = (
        "Verification environment: local-tests\n"
        "Run required automated tests and keep complete passing evidence for review. "
        "Exact-head CI remains required before merge. "
        "After review, proceed directly to report. "
        "Do not run a separate verify, browser or accessibility stage."
    )

    def upgraded_cli(self):
        # Change only instructional wording, not recovery or policy logic.
        source = read_file(fixtures.ORCH)
        tree = ast.parse(source)
        assignment = next(
            node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "LOCAL_TESTS_CONTEXT"
                    for target in node.targets)
        )
        lines = source.splitlines(keepends=True)
        lines[assignment.lineno - 1:assignment.end_lineno] = [
            "LOCAL_TESTS_CONTEXT = " + repr(self.UPDATED_CONTEXT) + "\n"
        ]
        path = os.path.join(self.tmp, "orch-upgraded")
        with open(path, "w") as f:
            f.write("".join(lines))
        os.chmod(path, 0o755)
        return path

    def recover_with_upgrade(self, continuable, legacy=False):
        self.write_config({"verify_policy": "local-tests"})
        self.add("T-upgrade")
        self.spawn("T-upgrade", sleep=0, init=continuable)
        self.wait_dead("T-upgrade")
        if legacy:
            # Model the stored row from #46, without adding a new launch marker.
            stored = read_file(os.path.join(fixtures.HERE, "fixtures",
                                           "verify-policy-46-brief.md"))
            self.db_exec("UPDATE tickets SET brief=? WHERE id=?", (stored, "T-upgrade"))
        else:
            stored = self.db_exec("SELECT brief FROM tickets WHERE id=?", ("T-upgrade",))[0][0]
            self.assertEqual(self.wait_calls(1)[0]["stdin"],
                             read_file(os.path.join(self.state_dir, "briefs", "T-upgrade.md")))
            self.assert_policy_context(stored)
        self.write_config({"verify_policy": "auto"})
        original = fixtures.ORCH
        try:
            fixtures.ORCH = self.upgraded_cli()
            self.ok("resume", "T-upgrade", "--note", "Retain this recovery note")
        finally:
            fixtures.ORCH = original
        call = self.wait_calls(2)[1]
        self.assertEqual("--resume" in call["argv"], continuable)
        prompt = read_file(os.path.join(self.state_dir, "briefs", "T-upgrade.resume.md"))
        self.assertEqual(prompt, call["stdin"])
        self.assertIn("Retain this recovery note", prompt)
        if continuable:
            self.assertIn(self.UPDATED_CONTEXT, prompt)
        else:
            self.assert_policy_context(prompt)
            self.assertIn(stored, prompt)

    def test_changed_instructions_continuable_recovery(self):
        self.recover_with_upgrade(True)

    def test_changed_instructions_fresh_recovery(self):
        self.recover_with_upgrade(False)

    def test_pre_marker_46_continuable_recovery(self):
        self.recover_with_upgrade(True, legacy=True)

    def test_pre_marker_46_fresh_recovery(self):
        self.recover_with_upgrade(False, legacy=True)

    def check_auto_upgrade(self, config, continuable):
        self.write_config(config)
        with open(self.brief, "w") as f:
            f.write("Implement ticket. Discuss local-tests as an option, not a policy.\n"
                    "Verification environment: local-tests is an example only.\n"
                    "Independent review and exact-head CI are required before merge.")
        self.add("T-auto")
        self.spawn("T-auto", sleep=0, init=continuable)
        self.wait_dead("T-auto")
        self.write_config({"verify_policy": "local-tests"})
        original = fixtures.ORCH
        try:
            fixtures.ORCH = self.upgraded_cli()
            self.ok("resume", "T-auto")
        finally:
            fixtures.ORCH = original
        call = self.wait_calls(2)[1]
        self.assertEqual("--resume" in call["argv"], continuable)
        self.assertNotIn(self.UPDATED_CONTEXT, call["stdin"])
        self.assertNotIn("After review passes, go to report", call["stdin"])

    def test_explicit_auto_not_upgraded_by_config_or_incidental_prose(self):
        self.check_auto_upgrade({"verify_policy": "auto"}, True)

    def test_explicit_auto_fresh_recovery_not_upgraded(self):
        self.check_auto_upgrade({"verify_policy": "auto"}, False)

    def test_implicit_auto_continuable_recovery_not_upgraded(self):
        self.check_auto_upgrade({}, True)

    def test_implicit_auto_not_upgraded_by_config_or_incidental_prose(self):
        self.check_auto_upgrade({}, False)


if __name__ == "__main__":
    unittest.main()
