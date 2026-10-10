# Ticket 99 report: `orch ask` and `orch answer` for ticket questions

## Result

Added `orch ask <ticket> <question> [--timeout S] [--interval S] [--json]` and `orch answer <ticket> <question-id> <answer> [--json]` to `scripts/orch`. A question is recorded as a `question` event whose seq is its id. An answer is recorded as an `answer` event with detail `q<id>: <answer>`. Both events carry the ticket's current phase, so the phase chain stays continuous. `question` is a new wake kind in `wake_kind()`, so `orch wait` wakes the main orchestrator on it.

`ask` exits 0 with the answer, or 6 on timeout. The default timeout is 540 s, under Claude Code's 10 min limit. On Claude Code, Codex, and Pi it is a plain blocking CLI call. `ask` does not block the ticket. On exit 6 the session runs `orch block`. Re-running the same exact question reuses the latest matching question event and returns an answer given while the session was down. `ask` publishes STATE.md right after recording the question.

`answer` exit codes: unknown id 4, already answered or retired 3, empty answer 2.

Premise check: #98's `wait` had no question kind, and `wake_kind()` was the reserved place to add one. STATE.md and `orch events` already render all events, so no projection change was needed.

Docs updated: `skills/orchestration/SKILL.md` (step 6 handles `question`, new "Answer rules" section covering may answer / must escalate / recorded, brief template line on ask vs block), `skills/orchestration/references/orch-cli.md` (command rows, wake kinds, new "Asking the main orchestrator" section), `skills/orchestration/references/ticket-pipeline.md` (ask before stopping, exit 6 leads to block), and `README.md`.

## Tests

New file `tests/test_orch_ask.py` with 6 tests covering unknown commands and the missing wake kind. The tests were written red first and are now green. `tests/test_orch_wait.py` remains 6/6 green.

Full suite, macOS with Homebrew bash first on PATH:

- HEAD: 670 run, 3 failures.
- Base cc3a469: 664 run, 6 failures.
- The only difference is three flaky `test_orch_adapters` interrupt tests, which fail on base and pass on HEAD. No new failures.

## Verification

- Docker verification pass (accessibility off): no usability issues found. The verifier walked the ask, wait, answer, timeout, re-run, and error paths in two shells. No errors were produced by the feature.
- Full suite, Docker (Linux, root): 670 run, 2 failures and 1 error. All are environmental: the cleanup-install tests refuse to run as root, and `test_saved_workspace_survives_malformed_absence_after_checkout_gone` raises `KeyError`.
- Not tested: real agent sessions running `ask`.

## Review

One review round, verdict PASS, no must-fix items.

The review ended on approval in round 1, not at the 2-round cap.

## Follow-ups

None filed. The reviewer's nits were not fixed:

- The docs only imply that repeating an identical question returns the old answer. The guidance is to reword the question to ask again.
- No tests cover the retired, empty-answer, or negative-timeout refusals. The verifier exercised them by hand.
- The explicit `state_md_sync` after recording the question is redundant with the publish in `transaction()`.
- `orch events` text output shows no seq, so question ids are visible only in `wait`, in `--json`, and on ask's stderr.
- `answer` on a non-question event id reports only "no question N".

Review comment: https://github.com/markdlabrecque/orchestration/issues/99#issuecomment-6102424487

## Status

Changes are uncommitted in the worktree at `/Users/mark/Projects/orchestration/code/99`, per instruction. No tracker state was changed by this report.
