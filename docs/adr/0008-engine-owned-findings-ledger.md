---
status: accepted
date: 2026-10-18
---

# The engine owns the findings ledger; reviewers confirm fixes and people may defer

One Pi Durable document holds the findings ledger for a run, shared by review and verification. Each finding has a stable ID unique within that run and records the detecting step that raised it. The engine writes the document from step results; agents and runners never edit it directly. This keeps findings with the durable run across pauses and crashes, without making a worktree file or the tracker a second source of truth.

## Step contract

- A detecting step returns findings with a summary, evidence or location, and a classification of must-fix or follow-up. The engine assigns new IDs and preserves them across repair rounds.
- The repair brief includes the relevant open must-fix findings by ID. The repair result reports what changed for each finding, or a reason it disagrees; it cannot mark findings fixed, withdrawn or deferred.
- The re-check brief includes that detecting step's open findings, the repair report and the repair diff. The reviewer reports each finding by ID as fixed, still open or withdrawn, with its reason. A withdrawal means the reviewer accepts that the finding was mistaken; disagreement from the repair agent alone leaves it open.
- As settled in ADR 0006, anything newly noticed during a scoped re-check is a follow-up, never another bounce. Findings from other detecting steps are not cleared by this re-check.

## Follow-ups and human deferral

Every follow-up must have a linked tracker ticket before the run finishes. Until filing succeeds, it remains pending in the ledger. The ledger retains the link so subsequent steps can see where the work went.

An open must-fix blocks progress until the reviewer confirms it fixed, withdraws it, or a person explicitly defers it. Deferral requires both a recorded reason and a linked follow-up ticket; agents cannot defer findings themselves. A failed ticket creation leaves the must-fix open.

At the repair budget cap, the terminal offers grant another repair, defer selected findings, park, or abort. This extends ADR 0006's choices. Deferring some findings does not clear the remaining open must-fix findings, and deferral never bypasses the merge kind's exact-SHA CI gate or any other gate.

## Considered options

- A ledger file in the worktree. Rejected: findings belong to the durable run and need to survive worktree changes without agents managing their persistence.
- Letting the repair agent declare its own fixes complete. Rejected: the detecting reviewer must confirm the result, including whether a disputed finding should be withdrawn.

## Consequences

- Finding statuses are open, fixed, withdrawn or deferred. A disagreement is a repair response, not a status that clears a must-fix. Follow-up filing remains separately visible as pending or linked.
- The ledger retains the detecting step, finding details, repair responses, reviewer decisions, and any deferral reason and follow-up link. This supplies the scoped re-check and the open-findings list when parking a run.
- ADR 0010 settles tracker-operation ownership, immediate follow-up filing, and recovery after an interrupted filing.
- This document concerns findings only. Runner session handles and crash counts remain run state, not finding records.
