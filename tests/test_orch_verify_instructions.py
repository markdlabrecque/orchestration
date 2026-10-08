"""Instruction contracts for the policy branch outside CLI prompt generation."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class VerificationInstructionTests(unittest.TestCase):
    def test_manual_brief_and_pipeline_select_local_tests(self):
        skill = (ROOT / "skills/orchestration/SKILL.md").read_text()
        self.assertIn("<ddev | docker | local-tests>", skill)
        self.assertIn("using `verify_env` from preflight", skill)
        pipeline = (ROOT / "skills/orchestration/references/ticket-pipeline.md").read_text()
        self.assertIn("After review passes, enter `report` directly", pipeline)
        self.assertIn("Exact-head CI remains required before merge", pipeline)
        self.assertIn("Missing, failed or incomplete test evidence blocks completion", pipeline)

    def test_verifier_branches_before_persona_and_site_assumptions(self):
        verifier = (ROOT / "agents/verifier.md").read_text()
        branch = verifier.index("If it is `local-tests`")
        persona = verifier.index("You are someone who uses or edits this site")
        self.assertLess(branch, persona)
        instructions = verifier[branch:persona]
        self.assertIn("assess actual automated-test evidence only", instructions)
        self.assertIn("Missing, failed, stale or incomplete evidence cannot pass", instructions)
        self.assertIn("browser, usability and accessibility checks were not performed", instructions)
        self.assertIn("Stop here", instructions)


if __name__ == "__main__":
    unittest.main()
