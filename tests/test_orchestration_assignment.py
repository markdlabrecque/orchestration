"""Offline contracts for the main orchestrator's tracker pickup instructions.

These check local guidance, not tracker execution. No CLI or network is invoked.
Run: python3 -m unittest discover -s tests -p 'test_orchestration_assignment.py' -v
"""

from pathlib import Path
import re
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "orchestration" / "SKILL.md"


class AssignmentInstructionsTests(unittest.TestCase):
    def setUp(self):
        self.text = SKILL.read_text(encoding="utf-8")

    def assignment_contract(self):
        # Discover the shared section by subject, not an exact heading/snapshot.
        sections = re.split(r"(?m)^(#{2,6})\s+(.+)\n", self.text)
        for i in range(1, len(sections), 3):
            heading, body = sections[i + 1], sections[i + 2]
            if re.search(r"assign", heading, re.I):
                return heading, re.sub(r"\s+", " ", body).lower()
        self.fail("Missing shared assignment section in the orchestration skill")

    def step(self, label):
        match = re.search(
            r"(?ms)^\d+\. \*\*" + re.escape(label)
            + r"\.\*\*(.*?)(?=^\d+\. \*\*|^##|\Z)", self.text
        )
        self.assertIsNotNone(match, "Missing main-orchestrator step: " + label)
        return re.sub(r"\s+", " ", match.group(1)).lower()

    def assert_concepts(self, text, *patterns):
        for pattern in patterns:
            with self.subTest(concept=pattern):
                self.assertRegex(text, pattern)

    def assert_shared_hook(self, text, heading):
        # A Markdown anchor or the shared heading's name makes the rule reachable.
        anchor = re.sub(r"[^a-z0-9 -]", "", heading.lower()).replace(" ", "-")
        self.assertTrue(
            heading.lower() in text or "#" + anchor in text,
            "Pickup path must reference the shared assignment rule",
        )

    def test_new_pickup_requires_assignment_before_local_add(self):
        pickup = self.step("Add tickets")
        self.assertNotRegex(pickup, r"assign.{0,60}if the project says")
        heading, _ = self.assignment_contract()
        self.assert_shared_hook(pickup, heading)
        self.assertLess(pickup.find("assign"), pickup.find("orch add"),
                        "Assignment must precede orch add")

    def assert_recovery_scope_and_order(self):
        heading, _ = self.assignment_contract()
        recovery = self.step("Recover first")
        self.assert_shared_hook(recovery, heading)
        # Scope must belong to the recovery hook, not just the shared section.
        self.assertRegex(
            recovery,
            r"assign[^.;]*\bactive\b[^.;]*\bexisting\b[^.;]*`orch list`",
        )
        self.assertIn("orch resume", recovery)
        self.assertLess(recovery.find("assign"), recovery.find("orch resume"),
                        "Assignment must precede recovery resume")
        self.assertRegex(recovery, r"assign.*?\b(?:then|before)\b.*?orch resume")

    def test_recovery_scopes_assignment_to_active_board_before_resume(self):
        self.assert_recovery_scope_and_order()

    def test_recovery_contract_rejects_missing_scope(self):
        original = self.step("Recover first")
        for missing in ("active ", "existing ", " on `orch list`"):
            with self.subTest(missing=missing):
                fixture = original.replace(missing, "", 1)
                self.assertNotEqual(fixture, original)
                # In-memory mutations retain the shared Assignment link.
                with mock.patch.object(self, "step", return_value=fixture):
                    with self.assertRaises(AssertionError):
                        self.assert_recovery_scope_and_order()

    def test_recovery_contract_rejects_resume_before_assignment(self):
        fixture = (
            "use `orch resume <ticket>` each cleared ticket, then apply "
            "[assignment](#assignment) to active existing tickets on `orch list`."
        )
        with mock.patch.object(self, "step", return_value=fixture):
            with self.assertRaises(AssertionError):
                self.assert_recovery_scope_and_order()

    def test_recovery_dispatch_and_supervision_reach_the_shared_rule(self):
        heading, _ = self.assignment_contract()
        for label in ("Recover first", "Dispatch", "Supervise until every ticket is done"):
            with self.subTest(path=label):
                self.assert_shared_hook(self.step(label), heading)
        self.assert_shared_hook(self.text.split("## Recovery, in one line", 1)[1].lower(),
                                heading)

    def test_existing_active_board_tickets_are_checked_but_history_is_skipped(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(
            contract, r"active", r"existing|already", r"unassigned",
            r"board|orch list", r"skip|exclude|ignore", r"done", r"retired",
        )

    def test_requester_identity_has_human_safe_resolution_and_no_owner_constant(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(
            contract, r"request(?:er|ing human)", r"explicit", r"project.{0,60}convention",
            r"authenticated", r"bot|service account", r"ask.{0,100}(?:identity|user|human|account)|(?:unresolved|unknown).{0,100}ask",
        )
        self.assertNotIn("markdlabrecque", contract)
        self.assertRegex(contract, r"authenticated.{0,180}(?:only|matches|identifies|same).{0,100}(?:human|requester)")

    def test_already_assigned_is_an_idempotent_no_mutation_case(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(contract, r"already assigned|already.{0,60}assignee",
                             r"no (?:mutation|change|update)|skip.{0,60}(?:mutation|update)|leave.{0,40}unchanged",
                             r"idempotent|repeat")

    def test_tracker_updates_preserve_other_assignees(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(
            contract, r"gh issue edit", r"--add-assignee", r"gitlab|glab",
            r"union|merge|combine", r"existing.{0,80}(?:assignee|ids)",
            r"single.assignee|single.assignment|one assignee",
            r"stop|ask", r"replace|overwrite",
        )

    def test_verified_remote_success_gates_add_and_dispatch(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(
            contract, r"read.back|re.read|refetch|fetch again",
            r"confirm|verify|verified", r"before.{0,100}orch add",
            r"before.{0,100}(?:dispatch|spawn)|(?:dispatch|spawn).{0,100}(?:only after|until)",
        )

    def test_failures_stop_existing_resume_and_are_reported_honestly(self):
        _, contract = self.assignment_contract()
        self.assert_concepts(
            contract, r"auth", r"permission", r"tracker", r"error|fail",
            r"report|surface", r"existing", r"resume",
            r"stop|block|do not|never", r"local.{0,80}(?:state|orch)|orch.{0,80}(?:local|state)",
        )


if __name__ == "__main__":
    unittest.main()
