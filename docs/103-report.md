# Ticket 103 report: Docker verify harness, and the "flaky" saved-workspace test

## Result

The "flaky" test was not timing. `test_retirement_safety.test_saved_workspace_survives_malformed_absence_after_checkout_gone` fails with `KeyError: 'workspace'` every time `jq` is absent from PATH. Reproduced with a PATH of only python3, git, bash, and coreutils: it fails at line 80. The original Docker full run had no jq. The 3/3 isolated passes came after jq was installed.

Code defect: `skills/retire-worktree/scripts/retire-worktree.sh` step 3 piped its workspace discovery into `jq ... 2>/dev/null | sed -n 1p`, for both the worktree-list and workspace-list lookups. A jq failure produced empty output, which the engine read as "no Herdr workspace found". It then removed the checkout without recording or closing the Herdr workspace, leaving an open workspace with no saved obligation.

Fix: both lookups now exit 4 with "jq failed ... repair jq and retry" before any teardown. A jq run that matches nothing still means no workspace, as before.

New tracked harness:

- `docker/Dockerfile`: `python:3.12-slim`, installs git, procps, and jq. Runs as non-root user `verifier` (uid 1000). Sets `safe.directory '*'`.
- `docker/verify.yml`: service `verify`, builds the Dockerfile, `init: true`, mounts `..:/work` relative to the compose file, runs `sleep infinity`. The stale `test_walk_finds_native_versions_binary` comment is dropped (fixed by #9).

New `verify_harness` value for `.agents/orchestration/config.json`, applied by the main orchestrator after merge: `docker compose -f docker/verify.yml up -d --build`, run from the ticket worktree. `config.json` and `.agents/orchestration/verify.yml` were not edited.

Note: uid 1000 works on Docker Desktop (macOS). On a Linux host whose repo owner is not uid 1000, bind-mount writes would fail.

## Tests

New test: `tests/test_retirement_safety.py::test_broken_jq_fails_closed_before_teardown`. Before the fix it failed: the engine reached the MANUAL branch with the checkout already removed. After the fix it passes.

macOS, full suite (`python3 -m unittest discover`): 674 tests, OK, skipped=1. Run twice (implementor and orchestrator rerun).

macOS, `retire-worktree.test.sh`: 143/143.

Docker, full suite, four runs (three implementor, one verifier): each 674 tests, OK, skipped=2. The skips are `test_pi_extension` (needs node/Pi) and `test_orch_harness` docker (docker not on PATH). No root-related skips. uid 1000, jq 1.7.

Docker, `test_cleanup_install`: 2/2 OK, not skipped.

Docker, `retire-worktree.test.sh`: 143/143.

Docker, `reap-worktrees.test.sh`: 55/55.

Routing note: test-writer and implementor runs resolved effort to medium against a requested low. The model matched (claude-sonnet-5-5).

## Verification

Docker verifier: PASS. Verifier errors: none. Comment: https://github.com/markdlabrecque/orchestration/issues/103#issuecomment-6105408854

## Review

One review round. Engine, test, and Docker changes were judged correct.

The bounce was for three `test_orch_adapters` selftest interrupt failures in a full macOS run under concurrent load. The diff does not touch that file, and the test passes when run alone. An idle full rerun gave 674 OK, which resolved it.

The review ended on approval in round 1, not at the 2-round cap.

## Follow-ups

- [#105](https://github.com/markdlabrecque/orchestration/issues/105): filed from review. Link: https://github.com/markdlabrecque/orchestration/issues/105

## Status

Work is on branch `103` in the worktree at `/Users/mark/Projects/orchestration/code/103`. This report is uncommitted, per instruction. No tracker state was changed by this report.
