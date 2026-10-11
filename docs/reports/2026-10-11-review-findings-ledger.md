# Ticket 107 report: Track review findings with stable ids across rounds

Issue: https://github.com/markdlabrecque/orchestration/issues/107

## Result

Review findings now have stable ids that persist across review rounds. The `orch` state DB has a findings table and a migration that adds it to existing databases. Three new commands manage findings: `orch finding add`, `orch finding raise`, and `orch finding set`. Each change records a `finding` event. `orch show` reports findings in text and `--json`, including `rounds_open` for each finding. STATE.md has an "Open must-fix findings" section.

Docs were updated in `agents/reviewer.md`, `skills/orchestration/references/ticket-pipeline.md` (new "Review findings ledger" section), and `skills/orchestration/references/orch-cli.md`.

Reviewer status values are `open` or `fixed`. `disputed` and `deferred` are set only by the orchestrator.

Changes are uncommitted in the worktree at `/Users/mark/Projects/orchestration/code/107`, per instruction.

## Tests

New file `tests/test_orch_findings.py` with 5 tests:

- add
- raise, `rounds_open`, and reopen
- STATE.md section
- refusals
- migration of an old DB

The migration test was confirmed to fail when the old trigger guard is in place.

Full suite: 679 tests OK, 1 skipped. The fix implementor ran it in foreground chunks. The round-2 reviewer ran it as one background run. That background run showed 3 SIGINT failures in `test_orch_adapters.py`. These are background-job artifacts. That file passes 98/98 in the foreground.

Not exercised: the new commands were not run against the real orch state DB. The code is unmerged. The migration is additive.

## Review

- Round 1: APPROVED, no must-fix, 5 follow-ups.
- Fix round (1 bounce): addressed F1 (migration test), F3 (reviewer status values `open|fixed`; `disputed` and `deferred` are orchestrator-only), and the docs section placement.
- Round 2: APPROVED WITH FOLLOW-UPS. This hit the 2-round review cap.

The work could use more review passes. Round 2 approved with follow-ups, and the cap stopped further review.

### Declined follow-ups

These were declined as low-value tests under the user's testing policy. They were not filed.

- F2: test base class is `RoutingTestCase`, not `OrchTestCase`.
- F4: the plain-text `show` block is untested.
- F5: the empty-summary and `PI_SUBAGENT_CHILD` refusals are untested.

## Verification

Docker harness: no usability issues, 3 nits, no errors. Report: https://github.com/markdlabrecque/orchestration/issues/107#issuecomment-6113927902

The 3 nits are display nits and were filed as [#111](https://github.com/markdlabrecque/orchestration/issues/111).

## Follow-ups

- [#111](https://github.com/markdlabrecque/orchestration/issues/111): display nits from the Docker verify pass.
- Declined, not filed: F2, F4, F5 (listed above).

## Status

No tracker state was changed by this report. Nothing was committed.
