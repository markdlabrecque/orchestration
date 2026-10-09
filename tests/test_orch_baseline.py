"""Shared baseline coordination contract; real, isolated linked Git worktrees.

The proposed CLI and JSON contract is recorded in .scratch/55-tests.md.
No harness, tracker, remote, or project state is used by these tests.
"""

import os
from pathlib import Path
import shutil
import subprocess
import time
import unittest

from test_orch import ORCH, OrchTestCase


class BaselineTests(OrchTestCase):
    def git(self, *args, cwd=None):
        return subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", *args],
            cwd=cwd or self.repo, env=self.env, check=True,
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()

    def setUp(self):
        super().setUp()
        self.env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_TERMINAL_PROMPT="0", GIT_EDITOR="true")
        self.git("config", "core.hooksPath", "/dev/null")
        self.write_orch("BASE_BRANCH=main\n")
        self.init()
        self.base = self.git("rev-parse", "HEAD")
        # Owner is deliberately last in FIFO order.
        for tid in ("affected", "unrelated", "fix"):
            self.add(tid)
        self.wt = self.link("affected")
        self.commit(self.wt, "ticket.txt", "independent work\n")
        self.old_head = self.git("rev-parse", "HEAD", cwd=self.wt)
        self.command = "python3 -m unittest discover -s tests"
        self.output = "FAIL: native walk regression reproduced on clean base"

    def link(self, tid):
        path = os.path.join(self.root, "code", tid)
        self.git("worktree", "add", "-q", "-b", tid, path, "main")
        self.db_exec("UPDATE tickets SET worktree=?, worktree_ref=? WHERE id=?",
                     (path, tid, tid))
        return path

    def commit(self, path, name, content):
        Path(path, name).write_text(content)
        self.git("add", name, cwd=path)
        self.git("commit", "-q", "-m", "fixture change " + name, cwd=path)
        return self.git("rev-parse", "HEAD", cwd=path)

    def confirm_args(self):
        return ["baseline", "confirm", "walk", "--owner", "fix",
                "--affected", "affected", "--gate", "full-suite",
                "--base-sha", self.base, "--command", self.command,
                "--output", self.output, "--verified"]

    def confirm(self):
        return self.j(*self.confirm_args())

    def baseline_record(self):
        return self.j("baseline", "show", "walk")

    def gate(self, tid="affected", gate="full-suite"):
        return self.j("baseline", "gate", tid, "--gate", gate)

    def merged_fix(self, conflict=False):
        self.fix_sha = self.commit(self.repo, "README" if conflict else "fixed.txt",
                                   "base fix\n")
        # Existing commands record the CI candidate; no tracker is needed.
        self.db_exec("UPDATE tickets SET phase='ci' WHERE id='fix'")
        self.ok("ci", "fix", "--sha", self.fix_sha, "--passed")
        self.ok("merged", "fix", "--sha", self.fix_sha)
        return self.fix_sha

    def resolve(self):
        return self.j("baseline", "resolve", "walk", "--fix-sha", self.fix_sha)

    def requested(self, conflict=False):
        self.confirm()
        self.merged_fix(conflict)
        self.resolve()

    def refresh(self):
        return self.j("baseline", "refresh", "walk", "--ticket", "affected",
                      "--stage-boundary", cwd=self.wt)

    def assert_unchanged(self):
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=self.wt), self.old_head)

    def test_state_md_tracks_resolution_guard_refusal_refresh_and_ack(self):
        state = Path(self.root, 'STATE.md')
        def published(value):
            # Check does not repair. Read before any ordinary command can repair.
            self.assertIn(value.encode(), state.read_bytes())
            self.ok('state-md', 'check')

        self.confirm()
        published(self.output)
        self.merged_fix()
        self.resolve()
        published('requested')
        Path(self.wt, 'dirty.txt').write_text('preserve local work\n')
        self.refused(3, 'baseline', 'refresh', 'walk', '--ticket', 'affected',
                     '--stage-boundary', cwd=self.wt)
        published('guard-refused')
        Path(self.wt, 'dirty.txt').unlink()
        self.refresh()
        published('success')
        head = self.git('rev-parse', 'HEAD', cwd=self.wt)
        self.ok('baseline', 'ack', 'walk', '--ticket', 'affected', '--sha', head,
                '--tests', 'publication-tests-sentinel', '--review', 'publication-review-sentinel')
        published('publication-tests-sentinel')
        published('publication-review-sentinel')
        before = state.read_bytes()
        self.ok('state-md', 'rebuild')
        self.assertEqual(state.read_bytes(), before)

    def test_confirmation_persists_evidence_and_prioritizes_only_ready_owner(self):
        self.assertEqual(self.tickets("next")[0]["id"], "affected")
        self.confirm()
        record = self.baseline_record()
        for key, value in {"id": "walk", "owner": "fix", "affected": ["affected"],
                           "gate": "full-suite", "base_sha": self.base,
                           "command": self.command, "output": self.output}.items():
            self.assertEqual(record[key], value)
        self.assertEqual(self.tickets("next")[0]["id"], "fix")
        self.assertEqual(self.gate()["action"], "wait")
        self.assertEqual(self.gate("unrelated")["action"], "clear")
        self.assertEqual(self.gate("fix")["action"], "clear")
        self.assertEqual(self.gate(gate="implementation")["action"], "clear")
        self.assertEqual(self.show("affected")["phase"], "ready")
        self.ok("run", "affected", "--role", "implementor", "--model", "standard", "--effort", "low")
        self.ok("block", "fix", "--reason", "needs decision")
        self.assertIn("affected", [t["id"] for t in self.tickets("next")])
        self.assertNotIn("fix", [t["id"] for t in self.tickets("next")])

    def test_invalid_confirmation_is_atomic_and_cannot_infer_verification(self):
        # First prove the subcommand exists, so parser rejection is not a false green.
        self.confirm()
        before = self.baseline_record()
        cases = [("--verified", None), ("--command", " "), ("--output", ""),
                 ("--base-sha", "not-a-revision"), ("--owner", "missing"),
                 ("--affected", "missing")]
        for flag, value in cases:
            with self.subTest(flag=flag):
                args = self.confirm_args()
                index = args.index(flag)
                if value is None:
                    args.pop(index)
                else:
                    args[index + 1] = value
                p = self.orch(*args)
                self.assertNotEqual(p.returncode, 0)
                self.assertNotIn("Traceback", p.stderr)
                self.assertEqual(self.baseline_record(), before)

    def test_self_owner_has_no_wait_cycle(self):
        args = self.confirm_args()
        args[args.index("--affected") + 1] = "fix"
        self.ok(*args)
        self.assertEqual(self.gate("fix")["action"], "clear")

    def test_already_merged_fix_requests_only_stale_tickets_without_mutating_git(self):
        self.merged_fix()
        self.add("current")
        current = self.link("current")
        args = self.confirm_args() + ["--affected", "current"]
        self.ok(*args)
        self.resolve()
        before = self.baseline_record()
        self.assertEqual(before["fix_sha"], self.fix_sha)
        self.assertEqual(before["refreshes"]["affected"]["status"], "requested")
        self.assertNotIn("current", before["refreshes"])
        self.assertNotIn("unrelated", before["refreshes"])
        self.assert_unchanged()
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=current), self.fix_sha)
        self.assertEqual(self.gate()["action"], "refresh")
        events = self.events("affected")
        self.resolve()
        self.assertEqual(self.baseline_record(), before)
        self.assertEqual(self.events("affected"), events)

    def test_squash_fix_revision_is_distinct_from_recorded_ci_candidate(self):
        self.confirm()
        self.fix_sha = self.commit(self.repo, "squashed.txt", "integrated fix\n")
        self.db_exec("UPDATE tickets SET phase='ci' WHERE id='fix'")
        self.ok("ci", "fix", "--sha", self.old_head, "--passed")
        self.ok("merged", "fix", "--sha", self.old_head)
        self.resolve()
        self.assertEqual(self.baseline_record()["fix_sha"], self.fix_sha)
        self.assertNotEqual(self.baseline_record()["fix_sha"], self.old_head)
        self.assertEqual(self.gate()["action"], "refresh")

    def test_resolution_requires_done_owner_and_fix_reachable_from_base(self):
        self.confirm()
        self.fix_sha = self.commit(self.repo, "fixed.txt", "fixed\n")
        self.refused(3, "baseline", "resolve", "walk", "--fix-sha", self.fix_sha)
        self.merged_fix()
        # Ticket-only candidate exists, but is not integrated into main.
        self.refused(3, "baseline", "resolve", "walk", "--fix-sha", self.old_head)
        self.assertFalse(self.baseline_record().get("fix_sha"))
        self.assert_unchanged()

    def test_refresh_preserves_work_phase_budgets_and_invalidates_revision_evidence(self):
        self.requested()
        self.db_exec("UPDATE tickets SET phase='ci' WHERE id='affected'")
        self.ok("ci", "affected", "--sha", self.old_head, "--passed")
        before = self.show("affected")
        result = self.refresh()
        new_head = self.git("rev-parse", "HEAD", cwd=self.wt)
        self.assertNotEqual(new_head, self.old_head)
        self.git("merge-base", "--is-ancestor", self.fix_sha, "HEAD", cwd=self.wt)
        self.assertEqual(Path(self.wt, "ticket.txt").read_text(), "independent work\n")
        self.assertEqual(result["status"], "success")
        after = self.show("affected")
        for key in ("phase", "bounces", "ci_repairs"):
            self.assertEqual(after[key], before[key])
        self.assertEqual(self.gate()["action"], "retest")
        self.refused(3, "merged", "affected", "--sha", self.old_head)
        self.refused(3, "merged", "affected", "--sha", new_head)
        # CI alone must not substitute for tests and independent review.
        self.ok("ci", "affected", "--sha", new_head, "--passed")
        self.refused(3, "merged", "affected", "--sha", new_head)
        self.refused(3, "baseline", "ack", "walk", "--ticket", "affected",
                     "--sha", self.old_head, "--tests", "fresh tests", "--review", "fresh review")
        self.ok("baseline", "ack", "walk", "--ticket", "affected", "--sha", new_head,
                "--tests", "full suite passed", "--review", "independent review passed")
        self.assertEqual(self.gate()["action"], "clear")
        self.ok("merged", "affected", "--sha", new_head)

    def test_dirty_tracked_staged_and_untracked_work_is_never_overwritten(self):
        self.requested()
        for mode in ("tracked", "staged", "untracked"):
            with self.subTest(mode=mode):
                path = Path(self.wt, "new.txt" if mode == "untracked" else "README")
                path.write_text("authorized partial work\n")
                if mode == "staged":
                    self.git("add", "README", cwd=self.wt)
                status = self.git("status", "--porcelain", cwd=self.wt)
                self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                             "--stage-boundary", cwd=self.wt)
                self.assert_unchanged()
                self.assertEqual(path.read_text(), "authorized partial work\n")
                self.assertEqual(self.git("status", "--porcelain", cwd=self.wt), status)
                self.assertEqual(self.baseline_record()["refreshes"]["affected"]["status"], "guard-refused")
                if mode == "untracked":
                    path.unlink()
                else:
                    self.git("restore", "--staged", "--worktree", "README", cwd=self.wt)

    def test_pending_stage_run_refuses_even_with_explicit_boundary(self):
        self.requested()
        run = self.j("run", "affected", "--role", "implementor", "--model", "standard", "--effort", "low")
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assert_unchanged()
        self.assertEqual(self.baseline_record()["refreshes"]["affected"]["status"], "guard-refused")
        # Existing SubagentStop completion evidence, not session health.
        self.db_exec("UPDATE runs SET agent_id='finished', model_resolved='claude-sonnet-test', "
                     "resolved_at='2026-01-01T00:00:00Z', match=1 WHERE seq=?", (run["seq"],))
        self.assertEqual(self.refresh()["status"], "success")

    def test_working_ticket_session_is_not_an_active_stage(self):
        self.requested()
        self.spawn("affected", sleep=60, worktree=self.wt)
        self.wait_calls(1)
        self.db_exec("UPDATE tickets SET activity='working', session_seen=1 WHERE id='affected'")
        self.assertTrue(self.show("affected")["alive"])
        self.assertEqual(self.refresh()["status"], "success")

    def test_refresh_requires_boundary_and_ticket_local_linked_correct_branch(self):
        self.requested()
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected", cwd=self.wt)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.repo)
        self.git("switch", "-q", "-c", "wrong", cwd=self.wt)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assert_unchanged()
        for path in (self.worktree, os.path.join(self.tmp, "missing")):
            self.db_exec("UPDATE tickets SET worktree=? WHERE id='affected'", (path,))
            self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                         "--stage-boundary", cwd=self.wt)
        self.assert_unchanged()

    def test_git_operation_in_progress_is_preserved(self):
        self.requested()
        marker = Path(self.git("rev-parse", "--git-path", "MERGE_HEAD", cwd=self.wt))
        marker.write_text(self.fix_sha + "\n")
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assertEqual(marker.read_text(), self.fix_sha + "\n")
        self.assert_unchanged()

    def test_dispatch_is_guarded_while_refresh_is_in_flight(self):
        self.requested()
        real_git = shutil.which("git", path=self.env.get("PATH"))
        shimdir = Path(self.tmp, "git-shim")
        shimdir.mkdir()
        entered = Path(self.tmp, "rebase-entered")
        release = Path(self.tmp, "rebase-release")
        shim = shimdir / "git"
        shim.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys, time\n"
            "if 'rebase' in sys.argv[1:]:\n"
            "    pathlib.Path(%r).touch()\n"
            "    deadline = time.monotonic() + 15\n"
            "    while not pathlib.Path(%r).exists():\n"
            "        if time.monotonic() > deadline: sys.exit(99)\n"
            "        time.sleep(0.02)\n"
            "os.execv(%r, [%r] + sys.argv[1:])\n"
            % (str(entered), str(release), real_git, real_git))
        shim.chmod(0o755)
        env = dict(self.env, PATH=str(shimdir) + os.pathsep + self.env["PATH"])
        proc = subprocess.Popen(
            [ORCH, "baseline", "refresh", "walk", "--ticket", "affected", "--stage-boundary"],
            cwd=self.wt, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not entered.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(entered.exists(), "refresh never reached Git rebase")
            self.refused(3, "run", "affected", "--role", "implementor", "--model", "standard",
                         "--effort", "low", timeout=5)
            self.assertEqual(self.j("runs", "affected")["runs"], [])
        finally:
            release.touch()
            try:
                out, err = proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise
        self.assertEqual(proc.returncode, 0, (out, err))

    def test_completion_attestation_is_local_exact_and_separate_from_routing(self):
        self.requested()
        run = self.j("run", "affected", "--role", "implementor", "--model", "standard", "--effort", "low")
        args = ["complete-run", "affected", "--run", str(run["seq"]),
                "--evidence", "child call returned; process tree stopped; handoff.txt"]
        self.refused(3, *args, cwd=self.wt)
        self.refused(3, *args, "--stopped", cwd=self.repo)
        self.refused(3, *args, "--stopped", "--evidence", " ", cwd=self.wt)
        self.refused(4, *args, "--stopped", "--run", "99999", cwd=self.wt)
        self.env["PI_SUBAGENT_CHILD"] = "1"
        try:
            self.refused(3, *args, "--stopped", cwd=self.wt)
        finally:
            self.env.pop("PI_SUBAGENT_CHILD")
        pending = self.j("runs", "affected")["runs"][0]
        self.assertIsNone(pending["completed_at"])
        finished = self.j(*args, "--stopped", cwd=self.wt)
        for field in ("agent_id", "model_resolved", "resolved_at", "match"):
            self.assertIsNone(finished[field])
        for field in ("model_requested", "tier", "effort_requested", "bounce_count"):
            self.assertEqual(finished[field], run[field])
        events = self.events("affected")
        self.assertEqual(self.j(*args, "--stopped", cwd=self.wt), finished)
        self.assertEqual(self.events("affected"), events)
        self.refused(3, *args, "--stopped", "--evidence", "changed", cwd=self.wt)
        self.assertEqual(self.refresh()["status"], "success")

    def test_one_completion_does_not_clear_other_pending_runs(self):
        self.requested()
        runs = [self.j("run", "affected", "--role", "implementor", "--model", "standard",
                       "--effort", "low") for _ in range(2)]
        self.ok("complete-run", "affected", "--run", str(runs[0]["seq"]), "--stopped",
                "--evidence", "first call returned, no child work remains", cwd=self.wt)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assert_unchanged()

    def test_ack_expires_when_candidate_changes_and_requires_integrated_fix(self):
        self.requested()
        self.refresh()
        head = self.git("rev-parse", "HEAD", cwd=self.wt)
        self.ok("baseline", "ack", "walk", "--ticket", "affected", "--sha", head,
                "--tests", "passed", "--review", "independent review passed")
        self.commit(self.wt, "more.txt", "later change\n")
        self.assertEqual(self.gate()["action"], "retest")
        self.git("reset", "--hard", self.old_head, cwd=self.wt)
        self.refused(3, "baseline", "ack", "walk", "--ticket", "affected", "--sha", self.old_head,
                     "--tests", "passed", "--review", "independent review passed")

    def test_configured_base_rewind_refuses_without_mutation(self):
        self.requested()
        self.git("reset", "--hard", self.base)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assert_unchanged()
        self.assertEqual(self.baseline_record()["refreshes"]["affected"]["status"], "guard-refused")

    def test_interrupted_refresh_reservation_requires_explicit_recovery(self):
        self.requested()
        self.db_exec("UPDATE tickets SET phase='ci' WHERE id='affected'")
        self.ok("ci", "affected", "--sha", self.old_head, "--passed")
        real_git = shutil.which("git", path=self.env.get("PATH"))
        shimdir = Path(self.tmp, "interrupt-git")
        shimdir.mkdir()
        entered, release = Path(self.tmp, "entered"), Path(self.tmp, "release")
        finished = Path(self.tmp, "git-finished")
        shim = shimdir / "git"
        shim.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, subprocess, sys, time\n"
            "if 'rebase' in sys.argv[1:]:\n"
            "    pathlib.Path(%r).touch()\n"
            "    deadline = time.monotonic() + 15\n"
            "    while not pathlib.Path(%r).exists():\n"
            "        if time.monotonic() > deadline: sys.exit(99)\n"
            "        time.sleep(0.02)\n"
            "    result = subprocess.run([%r] + sys.argv[1:], capture_output=True)\n"
            "    pathlib.Path(%r).write_text(str(result.returncode))\n"
            "    sys.exit(result.returncode)\n"
            "os.execv(%r, [%r] + sys.argv[1:])\n"
            % (str(entered), str(release), real_git, str(finished), real_git, real_git))
        shim.chmod(0o755)
        env = dict(self.env, PATH=str(shimdir) + os.pathsep + self.env["PATH"])
        proc = subprocess.Popen(
            [ORCH, "baseline", "refresh", "walk", "--ticket", "affected", "--stage-boundary"],
            cwd=self.wt, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        recovery = ["baseline", "recover", "walk", "--ticket", "affected", "--stage-boundary",
                    "--stopped", "--evidence", "Git and descendants exited; clean work inspected"]
        try:
            deadline = time.monotonic() + 10
            while not entered.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(entered.exists())
            self.refused(3, *recovery, cwd=self.wt)
            proc.kill()
            proc.wait(timeout=5)
            self.refused(3, "run", "affected", "--role", "implementor", "--model", "standard", "--effort", "low")
            self.assertEqual(self.gate()["action"], "recovery-needed")
        finally:
            release.touch()
            out, err = proc.communicate(timeout=20)
        deadline = time.monotonic() + 10
        while not finished.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(finished.exists(), "surviving Git child did not finish")
        self.assertEqual(finished.read_text(), "0")
        self.git("merge-base", "--is-ancestor", self.fix_sha, "HEAD", cwd=self.wt)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected", "--stage-boundary", cwd=self.wt)
        self.refused(3, "baseline", "recover", "walk", "--ticket", "affected",
                     "--stage-boundary", "--evidence", "no stopped attestation", cwd=self.wt)
        self.ok(*recovery, cwd=self.wt)
        self.assertEqual(self.gate()["action"], "retest")
        self.refused(3, "merged", "affected", "--sha", self.old_head)
        head = self.git("rev-parse", "HEAD", cwd=self.wt)
        self.ok("baseline", "ack", "walk", "--ticket", "affected", "--sha", head,
                "--tests", "fresh green suite", "--review", "fresh independent review")
        self.refused(3, "merged", "affected", "--sha", head)
        self.ok("ci", "affected", "--sha", head, "--passed")
        self.ok("merged", "affected", "--sha", head)
        self.assertTrue(any(e["kind"] == "baseline-recovered" for e in self.events("affected")))

    def test_rebase_conflict_is_preserved_and_recorded_for_recovery(self):
        self.commit(self.wt, "README", "ticket edit\n")
        self.requested(conflict=True)
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assertTrue(self.git("diff", "--name-only", "--diff-filter=U", cwd=self.wt))
        rebase = self.git("rev-parse", "--git-path", "rebase-merge", cwd=self.wt)
        self.assertTrue(Path(rebase).exists())
        self.assertEqual(self.baseline_record()["refreshes"]["affected"]["status"], "conflicted")
        self.assertEqual(self.gate()["action"], "recovery-needed")
        snapshot = Path(self.wt, "README").read_text()
        self.refused(3, "baseline", "refresh", "walk", "--ticket", "affected",
                     "--stage-boundary", cwd=self.wt)
        self.assertEqual(Path(self.wt, "README").read_text(), snapshot)


if __name__ == "__main__":
    unittest.main()
