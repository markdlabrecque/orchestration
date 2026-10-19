# GitLab tracker

The shared Tracker interface now has GitHub and GitLab implementations. The
engine and role prompts receive the same ticket, identity, MR head, CI outcome
and merge result on either forge. No engine execution branches depend on GitLab.

Project discovery accepts HTTPS, HTTP, SSH URLs and SCP-style origins. It retains
nested namespaces and HTTP ports, and removes the Git transport's `.git` suffix.
Hosts named github.* or gitlab.* select their corresponding adapter. Other hosts
require `settings.forge: github` or `settings.forge: gitlab` in the effective
workflow. An explicit setting always wins. Both CLIs receive the selected host;
preflight checks only the selected forge CLI.

GitLab requests use `glab api` with JSON stdin and the URL-encoded project path.
Issue and MR identities use the project-local IID, while notes use their note ID.
Note links use the issue's returned URL plus `#note_<id>`.

Marker reconciliation lists all states and authors, in ascending creation order,
and reads pages of 100 until the final short page. It validates every entry,
rejects repeated IDs and duplicate marker matches, then either returns the
existing identity or creates the object. An unavailable or malformed response
throws; durable execution keeps the filing pending and pauses. A later resume
uses the saved marker. As in ADR 0010, this assumes one owner per run and complete
tracker listings. Markers cannot provide an atomic remote create operation.

Park adds the GitLab draft title prefix and updates the marked MR's description
with open findings. Closed or merged MRs cannot be parked. Abort posts a marked
note without closing the issue. Both actions reconcile on retry.

CI reads the MR's head pipeline, reads that pipeline's current status, then
rechecks the MR head and pipeline identity. Only success on the exact requested
source SHA passes. Failed/canceled pipelines fail; active or manual pipelines
remain pending. Missing, skipped, unknown or mismatched pipeline evidence cannot
authorize a merge. Pipelines testing a synthetic merged-results commit rather
than the source head do not satisfy this exact-SHA policy. Merge sends `sha` and
`squash: true`, propagates conflicts, and requires a confirmed merged response.
A retry recognizes an already-merged MR.

## Validation

Work started from integration/v2-phase-1 at
`17c1e0291c2eaccc28d5d2d4f159e02832cb37e0` in an isolated worktree.
Vertical red-green slices exercised the approved public tracker seam. The same
contract suite runs against stateful, network-free GitHub and GitLab command
fixtures. It covers reads, assignment, lost writes, pagination, ambiguous
listings, draft updates, aborts, CI head races and pinned squash merges.

Execution tests reopen SQLite after an interrupted follow-up filing, remain
paused through an unavailable lookup, and then complete with one creation and
one agent invocation. The CLI fixture runs GitLab through real local worktrees,
Pi and shell runners, publication, CI, merge and retirement, including a custom
host selected by project override. Existing GitHub fixtures remain enabled.

`pnpm check` passes type checking, Biome, 171 TypeScript tests, 412 bash
assertions and 15 Python tests. No tests were simplified, weakened or retired.
No live forge writes were used for validation.

## API references

Verified against primary documentation:

- [GitLab CLI API requests](https://docs.gitlab.com/cli/api/), including hostname selection and JSON stdin.
- [GitLab issues](https://docs.gitlab.com/api/issues/) and [notes](https://docs.gitlab.com/api/notes/), including assignment, IIDs and note creation.
- [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/) and [pipelines](https://docs.gitlab.com/api/pipelines/), including head pipeline SHA, squash merge and SHA mismatch errors.
- [GitLab draft titles](https://docs.gitlab.com/user/project/merge_requests/drafts/).
- [GitHub CLI API requests](https://cli.github.com/manual/gh_api), including explicit host selection and paginated JSON output.
