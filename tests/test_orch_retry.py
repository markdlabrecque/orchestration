"""Explicit replay of a recorded dispatch, not a new routing decision.

CLI: retry TICKET --run SEQ [--model VALUE --effort EFFORT --reason TEXT].
JSON is a runs row with dispatch, routing_context, retry_of and retry_reason.
The immediate-source links are sufficient to trace repeated retries.
"""

import json
import os
import sqlite3

from test_orch_routing import PI, RoutingTestCase, assistant
from test_orch_platforms import PlatformTestCase


class RetryHookTests(PlatformTestCase):
    def setUp(self):
        super().setUp()
        self.wt = self.git_wt("retry-hook")
        self.spawn_on("t1", "headless", self.wt)
        self.sid = self.show("t1")["session_id"]

    def dispatch(self, model="standard"):
        return self.j("run", "t1", "--role", "implementor", "--model", model,
                      "--effort", "high")

    def retry(self, source, *extra):
        return self.j("retry", "t1", "--run", str(source["seq"]), *extra)

    def runs(self):
        return self.j("runs", "t1")["runs"]

    def observe(self, agent_id, model="claude-sonnet-5-5"):
        path = os.path.join(self.tmp, "retry-transcript.jsonl")
        with open(path, "w") as stream:
            stream.write(json.dumps(assistant(model, "high")) + "\n")
        result = self.hook_ok("SubagentStop", self.sid, self.wt, extra={
            "agent_type": "orchestration:implementor", "agent_id": agent_id,
            "agent_transcript_path": path if model else None})
        self.assertEqual((result.stdout, result.stderr), ("", ""))

    def assert_completed(self, before, after, agent_id, model):
        self.assertEqual(after, dict(before, agent_id=agent_id, model_resolved=model,
                                    effort_resolved="high", match=1,
                                    resolved_at=after["resolved_at"]))
        self.assertTrue(after["resolved_at"])
        self.assertFalse([e for e in self.events("t1") if e["kind"] == "model_mismatch"])

    def test_exact_retry_completion_leaves_unlaunched_source_unchanged(self):
        source = self.dispatch()
        replay = self.retry(source)
        self.observe("retry-agent")
        rows = self.runs()
        self.assertEqual(rows[0], source)
        self.assert_completed(replay, rows[1], "retry-agent", "claude-sonnet-5-5")
        self.observe("retry-agent")
        self.assertEqual(self.runs(), rows, "duplicate completion must keep its identity")

    def test_deliberate_retry_completion_leaves_unlaunched_source_unchanged(self):
        source = self.dispatch()
        replay = self.retry(source, "--model", "heavy", "--effort", "high",
                            "--reason", "provider failure; approved replacement")
        self.observe("retry-agent", "claude-opus-5-5")
        rows = self.runs()
        self.assertEqual(rows[0], source)
        self.assert_completed(replay, rows[1], "retry-agent", "claude-opus-5-5")

    def check_repeated_source_refused(self, *extra):
        source = self.dispatch()
        first = self.retry(source)

        def snapshot():
            with sqlite3.connect(self.db_path()) as db:
                return {table: db.execute("SELECT * FROM " + table + " ORDER BY seq").fetchall()
                        for table in ("tickets", "runs", "events", "ci_results")}

        def refuse(old, latest):
            before = snapshot()
            result = self.refused(3, "retry", "t1", "--run", str(old["seq"]), *extra)
            self.assertEqual(snapshot(), before, "superseded refusal must be atomic")
            self.assertIn("superseded", result.stderr.lower())
            self.assertIn("orch retry t1 --run %s" % latest["seq"], result.stderr)

        refuse(source, first)
        latest = self.retry(first, *extra)
        self.assertEqual(latest["retry_of"], first["seq"])
        refuse(source, latest)
        refuse(first, latest)
        model = "claude-opus-5-5" if extra else "claude-sonnet-5-5"
        self.observe("latest-agent", model)
        rows = self.runs()
        self.assertEqual(rows[:2], [source, first])
        self.assert_completed(latest, rows[2], "latest-agent", model)
        refuse(source, latest)
        self.observe("latest-agent", model)
        self.assertEqual(self.runs(), rows)

    def test_exact_repeated_source_refuses_and_points_to_latest_attempt(self):
        self.check_repeated_source_refused()

    def test_deliberate_repeated_source_refuses_and_points_to_latest_attempt(self):
        self.check_repeated_source_refused(
            "--model", "heavy", "--effort", "high", "--reason", "approved replacement")

    def test_retry_chain_completion_never_falls_back_to_unlaunched_ancestors(self):
        source = self.dispatch()
        first = self.retry(source)
        latest = self.retry(first)
        self.observe("latest-agent")
        rows = self.runs()
        self.assertEqual(rows[:2], [source, first])
        self.assert_completed(latest, rows[2], "latest-agent", "claude-sonnet-5-5")
        self.observe("unrecorded-agent")
        self.assertEqual(self.runs(), rows)
        events = [e for e in self.events("t1") if e["kind"] == "dispatch_unrecorded"]
        self.assertEqual(len(events), 1)

    def test_known_source_agent_keeps_late_evidence_after_retry(self):
        source = self.dispatch()
        self.observe("source-agent", model=None)
        source = self.runs()[0]
        replay = self.retry(source)
        self.observe("source-agent")
        rows = self.runs()
        self.assert_completed(source, rows[0], "source-agent", "claude-sonnet-5-5")
        self.assertEqual(rows[1], replay)
        self.observe("retry-agent")
        completed = self.runs()
        self.assertEqual(completed[0], rows[0])
        self.assert_completed(replay, completed[1], "retry-agent", "claude-sonnet-5-5")
        self.observe("source-agent")
        self.assertEqual(self.runs(), completed)

    def test_unresolved_retry_identity_receives_its_late_evidence(self):
        source = self.dispatch()
        replay = self.retry(source)
        self.observe("retry-agent", model=None)
        rows = self.runs()
        self.assertEqual(rows, [source, dict(replay, agent_id="retry-agent")])
        self.observe("retry-agent")
        completed = self.runs()
        self.assertEqual(completed[0], source)
        self.assert_completed(replay, completed[1], "retry-agent", "claude-sonnet-5-5")

    def test_retry_preserves_fifo_for_unrelated_pending_runs(self):
        source = self.dispatch()
        unrelated = self.dispatch()
        replay = self.retry(source)
        self.observe("unrelated-agent")
        rows = self.runs()
        self.assertEqual(rows[0], source)
        self.assert_completed(unrelated, rows[1], "unrelated-agent", "claude-sonnet-5-5")
        self.assertEqual(rows[2], replay)
        self.observe("retry-agent")
        completed = self.runs()
        self.assertEqual(completed[:2], rows[:2])
        self.assert_completed(replay, completed[2], "retry-agent", "claude-sonnet-5-5")


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

    def test_partial_provenance_refuses_even_explicit_decision(self):
        source = self.repair()
        for column, key in (("routing_context", "files"), ("dispatch", "model")):
            with self.subTest(column=column):
                partial = dict(source[column])
                del partial[key]
                self.db_exec("UPDATE runs SET " + column + "=? WHERE seq=?",
                             (json.dumps(partial), source["seq"]))
                self.refuse(source, r"provenance|context")
                self.refuse(source, r"provenance|context", "--model", "heavy",
                            "--effort", "high", "--reason", "cannot invent provenance")
                self.db_exec("UPDATE runs SET " + column + "=? WHERE seq=?",
                             (json.dumps(source[column]), source["seq"]))

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
