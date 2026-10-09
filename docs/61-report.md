# Ticket 61 report: combined legacy STATE.md and SQLite lock ordering

## Result

Added 107 lines of regression coverage in `tests/test_orch_state_md.py`; no production changes. The test coordinates overlapping legacy SQLite/inode locks and publisher contention, checks current managed revision and legacy append preservation, and bounds child execution with kill/reap cleanup. A disposable mutation restoring transaction-held publication locking produced the expected bounded failure; both children were killed and reaped, and production files were unchanged.

## Verification

Integrated candidate `4c85006` on `main` `17ce044`:

- `python3 -m unittest discover -s tests -v` — 646 tests passed, 15 skipped, 803.920s.
- `node --test tests/pi/extension.test.mjs` — 10 passed.
- `git diff --check` — passed.

The final integrated Python run supersedes earlier runs: an initial supervisor attempt failed child-liveness checks because adopted zombies were not reaped; continuous reaping corrected this and the rerun passed. Separate invocation failures were recorded: an implementor encountered a preexisting file lock; an initial reviewer invocation violated the one-bash-call policy; a follow-up implementor invocation timed out after completing its rerun. These did not conceal or replace the final evidence.

## Review and remaining gates

Independent review approved after one advisory-comment repair bounce; two review entries, zero CI repairs, no deferred follow-ups. The repaired wording avoids claiming the blocking flock syscall itself began before legacy release. No manual QA or verifier errors. Local-tests verification intentionally skips separate browser, accessibility, and verifier stages; none were required by this project.

No hosted workflows are configured and the branch is unprotected. Exact-head local gates are therefore required after the report commit. No tracker or orchestration-state changes were made.
