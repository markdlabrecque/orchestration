"""Black-box tests for `orch wait` (#98): block until a ticket needs attention."""

import json
import subprocess
import time
import unittest

from test_orch import ORCH, OrchTestCase, wait_until


class WaitTests(OrchTestCase):
    def setUp(self):
        super().setUp()
        self.init()

    def max_seq(self):
        return self.db_exec("SELECT COALESCE(MAX(seq),0) FROM events")[0][0]

    def count(self, where):
        return self.db_exec("SELECT COUNT(*) FROM events WHERE " + where)[0][0]

    def start_mark(self):
        """Starting watermark, as an orchestrator gets it: a short wait first
        records any already-dead health and prints where things stand."""
        p = self.orch("wait", "--json", "--interval", "0.1", "--timeout", "0.2")
        self.assertEqual(p.returncode, 6, p.stderr)
        return json.loads(p.stdout)["watermark"]

    def start_wait(self, *args):
        p = subprocess.Popen(
            [ORCH, "wait", "--json", "--interval", "0.1", *args],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: p.poll() is None and p.kill())
        return p

    def finish(self, p, timeout=15):
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err

    def run_wait(self, *args):
        p = self.orch("wait", "--json", "--interval", "0.1", *args)
        return p.returncode, json.loads(p.stdout) if p.stdout.strip() else None

    def parse(self, rc, out, err, want_rc=0):
        self.assertEqual(rc, want_rc, "stdout=%r stderr=%r" % (out, err))
        return json.loads(out)

    def test_wakes_on_block(self):
        self.dispatched("T-1")
        since = self.start_mark()
        p = self.start_wait("--since", str(since), "--timeout", "20")
        time.sleep(0.5)
        self.assertIsNone(p.poll(), "wait returned with no wake event")
        self.ok("block", "T-1", "--reason", "x")
        data = self.parse(*self.finish(p))
        self.assertFalse(data["timed_out"])
        self.assertEqual([(e["ticket"], e["kind"], e["detail"]) for e in data["events"]],
                         [("T-1", "blocked", "x")])
        self.assertGreaterEqual(data["watermark"], data["events"][0]["seq"])
        self.assertGreater(data["events"][0]["seq"], since)

    def test_wakes_on_merged_as_done(self):
        self.dispatched("T-1")
        self.phases("T-1", "spec", "tests", "implement", "review", "verify",
                    "report", "mr", "ci")
        self.ok("ci", "T-1", "--sha", "abc", "--passed")
        since = self.start_mark()
        p = self.start_wait("--since", str(since), "--timeout", "20")
        self.ok("merged", "T-1", "--sha", "abc")
        data = self.parse(*self.finish(p))
        self.assertEqual([(e["ticket"], e["kind"]) for e in data["events"]],
                         [("T-1", "done")])

    def test_timeout_exit_6(self):
        p = self.orch("wait", "--json", "--interval", "0.1", "--timeout", "1")
        self.assertEqual(p.returncode, 6, p.stderr)
        data = json.loads(p.stdout)
        self.assertEqual(data["events"], [])
        self.assertTrue(data["timed_out"])
        self.assertIn("watermark", data)

    def test_watermark_no_loss_no_repeat(self):
        self.dispatched("T-1")
        before = self.max_seq()
        self.ok("block", "T-1", "--reason", "x")
        # an older watermark still sees the missed wake event
        rc, data = self.run_wait("--since", str(before), "--timeout", "5")
        self.assertEqual(rc, 0)
        self.assertEqual([e["kind"] for e in data["events"]], ["blocked"])
        # the returned watermark does not return it again
        rc, again = self.run_wait("--since", str(data["watermark"]), "--timeout", "1")
        self.assertEqual(rc, 6)
        self.assertEqual(again["events"], [])
        self.assertGreaterEqual(again["watermark"], data["watermark"])

    def test_dead_session_wakes_once(self):
        self.dispatched("T-1")
        self.ok("phase", "T-1", "spec")  # active phase, pid no longer alive
        rc, data = self.run_wait("--since", "0", "--timeout", "5")
        self.assertEqual(rc, 0)
        self.assertEqual([(e["ticket"], e["kind"]) for e in data["events"]],
                         [("T-1", "dead")])
        # re-run with the old watermark: still reported, but not re-recorded
        rc, data2 = self.run_wait("--since", "0", "--timeout", "5")
        self.assertEqual(rc, 0)
        self.assertEqual([e["kind"] for e in data2["events"]], ["dead"])
        self.assertEqual(self.count("kind='health' AND detail='dead'"), 1)

    def test_concurrent_waits_each_see_block_once(self):
        self.dispatched("T-1")
        since = str(self.start_mark())
        mark = int(since)
        ps = [self.start_wait("--since", since, "--timeout", "20") for _ in range(2)]
        time.sleep(0.5)
        self.ok("block", "T-1", "--reason", "x")
        for p in ps:
            data = self.parse(*self.finish(p))
            self.assertEqual([e["kind"] for e in data["events"]], ["blocked"])
        self.assertEqual(self.count("kind='block'"), 1)
        self.assertEqual(self.count("kind='health' AND seq>%d" % mark), 0)


if __name__ == "__main__":
    unittest.main()
