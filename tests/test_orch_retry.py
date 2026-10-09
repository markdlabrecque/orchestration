"""Explicit replay of a recorded dispatch, not a new routing decision.

CLI: retry TICKET --run SEQ [--model VALUE --effort EFFORT --reason TEXT].
JSON is a runs row with dispatch, routing_context, retry_of and retry_reason.
The immediate-source links are sufficient to trace repeated retries.
"""

import json
import os
import sqlite3

from test_orch_routing import PI, RoutingTestCase


class RetryTests(RoutingTestCase):
    def snapshot(self):
        with sqlite3.connect(self.db_path()) as db:
            return {table: db.execute("SELECT * FROM " + table + " ORDER BY seq").fetchall()
                    for table in ("tickets", "runs", "events", "ci_results")}

    def repair(self):
        self.to_review("t1")
        self.set_harness("t1", "pi")
        self.log_run("t1", "implementor", "standard")
        self.ok("phase", "t1", "fix")
        route = self.route("t1", "implementor")
        self.assertEqual((route["tier"], route["effort"]), ("standard", "high"))
        return self.log_run("t1", "implementor", route["model"], effort="high")

    def retry(self, source, *extra, ticket="t1"):
        return self.j("retry", ticket, "--run", str(source["seq"]), *extra)

    def refuse(self, source, pattern, *extra, ticket="t1", code=3):
        before = self.snapshot()
        result = self.refused(code, "retry", ticket, "--run", str(source["seq"]), *extra)
        self.assertEqual(self.snapshot(), before, "refusal must be atomic")
        self.assertRegex(result.stderr.lower(), pattern)
        return result

    def assert_replay(self, source, replay):
        self.assertGreater(replay["seq"], source["seq"])
        self.assertEqual(replay["retry_of"], source["seq"])
        self.assertIsNone(replay["retry_reason"])
        for key in ("ticket", "role", "tier", "model_requested", "effort_requested",
                    "bounce_count", "dispatch", "routing_context"):
            self.assertEqual(replay[key], source[key], key)
        for key in ("model_resolved", "effort_resolved", "agent_id", "resolved_at", "match"):
            self.assertIsNone(replay[key], key)
        self.assertEqual(self.runs("t1")[-1], replay)

    def test_recorded_high_repair_loses_ordinary_route_but_retry_replays_it(self):
        source = self.repair()
        # Simulated infrastructure failure: dispatch is recorded, but no agent
        # result arrives. A fresh route has already lost the bounce escalation.
        route = self.route("t1", "implementor")
        self.assertEqual((route["tier"], route["effort"]), ("standard", "low"))
        before = self.snapshot()
        replay = self.retry(source)
        self.assert_replay(source, replay)
        self.assertEqual(replay["dispatch"], {
            "role": "implementor", "harness": "pi", "tier": "standard",
            "model": PI["standard"], "effort": "high", "thinking": "high"})
        after = self.snapshot()
        self.assertEqual(after["tickets"], before["tickets"])
        self.assertEqual(after["ci_results"], before["ci_results"])
        self.assertEqual(len(after["runs"]), len(before["runs"]) + 1)
        self.assertEqual(len(after["events"]), len(before["events"]) + 1)

    def test_normal_run_persists_dispatch_and_routing_inputs(self):
        self.to_review("t1")
        self.set_harness("t1", "pi")
        source = self.log_run("t1", "reviewer", "heavy", "--files", "6",
                              "--lines", "301", "--ambiguous")
        self.assertIn("routing_context", source, "normal runs need replay provenance")
        context = source["routing_context"]
        for key, value in {"files": 6, "lines": 301, "ambiguous": True,
                           "phase": "review", "bounces": 0, "ci_repairs": 0}.items():
            self.assertEqual(context[key], value, key)
        self.assertEqual(source["dispatch"]["model"], PI["heavy"])
        self.assertIsNone(source["retry_of"])
        self.assertIsNone(source["retry_reason"])
        self.assert_replay(source, self.retry(source))

    def test_repeated_retries_preserve_context_then_real_bounce_escalates_once(self):
        source = self.repair()
        tickets = self.snapshot()["tickets"]
        original = source
        for _ in range(3):
            replay = self.retry(source)
            self.assert_replay(source, replay)
            self.assertEqual(self.snapshot()["tickets"], tickets)
            source = replay
        self.assertEqual(source["dispatch"], original["dispatch"])
        self.phases("t1", "review", "fix")
        self.assertEqual(self.show("t1")["bounces"], 2)
        route = self.route("t1", "implementor")
        self.assertEqual((route["tier"], route["effort"]), ("heavy", "low"))

    def test_ci_repair_is_a_separate_default_not_infrastructure_replay(self):
        source = self.repair()
        self.retry(source)
        self.phases("t1", "review", "verify", "report", "mr", "ci", "fix")
        self.assertEqual(self.show("t1")["bounces"], 1)
        self.assertEqual(self.show("t1")["ci_repairs"], 1)
        route = self.route("t1", "implementor")
        self.assertEqual((route["tier"], route["effort"]), ("standard", "low"))
        self.refuse(source, r"context|repair|ci")
        ci = self.log_run("t1", "implementor", route["model"])
        self.assert_replay(ci, self.retry(ci))

    def change_model_mapping(self):
        directory = os.path.join(self.xdg_default, "orchestration")
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "config.json"), "w") as stream:
            json.dump({"pi_models": {"standard": "other-provider/replacement"}}, stream)

    def test_changed_mapping_refuses_instead_of_substituting_provider(self):
        source = self.repair()
        self.change_model_mapping()
        self.refuse(source, r"model|mapping|dispatch")

    def test_codex_replay_returns_invocable_agent_and_clears_resolution(self):
        self.to_review("t1")
        self.set_harness("t1", "codex")
        source = self.log_run("t1", "implementor", "implementor-standard-high", effort="high")
        self.db_exec("UPDATE runs SET model_resolved='gpt-6.1-sol', effort_resolved='high', "
                     "agent_id='old-agent', resolved_at='old-time', match=1 WHERE seq=?",
                     (source["seq"],))
        source = self.runs("t1")[-1]
        replay = self.retry(source)
        self.assert_replay(source, replay)
        self.assertEqual(replay["dispatch"], {
            "role": "implementor", "harness": "codex", "tier": "standard",
            "model": "gpt-6.1-sol", "effort": "high", "agent": "implementor-standard-high"})

    def test_changed_harness_refuses(self):
        source = self.repair()
        self.set_harness("t1", "codex")
        self.refuse(source, r"harness")

    def test_changed_phase_and_later_bounce_refuse_even_explicit_decision(self):
        source = self.repair()
        self.ok("phase", "t1", "review")
        self.refuse(source, r"phase|context")
        self.ok("phase", "t1", "fix")
        self.refuse(source, r"bounce|context|repair")
        self.refuse(source, r"bounce|context|repair", "--model", "heavy",
                    "--effort", "high", "--reason", "deliberate decision")

    def test_raised_floor_refuses_replay_and_explicit_underfloor_choice(self):
        source = self.repair()
        self.log_run("t1", "test-writer", "frontier")
        self.refuse(source, r"floor")
        self.refuse(source, r"floor", "--model", "standard", "--effort", "high",
                    "--reason", "not permission to bypass floors")
        chosen = self.retry(source, "--model", "heavy", "--effort", "low",
                            "--reason", "meet current floor")
        self.assertEqual((chosen["tier"], chosen["effort_requested"]), ("heavy", "low"))

    def test_explicit_decision_records_new_dispatch_reason_and_source(self):
        source = self.repair()
        self.change_model_mapping()
        before = self.snapshot()
        chosen = self.retry(source, "--model", "standard", "--effort", "high",
                            "--reason", "provider unavailable; approved replacement")
        self.assertEqual(chosen["retry_of"], source["seq"])
        self.assertEqual(chosen["retry_reason"], "provider unavailable; approved replacement")
        self.assertEqual(chosen["dispatch"]["model"], "other-provider/replacement")
        self.assertEqual(chosen["model_requested"], "other-provider/replacement")
        self.assertEqual(chosen["effort_requested"], "high")
        self.assertEqual(self.runs("t1")[-2], source, "retain old identity unmodified")
        self.assertEqual(self.snapshot()["tickets"], before["tickets"])
        self.assert_replay(chosen, self.retry(chosen))

    def test_explicit_decision_requires_model_effort_and_nonempty_reason(self):
        source = self.repair()
        cases = [("--model", "heavy"), ("--effort", "high"),
                 ("--reason", "provider unavailable"),
                 ("--model", "heavy", "--effort", "high"),
                 ("--model", "heavy", "--effort", "high", "--reason", "  ")]
        for flags in cases:
            with self.subTest(flags=flags):
                self.refuse(source, r"reason|model|effort", *flags, code=2)

    def test_missing_and_cross_ticket_source_refuse_atomically(self):
        source = self.repair()
        self.add("t2")
        self.refuse(source, r"run.*t2|ticket|belong", ticket="t2")
        self.refuse({"seq": source["seq"] + 1000}, r"run.*(found|exist|unknown)|unknown.*run")

    def test_legacy_run_without_provenance_refuses(self):
        self.to_review("t1")
        self.db_exec("INSERT INTO runs (ticket, role, model_requested, tier, bounce_count, "
                     "requested_at, effort_requested) VALUES "
                     "('t1', 'implementor', 'sonnet', 'standard', 0, 'legacy', 'low')")
        source = self.runs("t1")[-1]
        self.refuse(source, r"legacy|provenance|context")
        self.refuse(source, r"legacy|provenance|context", "--model", "heavy",
                    "--effort", "high", "--reason", "cannot invent provenance")

    def test_unknown_history_and_invalid_repair_refuse(self):
        source = self.repair()
        for column in ("bounces", "ci_repairs"):
            with self.subTest(column=column):
                old = self.db_exec("SELECT " + column + " FROM tickets WHERE id='t1'")[0][0]
                self.db_exec("UPDATE tickets SET " + column + "=NULL WHERE id='t1'")
                self.refuse(source, r"unknown|history|repair|context")
                self.refuse(source, r"unknown|history|repair|context", "--model", "heavy",
                            "--effort", "high", "--reason", "must not bypass unknown history")
                self.db_exec("UPDATE tickets SET " + column + "=? WHERE id='t1'", (old,))
        # Corrupt fixture: a fix with no recorded entering transition is not
        # enough evidence to reconstruct whether this is review or CI repair.
        self.db_exec("DELETE FROM events WHERE ticket='t1' AND kind='phase' AND to_phase='fix'")
        self.refuse(source, r"repair|context|history|provenance")

    def test_blocked_done_and_retired_tickets_refuse_explicit_retry_too(self):
        source = self.repair()
        self.ok("block", "t1", "--reason", "human investigation")
        for flags in ((), ("--model", "heavy", "--effort", "high", "--reason", "still blocked")):
            self.refuse(source, r"blocked", *flags)
        self.ok("unblock", "t1")
        # Fixture terminal states isolate retry's gate from CI/retirement setup.
        self.db_exec("UPDATE tickets SET phase='done' WHERE id='t1'")
        for flags in ((), ("--model", "heavy", "--effort", "high", "--reason", "still done")):
            self.refuse(source, r"done|complete|terminal", *flags)
        self.db_exec("UPDATE tickets SET phase='fix', retired_at='2026-01-01' WHERE id='t1'")
        for flags in ((), ("--model", "heavy", "--effort", "high", "--reason", "still retired")):
            self.refuse(source, r"retired", *flags)
