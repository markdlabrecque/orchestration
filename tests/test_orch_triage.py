"""Black-box tests for bounce-cap triage (#109)."""

import os
import re
import sqlite3

from test_orch_routing import RoutingTestCase

CASES = ("disagreement", "recurring-finding", "unclear-or-oversized", "moving-target")


class TriageTests(RoutingTestCase):
    def snapshot(self):
        with sqlite3.connect(self.db_path()) as db:
            return {t: db.execute("SELECT * FROM " + t + " ORDER BY seq").fetchall()
                    for t in ("tickets", "events", "runs", "ci_results")}

    def triage_path(self):
        return os.path.join(self.state_dir, "triage", "t1.md")

    def find(self, summary, file="a.py:1", severity="must-fix"):
        args = ["finding", "add", "t1", "--severity", severity, "--summary", summary]
        if file:
            args += ["--file", file]
        return self.j(*args)["id"]

    def exhaust(self, origins=("review", "review", "review"), seed=None, late=None):
        """Reach bounces=3; seed() runs in review round 1, late() after the cap."""
        self.to_review("t1")
        if seed:
            seed()
        for n, (origin, rung) in enumerate(zip(origins, (
                ("standard", "high"), ("heavy", "low"), ("heavy", "high"))), 1):
            if n == 1:
                route = self.route("t1", "implementor")
                self.log_run("t1", "implementor", route["model"], effort="low")
            if origin == "verify":
                self.ok("phase", "t1", "verify")
            self.ok("phase", "t1", "fix")
            route = self.route("t1", "implementor")
            self.log_run("t1", "implementor", route["model"], effort=rung[1])
            self.ok("phase", "t1", "review")
        self.assertEqual(self.show("t1")["bounces"], 3)
        if late:
            late()

    def refuse(self):
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.show("t1")["bounces"], 3)
        self.assertRegex(p.stderr.lower(), r"\bblock\b")
        return p

    def assert_triage(self, case, p):
        self.assertIn(case, p.stderr)
        self.assertIn(self.triage_path(), p.stderr)
        with open(self.triage_path()) as f:
            text = f.read()
        self.assertIn("t1", text)
        self.assertRegex(text, r"(?m)^Case: .*\b%s\b" % re.escape(case))
        for other in CASES:
            if other != case:
                self.assertNotRegex(text, r"(?m)^Case: .*\b%s\b" % re.escape(other))
        self.assertEqual(len(re.findall(r"(?m)^\W*Recommended:", text)), 1)
        self.assertEqual(len(re.findall(r"(?m)^\W*Other option:", text)), 1)
        self.assertNotIn("not available", text)
        self.assertRegex(text, r"(?m)^Also available: park as a draft PR \(`orch park t1 --pr <url>`")
        return text

    def test_disagreement(self):
        def seed():
            self.find("x")
            self.find("y", file="b.py:2")  # stays open so the #108 gate lets bounces proceed
            self.ok("finding", "set", "t1", "F1", "--status", "disputed")
        self.exhaust(seed=seed)
        self.assert_triage("disagreement", self.refuse())

    def test_recurring_finding_lists_ids(self):
        def seed():
            self.find("loops")
            self.find("fresh", file="b.py:2")

        def late():
            self.ok("finding", "raise", "t1", "F1")  # rounds_open 1 -> 2
        self.exhaust(seed=seed, late=late)
        text = self.assert_triage("recurring-finding", self.refuse())
        self.assertIn("F1", text)

    def test_unclear_or_oversized_when_half_deferred_or_fileless(self):
        def seed():
            self.find("vague", file=None)
            self.find("later")
            self.ok("finding", "set", "t1", "F2", "--status", "deferred")
            self.find("concrete", file="c.py:3")
            self.find("concrete2", file="d.py:4")
        self.exhaust(seed=seed)
        self.assert_triage("unclear-or-oversized", self.refuse())

    def test_moving_target_and_deterministic_file(self):
        def seed():
            self.find("one")
            self.find("two", file="b.py:2")
        self.exhaust(seed=seed)
        text = self.assert_triage("moving-target", self.refuse())
        self.assertNotRegex(text, r"\d{4}-\d{2}-\d{2}")  # no timestamps
        self.refuse()
        with open(self.triage_path()) as f:
            self.assertEqual(f.read(), text)

    def test_no_must_fix_means_no_triage_file(self):
        self.exhaust()  # empty ledger: the #108 gate skips it
        p = self.refuse()
        self.assertFalse(os.path.exists(self.triage_path()))
        self.assertEqual(p.stderr.count("no findings ledger"), 1, p.stderr)

    def test_verify_origin_also_writes_triage(self):
        self.exhaust(origins=("verify", "verify", "verify"),
                     seed=lambda: self.find("x"))
        self.ok("phase", "t1", "verify")
        self.assert_triage("moving-target", self.refuse())

    def test_unwritable_triage_dir_still_refuses_with_budget_stop(self):
        self.exhaust(seed=lambda: self.find("x"))
        with open(os.path.join(self.state_dir, "triage"), "w") as f:
            f.write("not a directory")
        p = self.refuse()
        self.assertIn("bounces budget exhausted (3/3)", p.stderr)
        self.assertIn("triage: write failed", p.stderr)
        self.assertNotIn("Traceback", p.stderr)
