# Ticket 98 report: `orch wait` for event-driven ticket monitoring

## Result

Added `orch wait [--since SEQ] [--timeout S] [--interval S] [--json]` to `scripts/orch`. It wakes on `blocked`, `done`, `idle`, `dead`, and `stalled` events for non-retired tickets, prints the events and a watermark, and exits 0 on events or 6 (new `EXIT_TIMEOUT`) on timeout. The default timeout is 540 s. `wait` records derived health (`idle`/`dead`/`stalled`) as `health` events, deduplicated per ticket since the last spawn, resume, attach, or unblock; the compare and insert run under `BEGIN IMMEDIATE`. Without `--since`, the baseline is taken atomically with health recording. The wake mapping lives in `wake_kind()` so #99 can add `question`.

Docs updated: `skills/orchestration/SKILL.md` step 6 (background `orch wait`, slow `orch list` fallback, Claude Code/Codex/Pi), `skills/orchestration/references/orch-cli.md` ("Waiting for events"), `skills/orchestration/references/platforms.md` (`watch` is for people, `wait` is for agents), and `README.md`.

## Tests

New file `tests/test_orch_wait.py` with 6 tests: wake on block, merged-to-done, timeout exit 6, watermark no-loss/no-repeat, dead session wakes once, and concurrent waits each see the block once. The tests were written red first (unknown command). Three tests were adjusted during implementation to take their start watermark via `orch wait --timeout 0.2`.

## Verification

- `tests/test_orch_wait.py`: 3/3 passing in repeated local runs; passing in Docker.
- Full suite, Docker (Linux, root): 664 run, 2 failures and 1 error. All are environmental or pre-existing: the cleanup-install tests refuse to run as root, and `test_saved_workspace_survives_malformed_absence_after_checkout_gone` raises `KeyError: 'workspace'`.
- Full suite, macOS session: pre-existing failures from bash 3.2 `mapfile` and the `/private/var` symlink. These are identical on unmodified HEAD and are tracked in #100.
- Docker verification pass: no usability issues found. One nit, not fixed: `orch wait`'s flags have no `--help` text. This is consistent with `watch`. No errors were produced by `orch wait`.

## Review

Two review rounds, one bounce.

- Round 1 must-fix: a race between health recording and the baseline read when `--since` was omitted. Fixed by making the baseline and health recording atomic. Also added `unblock` to the dedup reset, and de-flaked the merged-to-done test.
- Round 2: APPROVE.

The review ended on approval in round 2, not at the 2-round cap.

## Follow-ups

- #100: pre-existing macOS test failures (bash 3.2 `mapfile`, `/private/var` symlink).
- Manual QA outstanding: idle and stalled health wake-ups have not been exercised by hand on a live Herdr/Orca session. The dead-session wake is covered by tests.
- Nit (not filed, deliberately deferred): `orch wait` flags lack `--help` text, matching `watch`.

Review comment: https://github.com/markdlabrecque/orchestration/issues/98#issuecomment-6101833761

## Status

Changes are uncommitted in the worktree at `/Users/mark/Projects/orchestration/code/98`, per instruction. No tracker state was changed by this report.
