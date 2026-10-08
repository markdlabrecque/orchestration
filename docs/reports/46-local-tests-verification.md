# Ticket 46: local-tests verification policy

## Scope

Added `verify_policy` to the existing project-root `.agents/orchestration/config.json` configuration. The only accepted values are `auto` and `local-tests`. If the key is absent, behavior defaults to `auto`, preserving DDEV-first, Docker-second detection and refusal when neither environment is available. Any supplied value outside the accepted strings, including `null`, booleans, empty strings and wrong-case strings, is rejected. Existing config loading and location precedence remain in effect; `.orch`, environment variables and prose do not opt in.

`local-tests` selects local automated tests even when DDEV or Docker is installed, and requires no container or container tool. The policy is retained in fresh spawn prompts and the stored ticket brief, including continuable resume and fresh recovery if config changes. Base-branch, platform, harness and merge gates remain in place. Legacy launch callers without a configured verification environment remain supported. Documentation and verifier instructions cover the setting and evidence-only review.

## Automated test evidence

- `PYTHONPATH=tests python3 -m unittest test_orch_verify_policy test_orch_verify_instructions -v`: 12 passed, 0 skipped.
- `python3 -m unittest discover -s tests -v` (1800-second timeout): 437 total, 422 passed, 15 skipped, completed successfully in 372.522 seconds. Ten preflight tests skipped because `/usr/bin/docker` was present and the tests could not control `PATH`; four platform tests skipped because `/usr/bin/herdr` was present; one Pi wrapper skipped because its global Pi installation detection failed. The Pi tests were run directly below.
- `node --test tests/pi/extension.test.mjs`: 10 passed, 0 skipped.
- `git diff --check`: passed with no output.

The initial focused test-writer run recorded expected failures in `.scratch/46-red.txt`; the implementation then passed the focused and full suites. No tests were weakened or removed. The Python suite emitted ResourceWarnings about unclosed SQLite connections, but completed successfully.

## Review and stage outcome

Independent reviewer approved candidate `669ff701194c08bb94fcd47efd613af567341f97` in one round with zero bounces. The reviewer found no must-fix issues and checked prompt propagation, config drift, strict invalid-value refusal, legacy missing-environment refusal, unchanged preflight gates and the evidence-only verifier branch.

The project carve-out moves local-tests tickets from review directly to report. The separate verifier, browser checks and accessibility checks were not run. This report makes no usability or accessibility verdict. No verifier errors were collected.

## Follow-ups and pending gates

The reviewer deferred low-severity hardening: `retained_verification_context` detects policy by matching the current instruction paragraph, so a later wording change could lose policy context when resuming older tickets. A stable policy marker independent of prose is recommended. Follow-up: https://github.com/markdlabrecque/orchestration/issues/51.

Exact-head CI is still pending. The work is not cleared for merge until CI passes for the exact candidate head.
