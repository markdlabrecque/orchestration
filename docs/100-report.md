# Ticket 100 report: macOS bash 3.2 compatibility for the engines

## Result

The retire engine no longer needs bash 4. `skills/retire-worktree/scripts/retire-worktree.sh` had two bash-4 constructs:

- `mapfile -t identity_lines` is replaced by four `IFS= read -r` reads (worktree, branch, stage, optional saved_workspace).
- `"${flags[@]}"` on an empty array under `set -u` is replaced by `${flags[@]+"${flags[@]}"}`. Bash older than 4.4 reports "unbound variable" on the non `--force` path.

The engines run through `#!/usr/bin/env bash`. `orch retire` and `orch reconcile` (`engine_command`/`run_engine` in `scripts/orch`) therefore use whatever bash is first on PATH. On stock macOS that is `/bin/bash` 3.2. The fix is at the root, not a wrapper that searches for bash 4.

An audit of `reap-worktrees.sh`, `setup-worktree.sh`, `setup-project.sh`, and `scripts/orch-project.sh` found no other bash-4 constructs. The reap array is guarded by an empty check. `setup-worktree.sh` already used the safe idiom.

Test-side changes:

- `tests/test_orch_engine_deadline.py` realpaths both sides of the comparison, because macOS maps `/var` to `/private/var`.
- `tests/testenv.py` adds a shared `clean_env()` and `HARNESS_MARKERS`. They scrub `ORCH_`, `ORCA_`, `HERDR_`, `CLAUDE_CODE_ENTRYPOINT`, and harness markers. `tests/test_orch.py` uses it with unchanged behaviour. `tests/test_setup_project.py` now uses it too. It previously scrubbed only `ORCH_` and `GIT_`.

## Tests

New files:

- `tests/test_bash32_compat.py` is a static guard. It fails if the engine scripts contain `mapfile` or `readarray`. It also acts as a backstop on Linux, where `/bin/bash` is 5.
- `tests/test_env_scrub.py` injects `HERDR_`, `ORCA_`, and `CLAUDE` variables. It asserts that both suites' `setUp` drop them.

The behaviour guard on macOS is the existing `RealEnginesTests` and `SelftestTests`. They run the real engines with `PATH=/usr/bin:/bin`, which is bash 3.2.

Full suite, macOS, `/bin/bash` 3.2.57 first on PATH:

- Base a21456e: 670 tests, 168 failures and 4 errors. All are `mapfile` failures except one path mismatch.
- HEAD: 673 tests, OK, 1 skipped. Confirmed by two independent full runs.

Shell suites under `/bin/bash` 3.2:

- `retire-worktree.test.sh`: 143/143.
- `reap-worktrees.test.sh`: 55/55.
- `setup-project`: 30/30.
- `create-worktree` `run-all`: green.

Shell suites under Homebrew bash 5.3:

- `retire-worktree.test.sh`: 143.
- `reap-worktrees.test.sh`: 55.
- Touched modules: OK.

## Verification

Docker verification (`python:3.12-slim`, accessibility off): PASS. Comment: https://github.com/markdlabrecque/orchestration/issues/100#issuecomment-6103778522

Full suite, Docker (Linux, root): 673 tests, 2 failures and 1 error. All three are pre-existing on base.

- Two `test_cleanup_install` tests refuse to run as root.
- `test_retirement_safety.test_saved_workspace_survives_malformed_absence_after_checkout_gone` raised `KeyError: 'workspace'` once. It passed 3/3 in isolation on both base and HEAD. It is flaky.

`retire-worktree.test.sh` needed `jq` installed in the container. Without it, 29 tests failed with `jq: command not found`. With it, the result is 136 passed and 5 skipped. `reap-worktrees.test.sh` is 55/55.

Not tested: a real `orch retire` of a live ticket on a stock Mac. The real-engine tests cover that path, but nobody ran it by hand.

## Review

One review round, verdict PASS, no must-fix items.

The review ended on approval in round 1, not at the 2-round cap.

## Follow-ups

- #103: harness issues seen in Docker. The root-refusing cleanup-install tests, the flaky `test_saved_workspace_survives_malformed_absence_after_checkout_gone`, and the `jq` dependency of `retire-worktree.test.sh`. Link: https://github.com/markdlabrecque/orchestration/issues/103
- Nice-to-have, not done: broaden the static grep in `test_bash32_compat.py` to cover other bash-4 constructs.
- Manual QA outstanding: a real `orch retire` of a live ticket on a stock Mac.
- Not in scope: the PreToolUse hook that blocks `git worktree remove` in the main orchestrator.

## Status

Work is on branch `100` in the worktree at `/Users/mark/Projects/orchestration/code/100`. This report is uncommitted, per instruction. No tracker state was changed by this report.
