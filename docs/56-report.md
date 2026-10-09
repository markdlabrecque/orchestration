# Ticket 56 report

Ticket: https://github.com/markdlabrecque/orchestration/issues/56

Reviewed code candidate: `d45c2159c0eafafbbd3894f6892871d908e706e1`.

## What was built

`STATE.md` now has a deterministic managed snapshot and history of committed SQLite workflow records. Compact ticket/activity tables accompany detailed records, with stable ticket and event ordering, stored timestamps, source revision and event watermark. Synthetic selftest records are excluded. The output reports recorded state, not inferred health or liveness.

`orch state-md check` detects stale, missing, tampered or malformed managed content without repairing it. `orch state-md rebuild` and safe command completion reconcile it without platform calls. Durable revision tracking and managed-byte comparison cover commit-to-export and replace-to-ack crash gaps, including older sibling processes' commits. Internal lifecycle, baseline, run completion and hook writes participate after commit. Failed publication reports that the database commit succeeded and the document is stale. Ordinary commands return a controlled failure; hooks diagnose on stderr and retain exit zero. SQLite snapshot failures do not compensate successful lifecycle launches.

Publication uses a stable lock, a fresh committed snapshot, notes read after acquiring the lock, atomic replacement and fsync. Migration preserves the entire legacy document and unowned notes. Durable hard links retain replaced inodes so already-open legacy appenders cannot lose late tails. Check detects those tails as stale; rebuild includes them losslessly. Malformed ownership markers refuse destructive replacement.

The authoritative contract is in `skills/orchestration/references/orch-cli.md`, reached from README. Production changes are in `scripts/orch`; regressions are in `tests/test_orch_state_md.py`, `tests/test_orch.py` and `tests/test_orch_baseline.py`.

## Test evidence

Evidence below is from the implementation, repair and independent review artifacts, not a new reporter test run.

| Command | Candidate result |
| --- | --- |
| `python3 -m unittest discover -s tests -v` | 517 tests, exit 0, 15 unchanged environment skips. Repair run took 425.245 seconds; independently repeated with the same passing count. |
| `NPM_CONFIG_PREFIX=/home/mark/.local node --test tests/pi/extension.test.mjs` | 10 passed, 0 failed, 0 skipped; independently repeated. |
| `PYTHONPATH=tests python3 -m unittest -v test_orch_state_md test_orch.StateMdTests` | 47 focused tests passed in 20.371 seconds. |
| `git diff --check` | Passed at the repair checkpoint. |

Repair logs are `.scratch/56-fix-1-full.log`, `.scratch/56-fix-1-full.exit`, `.scratch/56-fix-1-node.log` and `.scratch/56-fix-1-focused-final.log`. Seven targeted new tests first ran red against `d80a268`, with nine failures including subtests, in `.scratch/56-fix-1-red.log`. The final repair adds nine tests and restores lifecycle/attempt sequencing assertions. No tests were weakened, retired or newly skipped.

An earlier background Python invocation inherited ignored SIGINT and failed three interrupt tests. Foreground focused and complete reruns passed without signal-guard changes. A later tool-policy rejection prevented a parallel Node invocation from starting; its foreground retry passed. Locked scratch handoffs were respected and replaced by new handoff files. These invocation failures were not rejected work or additional review bounces.

SQLite ResourceWarnings were nonfatal. Exploratory pytest was unavailable; the configured unittest suite completed. Separate verification, browser and accessibility stages were waived by root `AGENTS.md`. There were no verifier errors.

## Review outcome

Two review entries recorded one actual bounce. Review 1 rejected `d80a268` for lost legacy-inode appends, uncontrolled SQLite publication errors, inadequate human-readable output and lost lifecycle assertions. Repair checkpoint `d45c2159c0eafafbbd3894f6892871d908e706e1` addresses all four.

Review 2 approved that candidate with follow-ups and no must-fix defects. Inspection found no additional loss window, lifecycle compensation error or lock-order cycle in the supported protocol. Tool constraints prevented the reviewer from separately inspecting Git diff/cleanliness; the orchestrator confirmed those at the boundary. The reviewer mentioned a two-round profile cap, so the work could use more review passes. This did not consume another bounce. A changed base requires fresh review after rebase.

## Deferred work and limits

- https://github.com/markdlabrecque/orchestration/issues/60 records retention diagnostics and scale coverage. Full-document hard-link retention is indefinite, can grow quadratically with history, and increases hook/check scan cost. Add retained-byte/inode diagnostics and a bounded scale regression. Future pruning requires explicit legacy-writer quiescence, not file age.
- https://github.com/markdlabrecque/orchestration/issues/61 records a bounded two-process regression combining an old appender holding a SQLite write transaction with a new publisher waiting. Inspection found no existing cycle; current tests exercise inode races separately.

Main handles follow-up dispatch. Retention has no automatic pruning. The compatibility guarantee covers cooperating legacy appenders, not unrelated editors replacing or truncating files outside the locking protocols. An old writer's un-fsynced append can still be lost in a machine crash before repair observes it; observed tails are fsynced before publication. Hard-link failure refuses replacement rather than accepting loss.

## Merge gate and cleanup

The supplied GitHub API evidence reports zero hosted workflows. Main is unprotected and has no required contexts. Passing candidate tests are not the post-report exact-head gate: the orchestrator must run the exact-head local CI gate after this report commit. That gate is pending, and this report does not claim merge readiness or a completed merge.

Tests used disposable project roots and ORCH_HOME. The existing real `STATE.md` was untouched by the tests. Repair and review suites exited, fixture children were cleaned up, and the repair process-check artifact was empty. Scratch evidence remains for main to archive. This reporting step changes only `docs/56-report.md`; it does not mutate orch state, production code or tests, push, open a PR, or remove the worktree.
