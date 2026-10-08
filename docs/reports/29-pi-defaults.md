# Ticket 29: Pi default providers

## What changed

Switched all four default Pi tiers in `scripts/orch/pi/extension.ts` from `openai-codex` to `openai`, preserving model IDs. Explicit `pi_models` overrides, aliases, Codex behavior, and effort routing remain intact. Python CLI routing defaults were kept aligned, with README and routing documentation updated. Regression tests were written red-first. No duplicate fixture changes were needed after rebasing on ticket 9 PR 30 merge `6eb21a44b3eda64742c3778bdecb6a968fece27b`.

## Test evidence

- `python3 -m unittest discover -s tests -v`: 338 tests passed; 15 existing skips.
- `node --test`: 10 passed, 0 failed.
- Independent reviewer reran both suites and approved in round 1 with no findings.

## Review and follow-ups

Separate verifier, browser, and accessibility checks were waived by project instructions. No verifier errors were reported. No manual QA was performed and no follow-ups were deferred. CI and merge remain pending; this report does not claim either completed.
