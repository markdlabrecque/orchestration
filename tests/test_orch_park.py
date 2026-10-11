"""Black-box tests for `orch park` (#110): parking a capped ticket as a draft PR.

Run from the plugin dir:  python3 -m unittest tests.test_orch_park -v
"""

import os
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from test_orch import OrchTestCase, is_retired  # noqa: E402

PR = "https://github.com/o/r/pull/7"


class ParkTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.init()

    def blocked(self, t="T-1"):
        self.dispatched(t, worktree=self.new_worktree(t))
        self.phases(t, "spec", "tests", "implement", "review")
        self.ok("block", t, "--reason", "review cap")
        return t

    def parked(self, t="T-1"):
        self.blocked(t)
        self.ok("park", t, "--pr", PR)
        return t

    def test_park_from_blocked(self):
        self.blocked()
        before = self.show("T-1")
        self.ok("park", "T-1", "--pr", PR, "--reason", "cap hit")
        after = self.show("T-1")
        self.assertEqual((after["phase"], after["status"], after["parked_pr"]),
                         ("parked", "parked", PR))
        for key in ("bounces", "ci_repairs", "review_rounds"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["prior_phase"], before["prior_phase"])
        ev = [e for e in self.events("T-1") if e["kind"] == "park"]
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["from_phase"], ev[0]["to_phase"]), ("blocked", "parked"))
        self.assertIn(PR, ev[0]["detail"])

    def test_merged_refused_even_with_passing_ci(self):
        self.to_ci("T-1", worktree=self.new_worktree("T-1"))
        self.ok("ci", "T-1", "--sha", "s1", "--passed")
        self.ok("park", "T-1", "--pr", PR)
        self.refused(3, "merged", "T-1", "--sha", "s1")
        self.assertEqual(self.show("T-1")["phase"], "parked")

    def test_retire_accepts_parked_without_force(self):
        self.parked()
        self.ok("retire", "T-1")
        self.assertTrue(is_retired(self.show("T-1")))

    def test_phase_and_block_refuse_parked(self):
        self.blocked()
        self.refused(3, "phase", "T-1", "parked")
        self.ok("park", "T-1", "--pr", PR)
        for target in ("review", "blocked", "ready"):
            self.refused(3, "phase", "T-1", target)
        self.refused(3, "block", "T-1", "--reason", "x")
        self.assertEqual(self.show("T-1")["phase"], "parked")

    def test_resume_restores_prior_phase(self):
        self.blocked()
        prior = self.show("T-1")["prior_phase"]
        self.ok("park", "T-1", "--pr", PR)
        self.ok("resume", "T-1")
        t = self.show("T-1")
        self.assertEqual((t["phase"], t["parked_pr"]), (prior, PR))
        self.assertIn("unpark", [e["kind"] for e in self.events("T-1")])

    def test_add_reopens_retired_parked_only(self):
        self.parked()
        before = self.show("T-1")
        self.ok("retire", "T-1")
        shutil.rmtree(before["worktree"])  # the no-op test engine leaves the checkout
        self.ok("add", "T-1", "--title", "again")
        t = self.show("T-1")
        self.assertEqual((t["phase"], is_retired(t), t["parked_pr"]), ("ready", False, PR))
        for key in ("bounces", "ci_repairs", "review_rounds"):
            self.assertEqual(t[key], before[key], key)
        self.assertIn("readd", [e["kind"] for e in self.events("T-1")])
        # a retired done ticket still cannot be re-added
        self.to_done("T-2", worktree=self.new_worktree("T-2"))
        self.ok("retire", "T-2")
        self.refused(3, "add", "T-2", "--title", "again")

    def test_readd_refused_while_kept_checkout_survives(self):
        self.parked()
        self.ok("retire", "T-1", "--keep-worktree")
        before = self.show("T-1")
        self.refused(3, "add", "T-1", "--title", "again")
        after = self.show("T-1")
        self.assertTrue(is_retired(after))
        for key in ("phase", "worktree", "retired_at"):
            self.assertEqual(after[key], before[key], key)

    def test_park_refusals(self):
        self.add("T-ready")
        self.refused(3, "park", "T-ready", "--pr", PR)
        self.to_done("T-done", worktree=self.new_worktree("done"))
        self.refused(3, "park", "T-done", "--pr", PR)
        self.blocked("T-ret")
        self.ok("retire", "T-ret", "--force")
        self.refused(3, "park", "T-ret", "--pr", PR)
        self.blocked("T-b")
        self.refused(2, "park", "T-b", "--pr", "not-a-url")
        self.refused(2, "park", "T-b")
        self.assertEqual(self.show("T-b")["phase"], "blocked")


if __name__ == "__main__":
    unittest.main()
