# Repairs and findings

A detecting step's unsuccessful outcome takes its named repair edge. The
engine commits the edge, then atomically spends its named budget and enters
the ordered repair body. The workflow index stays on the detecting step.
Successful repair steps advance a separate cursor. The final repair step
returns to a scoped recheck.

Review and verify share the shipped bounces budget. CI uses ci_repairs.
A repair outcome or gate failure starts another attempt and spends another
slot. A process crash resumes the same attempt and cursor without another
spend. Pi resumes its owned conversation; shell reruns on the existing dirty
worktree. Repair attempts use fresh conversations and static configured tiers,
including when a repair step names a session.

The engine snapshots the worktree through a temporary Git index, preserving
the user's index. The recheck receives the diff from the start of the repair,
including unsuccessful gate attempts, and the detecting step's open finding
IDs and repair responses. Snapshots include tracked and untracked files,
respecting Git ignores. Git trees must remain available while the run is active;
do not prune unreachable objects during a repair.

## Durable records and role results

The session-scoped Pi Durable document orch.findings is the authoritative
ledger. RunState.findings is a returned projection, never a worktree file or
second database. Stable run-local IDs are F1, F2 and so on. Findings record
their detecting step, evidence, classification, status, repair responses,
review decisions and any filing marker, linked identity or human reason.

Normal reviewer/verifier results contain findings. Every role may also return
optional followUps entries with summary and evidence. Repairs return responses,
exactly one {id, action, reason} per supplied open ID. action is changed or
disagreed. Rechecks return decisions, exactly one {id, status, reason} per
supplied open ID. status is fixed, open or withdrawn. Both schemas reject
unknown fields, foreign IDs, missing IDs and duplicates. Only the detecting
step can confirm or withdraw its findings. Repair agents cannot clear them.

A validated agent result and its ledger changes are committed together before
filing. Recovery uses that saved result rather than rerunning the agent and
creating new IDs. New discoveries in a recheck are follow-ups even if the model
calls them must-fix. They do not spend another bounce.

## Filing and human decisions

Every follow-up is saved as pending with a stable hidden marker before the
tracker write. The adapter searches all pages for that marker, reuses a unique
match, and creates only after establishing absence. Malformed listings,
duplicate matches and uncertain responses throw. The engine pauses and retains
the pending operation. Resume reconciles the same marker before any later step.
A returned tracker identity and URL are committed before progress continues.

At a spent budget the terminal offers grant, defer, park and abort. Grant adds
one durable slot and emits a status event; grants have no fixed limit. Defer
asks for comma-separated finding IDs and a nonempty reason. Each finding stays
open until its follow-up is successfully linked. Partial deferral leaves the
remaining findings at the cap. Full deferral runs a fresh scoped recheck and
still enforces gates.

Park durably records the decision, publishes the worktree, and creates or
updates the run's marked PR as a draft listing open must-fix findings. Abort
records the decision and posts a reconciled abort marker comment on the ticket.
Neither action closes the ticket, merges, or retires the worktree. Parked and
aborted runs remain terminal when reopened. Uncertain tracker writes pause
with the durable decision retained.

The shared Tracker contract exposes these operations without forge-specific
result fields. The GitLab adapter must implement the same marker reconciliation,
draft update, abort marking and exact-SHA merge guarantees.

## CI repair

The shipped CI repair runs the implementor, tests for the standard lane, and an
mr step. mr commits, rebases and pushes through Project.publish before the next
CI poll. Publishing clears prior CI evidence and starts a new CI deadline.
A CI repair must publish its final worktree through mr; further edits require
another mr step. The engine refuses a recheck if the final tree differs from
the published tree. Merge still checks and pins the exact CI-passed SHA.

## Validation

Tests exercise workflow, execution, real Pi/shell runner and tracker contracts.
Separate processes receive SIGKILL during Pi repair, shell repair and after a
simulated successful remote filing. Each reopens real SQLite storage, retaining
edits and spending the budget once; interrupted filing performs one creation.

No tests were retired or weakened. The earlier interrupted-comment test now
expects paused rather than blocked because unknown remote outcomes are
recoverable pauses. Existing fixtures implement the added tracker abort method.
Automated tests use local Git repositories and fake provider/forge boundaries;
no live remote writes or production access are part of validation.

Crash-count controls and operator status/event projections remain the terminal
controls ticket's responsibility. This change persists repair progress and
accounting independently of those controls.

Final validation: pnpm check passed type checking, Biome, 123 TypeScript tests,
412 retained bash assertions and 15 Python tests. The local integration tip was
merged before handoff and remained at 4950173.
