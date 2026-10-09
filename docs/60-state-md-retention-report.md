# STATE.md retention diagnostics: ticket 60

## Delivered

Added the read-only `orch state-md diagnostics --json` command and text output, with operational guidance in `README.md` and `skills/orchestration/references/orch-cli.md`. It reports retained inode count, total logical bytes across retained inodes, and scanned-tail bytes (bytes beyond the retained pre-replacement length that the existing freshness collector would read). A link to the current inode is included in count and full logical bytes, but contributes no scanned-tail bytes: it is preparation, not legacy data. Diagnostics validates and stats retention metadata without reading full historical documents, repairing stale STATE.md, or mutating workflow records/state. Missing or malformed/truncated retention remains diagnostic input, not a repair request. Existing check/rebuild behavior is unchanged.

Retention grows with each changed publication; unchanged rebuilds retain nothing new. Work is per retained name plus relevant tail scans. Same-filesystem locking/rename assumptions apply. Backups must preserve inode identity and links. Cleanup/pruning is not implemented; any manual cleanup still requires explicit evidence that legacy writers are quiescent. Branch and manual-cleanup obligations are unchanged.

## Scale evidence

The bounded isolated growing-history run was measured under `.scratch` (test output):

```text
python3 -m unittest discover -s tests -p test_orch_state_md_diagnostics.py -v
STATE_MD_SCALE {"document_bytes":26156,"publication_count":16,"retained_inode_count":16,"retained_bytes":202240,"scanned_tail_bytes":0,"unchanged_rebuild_count":3,"wall_seconds":1.201891}
```

This is real measured evidence; wall time covers publication and unchanged check/rebuild work, not diagnostics, and is not a threshold or diagnostic field. The same scale measurements were emitted on full-suite runs (about 1.20 seconds).

## Test and review evidence

- `python3 -m unittest discover -s tests -v` — 654 tests ran, including 15 skipped, with zero failures; successful full run recorded at 810.073 seconds.
- `bash skills/create-worktree/tests/run-all.sh` — 412 passed, 0 failed, 0 skipped (subsuite counts: 184, 143, 55, 30).
- `env -u ORCH_HOME -u PI_SUBAGENT_CHILD -u ORCH_PI_PARENT_SESSION node --test tests/pi/extension.test.mjs` — 10 passed, 0 failed, 0 skipped.
- `git diff --check` — exit 0.

An invalid test assertion expected raw UTF-8 `café` in the rendered projection, whereas the existing JSON projection correctly escapes it. The assertion was corrected to preserve the projection contract and round-trip the complete UTF-8 tail, including newline; the tests retain the raw-byte preservation checks. Earlier runs that failed on this assertion are superseded by the passing rerun. One initial reviewer Python invocation used an insufficient 200-second timeout; the later full run completed successfully. These were assertion/infrastructure invocation issues, not product defects.

Independent review: **APPROVED**, round 1, bounces 0; no must-fix findings. Reviewer independently reran the required suites successfully. No follow-ups were deferred. No separate verifier, browser, accessibility, or manual QA was required by the project lane; no verifier errors were reported.

## Integration status

The initial gates and review ran atop `17ce044`. The candidate has since been successfully rebased onto `origin/main` at `ccd735a`. Integration gates and a fresh independent review on the rebased candidate are still required before publication. Final CI and merge are **not** claimed here.
