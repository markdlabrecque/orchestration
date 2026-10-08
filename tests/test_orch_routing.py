"""Black-box tests for model routing in scripts/orch: `orch route`, `orch run`,
`orch runs`, bounces, the SubagentStop hook and `orch smoke-routing`.

Contract: skills/orchestration/references/orch-cli.md ("Model routing").

Run from the plugin dir:  python3 -m unittest discover -s tests -v
"""

import json
import os
import shlex
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from test_orch import ORCH, OrchTestCase, list_in  # noqa: E402
from test_orch_platforms import PLUGIN, PlatformTestCase  # noqa: E402
from test_orch_adapters import SELFTEST_STEPS, SESSION_CLAUDE_SRC, AdapterTestCase  # noqa: E402

ROLE_DEFAULTS = {"filer": "light", "investigation": "light", "test-writer": "standard",
                 "implementor": "standard", "reviewer": "light", "verifier": "light",
                 "reporter": "light"}
CLAUDE = {"light": "haiku", "standard": "sonnet", "heavy": "opus", "frontier": "fable"}
CODEX = {"light": "gpt-6-luna", "standard": "gpt-6.1-sol", "heavy": "gpt-6-astra",
         "frontier": "gpt-6-astra"}
PI = {"light": "openai-codex/gpt-6-luna", "standard": "openai-codex/gpt-6.1-sol",
      "heavy": "openai-codex/gpt-6-astra", "frontier": "openai-codex/gpt-6-astra"}


class RoutingTestCase(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.init()

    def route(self, ticket, role, *extra):
        return self.j("route", ticket, "--role", role, *extra)

    def log_run(self, ticket, role, model, *extra, effort="low"):
        return self.j("run", ticket, "--role", role, "--model", model,
                      "--effort", effort, *extra)

    def runs(self, ticket):
        return list_in(self.j("runs", ticket), "runs")

    def to_review(self, ticket):
        self.dispatched(ticket, worktree=self.new_worktree(ticket))
        self.phases(ticket, "spec", "tests", "implement", "review")

    def set_harness(self, ticket, harness):
        self.db_exec("UPDATE tickets SET harness=? WHERE id=?", (harness, ticket))


class RouteTests(RoutingTestCase):
    def test_role_defaults(self):
        self.add("t1")
        for role, tier in ROLE_DEFAULTS.items():
            r = self.route("t1", role)
            self.assertEqual((r["tier"], r["model"], r["effort"]),
                             (tier, CLAUDE[tier], "low"), role)

    def test_text_output_is_the_model_then_tier_and_effort(self):
        self.add("t1")
        p = self.ok("route", "t1", "--role", "implementor")
        self.assertRegex(p.stdout.splitlines()[0], r"\bsonnet\s*$")
        self.assertRegex(p.stdout, r"(?m)^tier: standard$")
        self.assertRegex(p.stdout, r"(?m)^effort: low$")

    def test_unknown_role_is_a_usage_error(self):
        self.add("t1")
        p = self.refused(2, "route", "t1", "--role", "janitor")
        self.assertIn("janitor", p.stderr)

    def test_ambiguous_goes_one_tier_up(self):
        self.add("t1")
        r = self.route("t1", "implementor", "--ambiguous")
        self.assertEqual((r["tier"], r["effort"]), ("heavy", "low"))
        self.assertEqual(self.route("t1", "reporter", "--ambiguous")["tier"], "standard")

    def test_large_change_bumps_reviewer_and_investigation_only(self):
        self.add("t1")
        r = self.route("t1", "reviewer", "--files", "6")
        self.assertEqual((r["tier"], r["effort"]), ("standard", "low"))
        self.assertEqual(self.route("t1", "investigation", "--lines", "301")["tier"],
                         "standard")
        # At the thresholds: no bump.
        self.assertEqual(self.route("t1", "reviewer", "--files", "5", "--lines", "300")
                         ["tier"], "light")
        # Other roles ignore the size of the change.
        self.assertEqual(self.route("t1", "implementor", "--files", "9", "--lines", "900")
                         ["tier"], "standard")
        self.assertEqual(self.route("t1", "verifier", "--files", "9")["tier"], "light")

    def test_reviewer_floor_is_one_below_the_last_implementor(self):
        self.add("t1")
        self.log_run("t1", "implementor", "opus")
        r = self.route("t1", "reviewer")
        self.assertEqual((r["tier"], r["model"], r["effort"]), ("standard", "sonnet", "low"))
        self.assertTrue(r["floors"], "the floor applied must be named")

    def test_no_role_drops_below_the_highest_recorded_tier_minus_one(self):
        self.add("t1")
        self.log_run("t1", "test-writer", "fable")
        for role in ("verifier", "reporter", "filer"):
            self.assertEqual(self.route("t1", role)["tier"], "heavy", role)

    def test_a_bounce_climbs_one_rung_effort_first_then_tier(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", "sonnet")
        self.ok("phase", "t1", "fix")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"]), ("standard", "sonnet", "high"))
        self.assertTrue(any("one rung above" in w and "standard/low" in w
                            for w in r["floors"]), r["floors"])
        self.log_run("t1", "implementor", "sonnet", effort="high")
        # The review cap (2 rounds) would refuse a second bounce; reset it.
        self.db_exec("UPDATE tickets SET review_rounds=0 WHERE id=?", ("t1",))
        self.phases("t1", "review", "fix")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"]), ("heavy", "opus", "low"))

    def test_ci_repair_routes_standard_low_after_heavy_review_fix(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", CLAUDE["standard"], effort="high")
        self.ok("phase", "t1", "fix")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["effort"]), ("heavy", "low"))
        self.log_run("t1", "implementor", CLAUDE["heavy"])
        self.phases("t1", "review", "verify", "report", "mr", "ci")

        before = self.show("t1")
        counts = (before["bounces"], before["review_rounds"])
        self.ok("phase", "t1", "fix")
        after = self.show("t1")
        self.assertEqual((after["bounces"], after["review_rounds"]), counts)
        latest = self.runs("t1")[-1]
        self.assertEqual((latest["role"], latest["tier"], latest["bounce_count"]),
                         ("implementor", "heavy", after["bounces"]))

        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"]),
                         ("standard", CLAUDE["standard"], "low"))
        self.assertFalse(any("after a bounce" in reason for reason in r["floors"]),
                         r["floors"])

    def test_frontier_low_bounces_to_frontier_high_and_tiers_cap_there(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", "opus", effort="high")
        self.ok("phase", "t1", "fix")
        r = self.route("t1", "implementor", "--ambiguous")
        self.assertEqual((r["tier"], r["model"], r["effort"]), ("frontier", "fable", "low"))
        self.log_run("t1", "implementor", "fable")
        # The review cap (2 rounds) would refuse a second bounce; reset it.
        self.db_exec("UPDATE tickets SET review_rounds=0 WHERE id=?", ("t1",))
        self.phases("t1", "review", "fix")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"]), ("frontier", "fable", "high"))

    def test_codex_values(self):
        self.add("t1")
        self.set_harness("t1", "codex")
        cases = [("reviewer", (), "light"), ("test-writer", (), "standard"),
                 ("test-writer", ("--ambiguous",), "heavy")]
        for role, extra, tier in cases:
            r = self.route("t1", role, *extra)
            self.assertEqual((r["tier"], r["model"], r["effort"], r["agent"]),
                             (tier, CODEX[tier], "low", "%s-%s-low" % (role, tier)), role)
            self.assertNotIn("thinking", r)
        p = self.ok("route", "t1", "--role", "implementor")
        self.assertRegex(p.stdout, r"(?m)^effort: low$")
        self.assertIn("agent: implementor-standard-low", p.stdout)

    def test_codex_agent_follows_the_bounce_rung(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", "sonnet")
        self.ok("phase", "t1", "fix")
        self.set_harness("t1", "codex")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"], r["agent"]),
                         ("standard", "gpt-6.1-sol", "high", "implementor-standard-high"))
        self.to_review("t2")
        self.log_run("t2", "implementor", "opus", effort="high")
        self.ok("phase", "t2", "fix")
        self.set_harness("t2", "codex")
        r = self.route("t2", "implementor")
        self.assertEqual((r["tier"], r["model"], r["effort"], r["agent"]),
                         ("frontier", "gpt-6-astra", "low", "implementor-frontier-low"))

    def test_pi_thinking_is_the_effort(self):
        self.add("t1")
        self.set_harness("t1", "pi")
        for role, extra, tier in [("reviewer", (), "light"), ("test-writer", (), "standard"),
                                  ("test-writer", ("--ambiguous",), "heavy")]:
            r = self.route("t1", role, *extra)
            self.assertEqual((r["tier"], r["model"], r["effort"], r["thinking"]),
                             (tier, PI[tier], "low", "low"), role)
            self.assertNotIn("agent", r)
        self.to_review("t2")
        self.log_run("t2", "implementor", "sonnet")
        self.ok("phase", "t2", "fix")
        self.set_harness("t2", "pi")
        r = self.route("t2", "implementor")
        self.assertEqual((r["effort"], r["thinking"]), ("high", "high"))
        p = self.ok("route", "t2", "--role", "implementor")
        self.assertRegex(p.stdout, r"(?m)^effort: high$")
        self.assertRegex(p.stdout, r"(?m)^thinking: high$")

    def test_pi_models_override(self):
        cfg_dir = os.path.join(self.env["XDG_CONFIG_HOME"], "orchestration")
        os.makedirs(cfg_dir, exist_ok=True)
        with open(os.path.join(cfg_dir, "config.json"), "w") as f:
            # New tier key and an old alias (sonnet = standard).
            json.dump({"pi_models": {"light": "venice/small", "sonnet": "venice/mid"}}, f)
        self.add("t1")
        self.set_harness("t1", "pi")
        self.assertEqual(self.route("t1", "reviewer")["model"], "venice/small")
        r = self.route("t1", "test-writer")
        self.assertEqual((r["model"], r["thinking"]), ("venice/mid", "low"))
        self.assertEqual(self.route("t1", "test-writer", "--ambiguous")["model"],
                         PI["heavy"])


class RunTests(RoutingTestCase):
    def test_run_records_the_dispatch_before_it_happens(self):
        self.add("t1")
        row = self.log_run("t1", "implementor", "sonnet")
        self.assertEqual((row["ticket"], row["role"], row["model_requested"], row["tier"],
                          row["bounce_count"], row["effort_requested"]),
                         ("t1", "implementor", "sonnet", "standard", 0, "low"))
        self.assertTrue(row["requested_at"])
        for k in ("model_resolved", "effort_resolved", "agent_id", "resolved_at", "match"):
            self.assertIsNone(row[k], k)
        self.assertEqual([r["seq"] for r in self.runs("t1")], [row["seq"]])
        self.assertIn("run", [e["kind"] for e in self.events("t1")])
        p = self.ok("run", "t1", "--role", "reporter", "--model", "haiku", "--effort", "low")
        self.assertEqual(p.stdout.strip(), str(self.runs("t1")[-1]["seq"]))

    def test_run_records_the_bounce_count_at_dispatch(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", "sonnet")
        self.ok("phase", "t1", "fix")
        row = self.log_run("t1", "implementor", "sonnet", effort="high")
        self.assertEqual((row["tier"], row["bounce_count"], row["effort_requested"]),
                         ("standard", 1, "high"))
        self.assertEqual([r["role"] for r in self.runs("t1")], ["implementor", "implementor"])

    def test_run_below_the_floor_is_refused(self):
        self.add("t1")
        p = self.refused(3, "run", "t1", "--role", "reviewer", "--model", "haiku",
                         "--effort", "low", "--files", "6")
        self.assertNotIn("Traceback", p.stderr)
        self.to_review("t2")
        self.log_run("t2", "implementor", "sonnet")
        self.ok("phase", "t2", "fix")
        # Same tier, rung below the bounce floor (sonnet/high): refused, and the
        # message names both rungs.
        p = self.refused(3, "run", "t2", "--role", "implementor", "--model", "sonnet",
                         "--effort", "low")
        self.assertIn("standard/low", p.stderr)
        self.assertIn("standard/high", p.stderr)
        self.assertEqual(self.runs("t1"), [])
        self.assertEqual(len(self.runs("t2")), 1)
        self.log_run("t2", "implementor", "sonnet", effort="high")
        self.assertEqual(len(self.runs("t2")), 2)

    def test_run_requires_a_valid_effort(self):
        self.add("t1")
        self.refused(2, "run", "t1", "--role", "implementor", "--model", "sonnet")
        for bad in ("medium", "xhigh", ""):
            self.refused(2, "run", "t1", "--role", "implementor", "--model", "sonnet",
                         "--effort", bad)
        self.assertEqual(self.runs("t1"), [])

    def test_run_accepts_a_codex_agent_name_when_the_effort_agrees(self):
        self.add("t1")
        self.set_harness("t1", "codex")
        row = self.log_run("t1", "implementor", "implementor-heavy-high", effort="high")
        self.assertEqual((row["tier"], row["effort_requested"]), ("heavy", "high"))
        self.refused(2, "run", "t1", "--role", "implementor", "--model",
                     "implementor-heavy-high", "--effort", "low")

    def test_run_with_an_unknown_model_is_a_usage_error(self):
        self.add("t1")
        p = self.refused(2, "run", "t1", "--role", "implementor", "--model", "gpt-4")
        self.assertIn("gpt-4", p.stderr)
        self.assertEqual(self.runs("t1"), [])

    def test_show_reports_runs_and_bounces(self):
        self.add("t1")
        self.log_run("t1", "test-writer", "sonnet")
        t = self.show("t1")
        self.assertEqual([r["role"] for r in t["runs"]], ["test-writer"])
        self.assertEqual((t["bounces"], t["model_mismatches"], t["unrecorded_dispatches"]),
                         (0, 0, 0))
        self.assertIn("test-writer", self.ok("show", "t1").stdout)

    def test_runs_and_show_carry_the_effort(self):
        self.add("t1")
        row = self.log_run("t1", "test-writer", "sonnet", effort="high")
        self.assertEqual((row["effort_requested"], row["effort_resolved"]), ("high", None))
        self.assertEqual(self.show("t1")["runs"][0]["effort_requested"], "high")
        for args in (("runs", "t1"), ("show", "t1")):
            out = self.ok(*args).stdout
            self.assertRegex(out, r"\bEFFORT\b", args)
            self.assertIn("EFFORT_RESOLVED", out, args)


class BounceTests(RoutingTestCase):
    def test_review_and_verify_fix_count_as_bounces_ci_fix_does_not(self):
        self.to_review("t1")
        self.ok("phase", "t1", "fix")
        self.assertEqual(self.show("t1")["bounces"], 1)
        self.to_review("t2")
        self.phases("t2", "verify", "fix")
        self.assertEqual(self.show("t2")["bounces"], 1)
        self.to_ci("t3", worktree=self.new_worktree("t3"))
        self.ok("phase", "t3", "fix")
        self.assertEqual(self.show("t3")["bounces"], 0)

    def test_fix_is_refused_only_after_frontier_high_with_block_advice(self):
        self.to_review("t1")
        self.log_run("t1", "implementor", "fable", effort="high")
        p = self.refused(3, "phase", "t1", "fix")
        self.assertIn("block", p.stderr)
        t = self.show("t1")
        self.assertEqual((t["phase"], t["bounces"]), ("review", 0))
        # Escalation keys on the bounce counter, which `phase fix` refused to
        # grow: a route while still in review is not a bounce, only the
        # no-de-escalation floor (one below frontier) applies.
        self.assertEqual(self.route("t1", "implementor")["tier"], "heavy")
        # frontier/low still has a rung left: not refused.
        self.to_review("t2")
        self.log_run("t2", "implementor", "fable")
        self.ok("phase", "t2", "fix")
        self.assertEqual(self.show("t2")["bounces"], 1)

    def test_route_tier_is_accepted_by_run_where_tiers_share_a_model(self):
        # Pi: heavy and frontier print the same model, so the pipeline passes
        # route's tier to run, not its model.
        self.to_review("t1")
        self.log_run("t1", "implementor", "opus", effort="high")
        self.ok("phase", "t1", "fix")
        self.set_harness("t1", "pi")
        r = self.route("t1", "implementor")
        self.assertEqual((r["tier"], r["model"]), ("frontier", PI["frontier"]))
        self.refused(3, "run", "t1", "--role", "implementor", "--model", r["model"],
                     "--effort", r["effort"])
        row = self.log_run("t1", "implementor", r["tier"], effort=r["effort"])
        self.assertEqual((row["tier"], row["model_requested"]), ("frontier", PI["frontier"]))
        # Codex: a role without a per-tier agent has only the shared model.
        # No floor lifts a filer to frontier (the highest run minus one is
        # heavy), so the frontier dispatch is recorded by tier name.
        self.add("t2")
        self.set_harness("t2", "codex")
        self.log_run("t2", "test-writer", "frontier")
        r = self.route("t2", "filer")
        self.assertEqual((r["tier"], r["model"]), ("heavy", "gpt-6-astra"))
        self.assertNotIn("agent", r)
        row = self.log_run("t2", "filer", r["tier"])
        self.assertEqual((row["tier"], row["model_requested"]), ("heavy", "gpt-6-astra"))
        row = self.log_run("t2", "filer", "frontier")
        self.assertEqual((row["tier"], row["model_requested"]), ("frontier", "gpt-6-astra"))


# ---------------------------------------------------------------------------


def assistant(model, effort=None):
    e = {"type": "assistant", "isSidechain": True, "agentId": "a1", "sessionId": "x",
         "message": {"model": model, "content": [{"type": "text", "text": "hi"}]}}
    if effort:
        e["effort"] = effort
    return e


USER_LINE = {"type": "user", "isSidechain": True, "message": {"content": "task"}}


class SubagentStopHookTests(PlatformTestCase):
    def setUp(self):
        super().setUp()
        self.wt = self.git_wt("rt")
        self.spawn_on("T-1", "headless", self.wt)
        self.sid = self.show("T-1")["session_id"]
        self.assertTrue(self.sid, "headless spawn must record a session id")
        self.n = 0

    def transcript(self, lines, meta_model=None):
        self.n += 1
        d = os.path.join(self.tmp, "subagents-%d" % self.n)
        os.makedirs(d)
        path = os.path.join(d, "agent-a%d.jsonl" % self.n)
        with open(path, "w") as f:
            for line in lines:
                f.write(json.dumps(line) + "\n")
        meta = {"agentType": "x"}
        if meta_model:
            meta["model"] = meta_model
        with open(path[:-len(".jsonl")] + ".meta.json", "w") as f:
            json.dump(meta, f)
        return path

    def stop(self, agent_type, path, sid=None, agent_id="a1"):
        p = self.hook_ok("SubagentStop", sid or self.sid, self.wt, extra={
            "agent_type": agent_type, "agent_id": agent_id,
            "agent_transcript_path": path, "transcript_path": "/nonexistent",
            "last_assistant_message": "I am Fable.", "stop_hook_active": False})
        self.assertEqual(p.stdout, "")
        self.assertEqual(p.stderr, "")
        return p

    def runs(self):
        return list_in(self.j("runs", "T-1"), "runs")

    def test_fills_the_run_from_the_transcript(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        path = self.transcript([USER_LINE, assistant("claude-haiku-5-5", "high"),
                                assistant("claude-sonnet-5-5", "low"), USER_LINE])
        self.stop("orchestration:implementor", path, agent_id="ag-7")
        r = self.runs()[0]
        self.assertEqual((r["agent_id"], r["model_resolved"], r["effort_resolved"],
                          r["match"]), ("ag-7", "claude-sonnet-5-5", "low", 1))
        self.assertTrue(r["resolved_at"])
        self.assertEqual(self.show("T-1")["activity"], "working")

    def test_pairs_with_the_oldest_unfilled_row_of_the_role(self):
        self.ok("run", "T-1", "--role", "reviewer", "--model", "haiku", "--effort", "low")
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        self.ok("run", "T-1", "--role", "implementor", "--model", "opus", "--effort", "low")
        self.stop("orchestration:implementor",
                  self.transcript([assistant("claude-sonnet-5-5")]), agent_id="ag-1")
        rows = self.runs()
        self.assertEqual([r["agent_id"] for r in rows], [None, "ag-1", None])

    def test_mismatch_is_recorded_and_reported(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        self.stop("orchestration:implementor",
                  self.transcript([assistant("claude-haiku-5-5")]))
        r = self.runs()[0]
        self.assertEqual((r["model_resolved"], r["match"]), ("claude-haiku-5-5", 0))
        ev = [e for e in self.events("T-1") if e["kind"] == "model_mismatch"]
        self.assertEqual(len(ev), 1)
        self.assertIn("claude-haiku-5-5", ev[0]["detail"])
        self.assertEqual(self.show("T-1")["model_mismatches"], 1)

    def test_effort_mismatch_is_recorded_and_reported(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        self.stop("orchestration:implementor",
                  self.transcript([assistant("claude-sonnet-5-5", "high")]))
        r = self.runs()[0]
        self.assertEqual((r["model_resolved"], r["effort_resolved"], r["match"]),
                         ("claude-sonnet-5-5", "high", 0))
        ev = [e for e in self.events("T-1") if e["kind"] == "model_mismatch"]
        self.assertEqual(len(ev), 1)
        self.assertIn("effort requested=low resolved=high", ev[0]["detail"])
        self.assertEqual(self.show("T-1")["model_mismatches"], 1)

    def test_transcript_without_an_effort_is_not_a_mismatch(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "high")
        self.stop("orchestration:implementor",
                  self.transcript([assistant("claude-sonnet-5-5")]))
        r = self.runs()[0]
        self.assertEqual((r["effort_resolved"], r["match"]), (None, 1))
        self.assertNotIn("model_mismatch", self.event_kinds("T-1"))

    def test_unrecorded_stage_dispatch_is_flagged(self):
        self.stop("orchestration:reviewer",
                  self.transcript([assistant("claude-opus-5-5")], meta_model="opus"))
        ev = [e for e in self.events("T-1") if e["kind"] == "dispatch_unrecorded"]
        self.assertEqual(len(ev), 1)
        self.assertIn("reviewer", ev[0]["detail"])
        self.assertIn("claude-opus-5-5", ev[0]["detail"])
        self.assertEqual(self.show("T-1")["unrecorded_dispatches"], 1)
        # A non-stage agent type without a row is not a stage dispatch.
        n = len(self.events("T-1"))
        self.stop("general-purpose", self.transcript([assistant("claude-haiku-5-5")]))
        self.assertEqual(len(self.events("T-1")), n)

    def test_transcript_without_an_assistant_entry_leaves_the_model_unresolved(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        self.stop("orchestration:implementor", self.transcript([USER_LINE]))
        self.assertIsNone(self.runs()[0]["model_resolved"])
        self.assertIn("model_unresolved", self.event_kinds("T-1"))
        self.assertEqual(self.show("T-1")["model_mismatches"], 0)

    def test_foreign_session_is_ignored(self):
        self.ok("run", "T-1", "--role", "implementor", "--model", "sonnet", "--effort", "low")
        n = len(self.events("T-1"))
        self.stop("orchestration:implementor",
                  self.transcript([assistant("claude-haiku-5-5")]), sid="sid-intruder")
        self.stop("orchestration:reviewer",
                  self.transcript([assistant("claude-haiku-5-5")]), sid="sid-intruder")
        r = self.runs()[0]
        self.assertEqual((r["agent_id"], r["model_resolved"], r["match"]), (None, None, None))
        self.assertEqual(len(self.events("T-1")), n)


class HooksJsonSubagentStopTests(unittest.TestCase):
    def test_subagent_stop_runs_orch_hook(self):
        with open(os.path.join(PLUGIN, "hooks", "hooks.json")) as f:
            data = json.load(f)
        hooks = data.get("hooks", data)
        self.assertIn("SubagentStop", hooks)
        entries = [h for group in hooks["SubagentStop"] for h in group.get("hooks", [])]
        self.assertTrue(entries, hooks["SubagentStop"])
        for h in entries:
            self.assertEqual(shlex.split(h["command"].replace("${CLAUDE_PLUGIN_ROOT}", "R")),
                             ["R/scripts/orch", "hook"])
            self.assertEqual(h.get("timeout"), 10)


# ---------------------------------------------------------------------------

# A stand-in for `claude -p` in the routing smoke test: writes the subagent
# transcript Claude Code would write, with RESOLVED as the model, or (when
# RESOLVED is None) the model the prompt asked for.
SMOKE_SRC = r'''
import json, os, re, sys
PROJECTS, RESOLVED, EFFORT = %(projects)r, %(resolved)r, %(effort)r
a = sys.argv[1:]
if "--session-id" in a and os.path.realpath(os.getcwd()) == %(root)r:
    sid = a[a.index("--session-id") + 1]
    text = " ".join(a) + " " + (sys.stdin.read() if not sys.stdin.isatty() else "")
    if RESOLVED is None:
        m = re.search(r"\b(fable|haiku|opus|sonnet)\b", text)
        RESOLVED = {"fable": "claude-fable-5-1"}.get(m.group(1), "claude-%%s-5-5" %% m.group(1))
    if EFFORT is None:
        EFFORT = re.search(r'effort "(\w+)"', text).group(1)
    key = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())  # as Claude Code names the project dir
    d = os.path.join(PROJECTS, key, sid, "subagents")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "agent-x.jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "message": {"content": "go"}}) + "\n")
        f.write(json.dumps({"type": "assistant", "isSidechain": True,
                            "effort": EFFORT, "message": {"model": RESOLVED}}) + "\n")
    print(json.dumps({"type": "system", "session_id": sid}), flush=True)
    sys.exit(0)
'''


class SmokeRoutingTests(AdapterTestCase):
    def setUp(self):
        super().setUp()
        self.claude_dir = os.path.join(self.tmp, "claude-config")
        os.makedirs(os.path.join(self.claude_dir, "projects"))
        self.env["CLAUDE_CONFIG_DIR"] = self.claude_dir

    def smoke_claude(self, resolved=None, session=False, effort=None):
        src = SMOKE_SRC % {"projects": os.path.join(self.claude_dir, "projects"),
                           "resolved": resolved, "effort": effort, "root": os.path.realpath(self.root)}
        if session:
            src += SESSION_CLAUDE_SRC % {"record": self.record, "orch": ORCH,
                                         "report": True}
        return self._script("fake-smoke-claude", src)

    def test_passes_when_the_transcript_model_matches(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude()
        p = self.ok("smoke-routing", timeout=120)
        for word in ("haiku/high", "fable/high", "claude-haiku-5-5/high",
                     "claude-fable-5-1/high"):
            self.assertIn(word, p.stdout)
        self.assertNotIn("fail", p.stdout.lower())

    def test_the_requested_effort_is_asked_for_and_checked(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude()
        p = self.ok("smoke-routing", "--model", "haiku", "--effort", "low", "--json",
                    timeout=120)
        r = json.loads(p.stdout)["results"][0]
        self.assertEqual((r["effort_requested"], r["effort_resolved"], r["ok"]),
                         ("low", "low", True))

    def test_fails_when_the_transcript_effort_differs(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude(effort="low")
        p = self.refused(3, "smoke-routing", "--model", "haiku", timeout=120)
        self.assertIn("claude-haiku-5-5/low", p.stdout)
        self.assertIn("fail", p.stdout.lower())

    def test_an_unknown_effort_is_a_usage_error(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude()
        p = self.refused(2, "smoke-routing", "--effort", "medium")
        self.assertNotIn("unrecognized arguments", p.stderr)  # the flag must exist
        self.assertIn("medium", p.stderr)

    def test_fails_when_the_transcript_model_differs(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude(resolved="claude-sonnet-5-5")
        p = self.refused(3, "smoke-routing", "--model", "haiku", timeout=120)
        self.assertIn("claude-sonnet-5-5", p.stdout)
        self.assertIn("fail", p.stdout.lower())

    def test_other_harnesses_are_not_supported(self):
        self.env["ORCH_HARNESS"] = "pi"
        p = self.refused(3, "smoke-routing")
        self.assertIn("not supported", p.stderr)

    def test_selftest_runs_the_routing_smoke_last(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude(session=True)
        p = self.orch("selftest", "--json", "--timeout", "30", timeout=300)
        out = json.loads(p.stdout)
        self.assertEqual(p.returncode, 0, "stdout=%r stderr=%r" % (p.stdout, p.stderr))
        names = [s["name"] for s in out["steps"]]
        self.assertIn("routing", names[-1], names)
        self.assertEqual(names[:-1], SELFTEST_STEPS)

    def test_selftest_skip_routing(self):
        self.env["ORCH_CLAUDE_BIN"] = self.smoke_claude(session=True)
        p = self.orch("selftest", "--json", "--timeout", "30", "--skip-routing",
                      timeout=150)
        self.assertEqual(p.returncode, 0, "stdout=%r stderr=%r" % (p.stdout, p.stderr))
        out = json.loads(p.stdout)
        self.assertEqual([s["name"] for s in out["steps"]], SELFTEST_STEPS)
        self.assertFalse(os.listdir(os.path.join(self.claude_dir, "projects")))


if __name__ == "__main__":
    unittest.main()
