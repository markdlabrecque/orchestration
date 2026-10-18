---
status: accepted
date: 2026-10-18
---

# Repair loops are budgeted edges, a person decides at the cap, and the re-check is scoped to the repair

A loop in a workflow is one line on the detecting step, `on: { findings: { repair: fix, budget: bounces } }`: run the named repair, spend one slot of the named budget, then run the detecting step again. A repair is one step or an ordered list of steps, declared once under `repairs:`. The shipped budgets are v1's, `bounces: 3` shared by every detecting step and `ci_repairs: 2`, and a project may raise them by name. When a budget is spent the engine asks the person at the terminal: grant one more slot, park the ticket as a draft PR listing the open findings, or abort; grants are unlimited and recorded in the run's events, and nothing about them lives in the file. The re-run of the detecting step after a repair is scoped to the findings it raised and the code the repair changed; anything new it notices becomes a follow-up, never a bounce. The `merge` kind refuses without CI green on the exact head SHA, in code, so no project can relax that gate; the tests gates live in the file and a project may change them.

## Considered options

- v1's triage file and block at the cap, with a two-exception limit. Rejected: phase 1 has a person at the terminal, so the engine can ask instead of writing a file; the person is the limit on grants.
- A full fresh review after every repair. Rejected: each pass finds something new in the original change and burns the budget on drift rather than on the findings that bounced it.
- Per-step budgets. Rejected for the default: one shared count keeps the cost of a ticket bounded however many checks a project inserts; a project that wants more raises the number.

## Consequences

- A slot is spent when the repair edge is taken, not when the detecting step runs.
- A repair whose own gate fails spends another slot and runs again with a fresh agent until the budget is spent; a crash counts toward the engine's three-crash limit instead.
- An outcome with no `on:` mapping blocks the ticket, so loops fail closed.
- The brief for a scoped re-check carries the open findings and the repair's diff; the findings ledger that makes this possible is its own decision.
