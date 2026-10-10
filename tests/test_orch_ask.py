"""Black-box tests for `orch ask` / `orch answer` (#99)."""

import json
import os
import subprocess
import unittest

from test_orch import ORCH, OrchTestCase


class AskTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.init()
        self.dispatched("T-1")
        # record the already-dead session's health event up front so it
        # does not show up as a wake later
        self.orch("wait", "--json", "--interval", "0.1", "--timeout", "0.2")
        self.mark = self.db_exec("SELECT COALESCE(MAX(seq),0) FROM events")[0][0]

    def qids(self):
        return [r[0] for r in self.db_exec(
            "SELECT seq FROM events WHERE ticket='T-1' AND kind='question'")]

    def start_ask(self, question, timeout="20"):
        p = subprocess.Popen(
            [ORCH, "ask", "T-1", question, "--json", "--interval", "0.1",
             "--timeout", timeout],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: p.poll() is None and p.kill())
        return p

    def ask(self, question, timeout="0.3"):
        return self.orch("ask", "T-1", question, "--json", "--interval", "0.1",
                         "--timeout", timeout)

    def wait_question(self):
        p = self.orch("wait", "--json", "--interval", "0.1", "--timeout", "5",
                      "--since", str(self.mark))
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)["events"]

    def test_ask_returns_answer_given_later(self):
        p = self.start_ask("Is dep merged?")
        qe = self.wait_question()
        self.assertEqual([(e["kind"], e["detail"]) for e in qe],
                         [("question", "Is dep merged?")])
        self.ok("answer", "T-1", str(qe[0]["seq"]), "yes")
        out, err = p.communicate(timeout=15)
        self.assertEqual(p.returncode, 0, err)
        data = json.loads(out)
        self.assertEqual(data["answer"], "yes")
        self.assertEqual(data["question_id"], qe[0]["seq"])
        self.assertFalse(data["timed_out"])

    def test_timeout_exit_6(self):
        p = self.ask("anyone?")
        self.assertEqual(p.returncode, 6, p.stderr)
        data = json.loads(p.stdout)
        self.assertTrue(data["timed_out"])
        self.assertIsNone(data["answer"])

    def test_question_and_answer_recorded(self):
        self.assertEqual(self.ask("Which base?").returncode, 6)
        qid = self.qids()[0]
        self.ok("answer", "T-1", str(qid), "develop")
        ev = self.ok("events", "T-1").stdout
        self.assertIn("Which base?", ev)
        self.assertIn("develop", ev)
        with open(os.path.join(self.root, "STATE.md")) as f:
            state = f.read()
        self.assertIn("Which base?", state)
        self.assertIn("develop", state)

    def test_resume_returns_answer_without_new_question(self):
        self.assertEqual(self.ask("Which base?").returncode, 6)
        self.ok("answer", "T-1", str(self.qids()[0]), "develop")
        p = self.ask("Which base?", timeout="5")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["answer"], "develop")
        self.assertEqual(len(self.qids()), 1)

    def test_wait_wakes_on_question_not_answer(self):
        self.assertEqual(self.ask("Q?").returncode, 6)
        evs = self.wait_question()
        self.assertEqual([(e["ticket"], e["kind"], e["detail"]) for e in evs],
                         [("T-1", "question", "Q?")])
        after = self.db_exec("SELECT MAX(seq) FROM events")[0][0]
        self.ok("answer", "T-1", str(evs[0]["seq"]), "a")
        p = self.orch("wait", "--json", "--interval", "0.1", "--timeout", "1",
                      "--since", str(after))
        self.assertEqual(p.returncode, 6, p.stdout + p.stderr)
        self.assertEqual(json.loads(p.stdout)["events"], [])

    def test_answer_refusals(self):
        self.refused(4, "answer", "T-1", "99999", "x")
        self.assertEqual(self.ask("Q?").returncode, 6)
        qid = str(self.qids()[0])
        self.ok("answer", "T-1", qid, "first")
        self.refused(3, "answer", "T-1", qid, "second")


if __name__ == "__main__":
    unittest.main()
