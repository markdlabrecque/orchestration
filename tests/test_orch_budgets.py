"""Ticket 12 acceptance: real legal transitions and independent durable budgets."""

import concurrent.futures
import sqlite3

from test_orch_routing import RoutingTestCase, CLAUDE


class BudgetTests(RoutingTestCase):
    def counts(self, ticket="t1"):
        state = self.show(ticket)
        self.assertIn("ci_repairs", state, "inspection must expose the durable CI budget")
        return state["bounces"], state["ci_repairs"], state["review_rounds"]

    def snapshot(self):
        # Inspect all durable records, not volatile process-liveness fields.
        with sqlite3.connect(self.db_path()) as db:
            return {table: db.execute("SELECT * FROM " + table + " ORDER BY seq").fetchall()
                    for table in ("tickets", "events", "runs", "ci_results")}

    def refuse_unchanged(self, budget):
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertEqual(self.snapshot(), before)
        self.assertRegex(p.stderr.lower(), budget)
        self.assertRegex(p.stderr.lower(), r"\bblock\b")
        self.assertRegex(p.stderr.lower(), r"human")
        return p

    def record_route(self, tier, effort):
        before = self.snapshot()
        route = self.route("t1", "implementor")
        self.assertEqual(self.snapshot(), before, "route is read-only")
        self.assertEqual((route["tier"], route["effort"]), (tier, effort))
        run = self.log_run("t1", "implementor", route["model"], effort=effort)
        self.assertEqual(run["bounce_count"], self.show("t1")["bounces"])

    def bounce(self, origin="review"):
        if origin == "verify":
            self.ok("phase", "t1", "verify")
        self.ok("phase", "t1", "fix")

    def exhaust_review(self, origins=("review", "review", "review")):
        self.to_review("t1")
        self.record_route("standard", "low")
        for n, (origin, rung) in enumerate(zip(origins, (
                ("standard", "high"), ("heavy", "low"), ("heavy", "high"))), 1):
            self.bounce(origin)
            self.assertEqual(self.show("t1")["bounces"], n)
            self.record_route(*rung)
            self.ok("phase", "t1", "review")

    def test_new_ticket_inspection_text_and_json(self):
        self.add("t1")
        self.assertEqual(self.counts(), (0, 0, 0))
        text = self.ok("show", "t1").stdout.lower()
        self.assertRegex(text, r"bounces\s*:\s*0")
        self.assertRegex(text, r"ci[_ ]repairs\s*:\s*0")

    def test_ci_third_refused_before_any_new_run_or_event(self):
        self.to_ci("t1")
        self.phases("t1", "fix", "ci", "fix", "ci")
        self.refuse_unchanged(r"ci")

    def test_illegal_edge_precedes_exhausted_ci_budget(self):
        self.to_ci("t1")
        self.phases("t1", "fix", "ci", "fix")
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertIn("illegal transition", p.stderr.lower())
        self.assertEqual(self.snapshot(), before)

    def test_failed_phase_event_transaction_rolls_back_counts(self):
        self.to_ci("t1")
        self.to_review("t2")
        # Corrupt fixture simulates a failed event write after phase mutation.
        self.db_exec("CREATE TRIGGER reject_repair_event BEFORE INSERT ON events "
                     "WHEN NEW.kind='phase' AND NEW.to_phase='fix' "
                     "BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END")
        for ticket in ("t1", "t2"):
            with self.subTest(ticket=ticket):
                before = self.snapshot()
                p = self.orch("phase", ticket, "fix")
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("fixture event failure", p.stderr)
                self.assertEqual(self.snapshot(), before)

    def test_attach_and_resume_do_not_replenish_ci_budget(self):
        self.to_ci("t1")
        self.phases("t1", "fix", "ci", "fix", "ci")
        self.ok("attach", "t1", "--session-id", "fixture-attached-session")
        self.ok("block", "t1", "--reason", "CI budget; findings retained")
        self.ok("resume", "t1", "--note", "investigation only")
        self.wait_dead("t1")
        self.assertEqual(self.show("t1")["phase"], "ci")
        self.refuse_unchanged(r"ci")
        self.assertEqual(self.counts(), (0, 2, 1))

    def test_three_real_review_bounces_and_fourth_refusal(self):
        self.exhaust_review()
        self.assertEqual(self.counts(), (3, 0, 4))
        self.refuse_unchanged(r"bounce|review.*budget")
        self.assertEqual(self.show("t1")["phase"], "review")
        self.ok("phase", "t1", "verify")
        self.refuse_unchanged(r"bounce|review.*budget")
        findings = "bounce budget exhausted; findings https://example.test/findings/12"
        self.ok("block", "t1", "--reason", findings)
        self.assertEqual(self.counts(), (3, 0, 4))
        self.assertEqual(self.show("t1")["prior_phase"], "verify")
        self.assertIn(findings, str(self.events("t1")))
        self.ok("unblock", "t1")
        self.refuse_unchanged(r"bounce|review.*budget")

    def test_mixed_verify_review_share_budget_and_resume_preserves_it(self):
        self.exhaust_review(("verify", "review", "verify"))
        self.assertEqual(self.counts(), (3, 0, 4))
        self.ok("block", "t1", "--reason", "budget; findings retained")
        self.ok("resume", "t1", "--note", "human investigating, no budget reset")
        self.wait_dead("t1")
        self.assertEqual(self.show("t1")["phase"], "review")
        self.assertEqual(self.counts(), (3, 0, 4))
        self.refuse_unchanged(r"bounce|review.*budget")

    def test_two_ci_repairs_then_atomic_third_refusal(self):
        self.to_ci("t1")
        for n in (1, 2):
            self.ok("ci", "t1", "--sha", "sha%d" % n, "--failed")
            self.phases("t1", "mr", "ci")
            self.ok("phase", "t1", "fix")
            self.assertEqual(self.counts(), (0, n, 1))
            before = self.snapshot()
            self.refused(3, "phase", "t1", "fix")  # illegal repeat
            self.assertEqual(self.snapshot(), before)
            self.record_route("standard", "low")
            self.assertEqual(self.counts(), (0, n, 1))
            self.ok("phase", "t1", "ci")
        self.refuse_unchanged(r"ci")
        self.ok("block", "t1", "--reason", "CI budget exhausted; findings URL")
        self.ok("unblock", "t1")
        self.refuse_unchanged(r"ci")

    def test_interleaved_budgets_do_not_replenish_each_other(self):
        self.to_review("t1")
        self.record_route("standard", "low")
        self.bounce("verify")
        self.record_route("standard", "high")
        self.phases("t1", "review", "report", "mr", "ci", "fix")
        self.assertEqual(self.counts(), (1, 1, 2))
        self.record_route("standard", "low")
        self.phases("t1", "review", "fix")
        self.assertEqual(self.counts(), (2, 1, 3))
        self.record_route("standard", "high")
        self.phases("t1", "ci", "fix", "review")
        self.assertEqual(self.counts(), (2, 2, 4))
        self.bounce("verify")
        self.assertEqual(self.counts(), (3, 2, 4))
        self.record_route("heavy", "low")
        self.phases("t1", "review", "verify")
        self.refuse_unchanged(r"bounce|review.*budget")
        self.phases("t1", "report", "mr", "ci")
        self.refuse_unchanged(r"ci")

    def test_exhausted_review_does_not_use_ci_slots(self):
        self.exhaust_review()
        self.refuse_unchanged(r"bounce|review.*budget")
        self.phases("t1", "report", "mr", "ci", "fix")
        self.assertEqual(self.counts(), (3, 1, 4))
        # Keep #8's normal highest-tier-minus-one floor, no bounce escalation.
        self.record_route("standard", "low")
        self.phases("t1", "ci", "fix")
        self.assertEqual(self.counts(), (3, 2, 4))

    def test_frontier_gate_early_and_budget_precedence(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", CLAUDE["frontier"], effort="high")
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertIn("frontier", p.stderr.lower())
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.counts(), (0, 0, 1))
        # CI repairs are not subject to the review frontier gate.
        self.phases("t1", "report", "mr", "ci", "fix")
        self.assertEqual(self.counts(), (0, 1, 1))
        self.phases("t1", "ci", "fix")
        self.assertEqual(self.counts(), (0, 2, 1))

    def test_budget_refusal_precedes_frontier_at_three(self):
        self.exhaust_review()
        self.log_run("t1", "implementor", CLAUDE["frontier"], effort="high")
        p = self.refuse_unchanged(r"bounce|review.*budget")
        self.assertNotRegex(p.stderr.lower(), r"frontier.*(exhaust|cap|limit)")

    def test_frontier_low_can_reach_high_with_remaining_slot(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", CLAUDE["frontier"])
        self.bounce()
        self.record_route("frontier", "high")
        self.assertEqual(self.counts(), (1, 0, 1))
        self.ok("phase", "t1", "review")
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertIn("frontier", p.stderr.lower())
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_last_ci_slot_has_one_winner_and_one_event(self):
        self.to_ci("t1")
        self.phases("t1", "fix", "ci")
        before = self.events("t1")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.orch("phase", "t1", "fix"), range(2)))
        self.assertEqual(sorted(p.returncode for p in results), [0, 3])
        self.assertEqual(self.counts(), (0, 2, 1))
        added = self.events("t1")[len(before):]
        self.assertEqual([(e["kind"], e["from_phase"], e["to_phase"]) for e in added],
                         [("phase", "ci", "fix")])
        self.ok("phase", "t1", "ci")
        self.refuse_unchanged(r"ci")

    def test_concurrent_last_review_slot_has_one_winner(self):
        self.to_review("t1")
        self.phases("t1", "fix", "review", "fix", "review")
        before = self.events("t1")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.orch("phase", "t1", "fix"), range(2)))
        self.assertEqual(sorted(p.returncode for p in results), [0, 3])
        self.assertEqual(self.counts(), (3, 0, 3))
        self.assertEqual(len(self.events("t1")), len(before) + 1)


class MigrationTests(BudgetTests):
    # Inherit helpers, not the acceptance methods a second time (see load_tests).
    def legacy(self, repairs=0, bounces=0, incomplete=False, pre_bounces=False):
        self.to_ci("t1")
        self.log_run("t1", "implementor", CLAUDE["standard"])
        self.ok("ci", "t1", "--sha", "legacy-sha", "--failed")
        self.ok("block", "t1", "--reason", "historical CI findings")
        self.ok("unblock", "t1")
        # Direct mutations here construct old/corrupt databases only.
        with sqlite3.connect(self.db_path()) as db:
            columns = [r[1] for r in db.execute("PRAGMA table_info(tickets)")]
            for col in columns:
                if col.startswith("ci_repair"):
                    db.execute('ALTER TABLE tickets DROP COLUMN "' + col + '"')
            for _ in range(repairs):
                db.execute("INSERT INTO events(ticket,ts,kind,from_phase,to_phase) "
                           "VALUES('t1','2026-01-01','phase','ci','fix')")
                db.execute("INSERT INTO events(ticket,ts,kind,from_phase,to_phase) "
                           "VALUES('t1','2026-01-01','phase','fix','ci')")
            db.execute("UPDATE tickets SET bounces=? WHERE id='t1'", (bounces,))
            if incomplete:
                db.execute("DELETE FROM events WHERE ticket='t1'")
            if pre_bounces:
                db.execute("ALTER TABLE tickets DROP COLUMN bounces")

    def test_legacy_complete_ci_counts_preserved_and_idempotent(self):
        for n in (0, 1, 2, 4):
            with self.subTest(repairs=n):
                if n:
                    # Fresh isolated project for each historical count.
                    self.tearDown()
                    self.setUp()
                self.legacy(repairs=n, bounces=5)
                before_runs = self.runs("t1")
                for _ in range(3):
                    self.assertEqual(self.counts(), (5, n, 1))
                    self.assertEqual(self.runs("t1"), before_runs)
                    self.assertEqual(self.show("t1")["phase"], "ci")
                if n >= 2:
                    self.refuse_unchanged(r"ci")
                else:
                    self.ok("phase", "t1", "fix")
                    self.assertEqual(self.counts(), (5, n + 1, 1))
                    self.assertEqual(self.counts(), (5, n + 1, 1))

    def test_missing_history_is_unknown_not_zero_and_refuses(self):
        self.legacy(incomplete=True)
        for _ in range(3):
            state = self.show("t1")
            self.assertIn("ci_repairs", state)
            self.assertIsNone(state["ci_repairs"], "missing history must not grant zero repairs")
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertRegex(p.stderr.lower(), r"reconcil|unknown|history")
        self.assertEqual(self.snapshot(), before)

    def test_truncated_history_is_unknown(self):
        self.legacy(repairs=1)
        self.db_exec("DELETE FROM events WHERE ticket='t1' AND seq="
                     "(SELECT MIN(seq) FROM events WHERE ticket='t1')")
        state = self.show("t1")
        self.assertIn("ci_repairs", state)
        self.assertIsNone(state["ci_repairs"])
        before = self.snapshot()
        self.refused(3, "phase", "t1", "fix")
        self.assertEqual(self.snapshot(), before)

    def test_pre_bounces_reconstructs_successful_phase_history(self):
        self.to_review("t1")
        self.phases("t1", "fix", "review", "verify", "fix", "review")
        self.log_run("t1", "implementor", CLAUDE["standard"])
        runs = self.runs("t1")
        with sqlite3.connect(self.db_path()) as db:
            db.execute("ALTER TABLE tickets DROP COLUMN bounces")
        self.assertEqual(self.counts(), (2, 0, 3))
        self.assertEqual(self.runs("t1"), runs)

    def test_pre_bounces_missing_history_does_not_grant_zero(self):
        self.legacy(incomplete=True, pre_bounces=True)
        state = self.show("t1")
        self.assertIsNone(state["bounces"], "missing history cannot establish a fresh bounce budget")
        self.phases("t1", "mr", "ci")
        before = self.snapshot()
        p = self.refused(3, "phase", "t1", "fix")
        self.assertRegex(p.stderr.lower(), r"reconcil|unknown|history")
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_legacy_opens_backfill_once(self):
        self.legacy(repairs=2, bounces=4)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.show("t1"), range(3)))
        for state in results:
            self.assertIn("ci_repairs", state)
            self.assertEqual((state["bounces"], state["ci_repairs"]), (4, 2))
        self.refuse_unchanged(r"ci")

    def test_initialized_count_not_recomputed_after_history_loss(self):
        self.to_ci("t1")
        self.phases("t1", "fix", "ci")
        self.assertEqual(self.counts(), (0, 1, 1))
        self.db_exec("DELETE FROM events WHERE ticket='t1'")  # corrupt fixture
        self.assertEqual(self.counts(), (0, 1, 1))
        self.phases("t1", "fix", "ci")
        self.assertEqual(self.counts(), (0, 2, 1))
        self.refuse_unchanged(r"ci")


def load_tests(loader, tests, pattern):
    import unittest
    suite = loader.loadTestsFromTestCase(BudgetTests)
    suite.addTests(unittest.TestSuite(MigrationTests(name) for name in (
        "test_legacy_complete_ci_counts_preserved_and_idempotent",
        "test_missing_history_is_unknown_not_zero_and_refuses",
        "test_truncated_history_is_unknown",
        "test_pre_bounces_reconstructs_successful_phase_history",
        "test_initialized_count_not_recomputed_after_history_loss",
        "test_pre_bounces_missing_history_does_not_grant_zero",
        "test_concurrent_legacy_opens_backfill_once")))
    return suite
