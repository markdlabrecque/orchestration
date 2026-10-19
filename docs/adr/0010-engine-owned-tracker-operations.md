---
status: accepted
date: 2026-10-18
---

# Code owns tracker operations and reconciles interrupted filings

Engine and step code read tickets, assign them, post comments and file follow-ups through a shared tracker interface. Agents supply structured content; they do not execute these tracker operations or establish success by reporting a link. Central ownership lets the engine recover interrupted writes and enforce the findings ledger's link requirements.

The first build slice implements these operations for GitHub. GitLab uses the same interface and remains in the phase 1 spec, with its implementation after the first slice.

## Filing and returned links

When a detecting step reports a follow-up, the engine saves the finding in the durable ledger first, files its tracker ticket immediately, then saves the returned ticket identity and URL in the ledger before continuing. The tracker interface returns those values to the engine. Filing failure pauses progress; resuming the run retries the pending filing. A missing link never counts as completion.

A person's deferral requires a reason and a linked tracker ticket before the engine clears the must-fix, as settled in ADR 0008. If creation fails, the must-fix remains open.

## Recovery after an interrupted write

Each ticket or comment filing carries a stable hidden marker identifying the operation. The engine durably records that identity before attempting the write and reuses it across retries. A follow-up's identity stays tied to its run and finding; a comment's identity stays tied to its logical posting operation.

On recovery, the engine checks the tracker for the marker before creating anything again. If a matching ticket or comment exists, it reuses that result and saves its identity and URL. It retries creation only when it can establish that the earlier attempt did not create the object. If the tracker cannot confirm the outcome, progress stays paused rather than risking a duplicate. A hidden marker supports reconciliation; it does not itself make the remote create operation atomic or guarantee exactly-once delivery.

## Considered option

Letting each agent invoke tracker commands and report what it did would spread recovery logic across prompts and runners. Keeping writes in code gives the engine one place to reconcile outcomes and retain authoritative links.

Decision: [Tracker operations and reliable follow-up filing](https://github.com/markdlabrecque/orchestration/issues/138).
