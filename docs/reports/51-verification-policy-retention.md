# #51: Retain verification policy across recovery

## What changed

`scripts/orch` now records configured local-tests policy in a stable `<!-- orch:verify-policy=local-tests -->` marker, independently of mutable `LOCAL_TESTS_CONTEXT` prose. Continuable recovery reads the marker and supplies current instructions; fresh recovery preserves the stored brief and marker. For pre-marker briefs, narrowly recognize the exact historical #46 paragraph when it is the whole brief or final appended paragraph. Incidental discussion and partial mentions do not trigger local-tests. No schema/config rewrite; validation and exact-SHA merge gates remain intact.

Black-box tests cover current and pre-marker briefs, changed instructions, continuable and fresh recovery, config drift, and explicit/implicit auto negatives. The historical fixture is independently frozen from #46.

## Test evidence

- `python3 -m unittest discover -s tests -v` (1800-second timeout): 445 tests total, 430 passed, 15 skipped; `OK (skipped=15)`. The skips are environment-dependent (10 Docker/PATH, 4 Herdr/PATH, and 1 standalone Node/Pi-install test); see `.scratch/51-implement.md` for reasons.
- `python3 -m unittest discover -s tests -p 'test_orch_verify_*.py' -v` (1800-second timeout): 20 passed, no skips.
- `env -u ORCH_HOME -u PI_SUBAGENT_CHILD -u ORCH_PI_PARENT_SESSION node --test tests/pi/extension.test.mjs`: 10 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

## Review and verification status

Independent review approved after one round with zero bounces and no findings or follow-ups. Initial reviewer infrastructure dispatch failed; review was rerouted and approved. The reviewer first tried `npm test`, which failed because `package.json` has no test script, then ran the actual Python suite successfully and inspected the Node test evidence.

Separate verifier/browser/accessibility checks were waived under the project `AGENTS.md` carve-out; no verifier errors were collected. Final rebase, exact-head tests, and remote checks remain pending with the orchestrator. They have not passed yet.

No follow-ups were deferred by the reviewer.
