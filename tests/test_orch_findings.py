"""Black-box tests for the review findings ledger (#107)."""

import os

from test_orch_routing import RoutingTestCase


class FindingsTests(RoutingTestCase):
    def setUp(self):
        super().setUp()
        self.to_review("t1")  # review round 1

    def next_round(self):
        self.ok("phase", "t1", "fix")
        self.ok("phase", "t1", "review")

    def ledger(self):
        return {f["id"]: f for f in self.show("t1")["findings"]}

    def finding_events(self):
        return [r[0] for r in self.db_exec(
            "SELECT detail FROM events WHERE ticket='t1' AND kind='finding' "
            "AND from_phase IS NULL AND to_phase IS NULL ORDER BY seq")]

    def test_add_assigns_sequential_ids_and_events(self):
        a = self.j("finding", "add", "t1", "--severity", "must-fix",
                   "--summary", "null deref", "--file", "a.py:3")
        b = self.j("finding", "add", "t1", "--severity", "nit", "--summary", "typo")
        self.assertEqual((a["id"], b["id"]), ("F1", "F2"))
        led = self.ledger()
        self.assertEqual((led["F1"]["round"], led["F1"]["status"],
                          led["F1"]["rounds_open"], led["F1"]["file"]),
                         (1, "open", 1, "a.py:3"))
        self.assertEqual(len(self.finding_events()), 2)

    def test_raise_counts_each_round_once_and_set_reopens(self):
        self.j("finding", "add", "t1", "--severity", "must-fix", "--summary", "x")
        self.j("finding", "add", "t1", "--severity", "must-fix", "--summary", "keeps bounces legitimate")
        self.ok("finding", "raise", "t1", "F1")
        self.assertEqual(self.ledger()["F1"]["rounds_open"], 1)
        self.next_round()
        self.ok("finding", "raise", "t1", "F1")
        self.ok("finding", "raise", "t1", "F1")
        f = self.ledger()["F1"]
        self.assertEqual((f["rounds_open"], f["last_raised_round"], f["round"]),
                         (2, 2, 1))
        self.ok("finding", "set", "t1", "F1", "--status", "fixed")
        f = self.ledger()["F1"]
        self.assertEqual((f["status"], f["status_round"]), ("fixed", 2))
        self.next_round()
        self.ok("finding", "raise", "t1", "F1")
        f = self.ledger()["F1"]
        self.assertEqual((f["status"], f["status_round"], f["rounds_open"]),
                         ("open", 3, 3))
        self.assertEqual(len(self.finding_events()), 7)

    def test_state_md_lists_only_open_must_fix(self):
        self.j("finding", "add", "t1", "--severity", "must-fix", "--summary", "keepme")
        self.j("finding", "add", "t1", "--severity", "must-fix", "--summary", "fixedone")
        self.j("finding", "add", "t1", "--severity", "nit", "--summary", "nitone")
        self.ok("finding", "set", "t1", "F2", "--status", "fixed")
        with open(os.path.join(self.root, "STATE.md")) as f:
            md = f.read()
        self.assertIn("### Open must-fix findings", md)
        section = md.split("### Open must-fix findings", 1)[1].split("\n##", 1)[0]
        self.assertIn("keepme", section)
        self.assertNotIn("fixedone", section)
        self.assertNotIn("nitone", section)

    def test_refusals(self):
        self.dispatched("t2", worktree=self.new_worktree("t2"))
        self.refused(3, "finding", "add", "t2", "--severity", "nit", "--summary", "s")
        self.refused(4, "finding", "raise", "t1", "F9")
        self.refused(4, "finding", "set", "t1", "F9", "--status", "fixed")

    def test_pre_findings_database_gains_table_and_triggers(self):
        # Older orch left repair-grant triggers but no findings table/triggers.
        self.db_exec("DROP TABLE findings")
        self.assertEqual(self.db_exec(
            "SELECT name FROM sqlite_master WHERE name LIKE 'state_md_findings_%'"), [])
        self.assertEqual(len(self.db_exec(
            "SELECT name FROM sqlite_master WHERE name IN "
            "('state_md_repair_grants_delete','state_md_second_repair_grants_delete')")), 2)
        self.ok("show", "t1")
        self.assertEqual(self.db_exec(
            "SELECT name FROM sqlite_master WHERE name='findings' AND type='table'"),
            [("findings",)])
        self.assertEqual(self.db_exec(
            "SELECT name FROM sqlite_master WHERE type='trigger' "
            "AND name LIKE 'state_md_findings_%' ORDER BY name"),
            [("state_md_findings_delete",), ("state_md_findings_insert",),
             ("state_md_findings_update",)])

    def add_must_fix(self, *extra):
        return self.j("finding", "add", "t1", "--severity", "must-fix",
                      "--summary", "late", *extra)

    def test_round2_uncategorised_must_fix_downgrades_and_cannot_bounce(self):
        self.next_round()
        f = self.add_must_fix()
        self.assertEqual(f["severity"], "follow-up")
        self.assertIn("downgraded", f["reason"])
        self.assertIn("downgraded", self.ledger()[f["id"]]["reason"])
        bounces = self.show("t1")["bounces"]
        self.refused(3, "phase", "t1", "fix")
        t = self.show("t1")
        self.assertEqual((t["phase"], t["bounces"]), ("review", bounces))

    def test_round2_categorised_must_fix_stays_and_bounces(self):
        self.next_round()
        f = self.add_must_fix("--category", "fix-defect")
        self.assertEqual((f["severity"], f["category"]), ("must-fix", "fix-defect"))
        self.ok("phase", "t1", "fix")

    def test_round2_reraised_round1_must_fix_bounces(self):
        self.add_must_fix()  # round 1, uncategorised, stays must-fix
        self.next_round()
        self.ok("finding", "raise", "t1", "F1")
        self.ok("phase", "t1", "fix")

    def test_findings_table_without_category_reason_is_migrated(self):
        for col in ("category", "reason"):  # no-op until the schema has them
            if col in [r[1] for r in self.db_exec("PRAGMA table_info(findings)")]:
                self.db_exec("ALTER TABLE findings DROP COLUMN " + col)
        self.ok("show", "t1")
        cols = [r[1] for r in self.db_exec("PRAGMA table_info(findings)")]
        self.assertIn("category", cols)
        self.assertIn("reason", cols)

    def test_show_text_findings_have_header_and_unprefixed_rows(self):
        self.j("finding", "add", "t1", "--severity", "nit", "--summary", "typo")
        lines = self.ok("show", "t1").stdout.splitlines()
        i = lines.index("findings:")
        self.assertEqual(lines[i + 1].split("\t"),
                         ["ID", "SEVERITY", "STATUS", "ROUND", "ROUNDS_OPEN",
                          "FILE", "SUMMARY"])
        self.assertEqual(lines[i + 2].split("\t"),
                         ["F1", "nit", "open", "1", "1", "-", "typo"])

    def test_events_text_hides_none_phase_for_finding_events(self):
        self.j("finding", "add", "t1", "--severity", "nit", "--summary", "typo")
        rows = [l.split("\t") for l in self.ok("events", "t1").stdout.splitlines()]
        finding = [r for r in rows if r[1] == "finding"]
        self.assertTrue(finding)
        for r in finding:
            self.assertEqual(len(r), 4)
            self.assertEqual(r[2], "")
            self.assertNotIn("None", "\t".join(r))
        self.assertIn("implement -> review", [r[2] for r in rows if r[1] == "phase"])

    def test_finding_add_bad_severity_is_orch_usage_error(self):
        p = self.refused(2, "finding", "add", "t1", "--severity", "bogus",
                         "--summary", "x")
        self.assertTrue(p.stderr.startswith("orch: "), p.stderr)
        self.assertNotIn("usage:", p.stderr)
        for sev in ("must-fix", "follow-up", "nit"):
            self.assertIn(sev, p.stderr)
