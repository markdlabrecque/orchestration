# Phase 1 build tickets

Each ticket links to the [spec](spec.md) and its controlling ADRs. Dependencies below are recorded as native tracker blocking relationships. These are implementation tickets, not child decision tickets on the wayfinder map.

## 1. [Run one GitHub ticket end to end on Pi Durable](https://github.com/markdlabrecque/orchestration/issues/139)

Deliver a retained vertical slice, not a scaffold. On `v2`, remove the obsolete v1 runtime and packaging while keeping worktree/project engines and bash tests. Establish the single TypeScript package and CI from ADR 0007. Implement one fixed workflow from a data file, pickup, a Pi agent step, a shell agent step, typed handoffs, GitHub PR creation, exact-head CI checking, pinned squash merge and retirement. Use the shared runner and tracker interfaces so later tickets extend this code.

Acceptance:
- A fixture ticket traverses CLI, workflow, durable engine, both runners, worktree, tracker, CI and retirement.
- Fake models/forge/commands make the automated fixture deterministic and network-free; real adapters are callable outside the fixture.
- Pause/resume does not replay completed steps; shell restart preserves the dirty worktree.
- A changed head cannot merge on stale CI. Tracker comment/PR recovery reconciles interrupted writes before retrying.
- Type check, Biome, vitest and retained bash suites pass in CI on `v2`.

Depends on: none. Source: ADRs 0001, 0002, 0003, 0005, 0007, 0010.

## 2. [Resolve global workflows and project patches](https://github.com/markdlabrecque/orchestration/issues/140)

Expand the slice's loader into the complete two-layer format, registration, conditions and strict preflight. Implement all ordered patch operations, by-name configuration merges, settings references and explicit custom kind/runner loading. Validate before pickup.

Acceptance:
- Global-only and project-patched fixtures produce the expected ordered workflow.
- Missing IDs/settings, duplicate registrations, invalid outcomes and dangling repair/budget/session references produce located errors with no execution.
- Relative module paths resolve from their declaring file; patches do not silently retain removed settings.
- `orch validate` checks only relevant tools and accepts a configured plain project with no override.
- Tests exercise custom kinds and custom runners through their public interfaces.

Depends on: 1. Source: ADRs 0003, 0004, 0005.

## 3. [Ship the role workflow, gates and model routing](https://github.com/markdlabrecque/orchestration/issues/141)

Replace the slice workflow with spec/tests/implement/review/verify/report/mr/ci/human/merge. Adapt retained prompts to engine-owned state and tracker writes. Define and validate typed role results. Implement lanes, test gates, verification options, human choices, static tier/effort assignments and spec-selected implementation tier. Complete runner sessions, permission validation, cancellation, timeout and missing-result behavior.

Acceptance:
- Standard, trivial and no-code fixtures run the intended steps and gates, including forced lane labels.
- Only spec can select the lane or implementation tier; invalid selections block.
- Swapping an agent step between Pi and shell preserves its contract.
- Wrongly failing tests cannot satisfy the red gate; failed tests cannot satisfy green.
- Human pause/resume asks again; timeouts/cancellation stop the conversation or process group.
- A lost session handle fails clearly, without silently starting fresh.
- Both runners resolve tiers through `settings.model-family`: `claude` (`pi-claude-subscription`) by default, `openai` when a project patch sets it. The shipped shell command runs `pi -p` and receives `ORCH_MODEL_PROVIDER`, `ORCH_MODEL` and `ORCH_MODEL_EFFORT`. Preflight rejects a family that a used runner does not declare, or that lacks a tier, and `ranOn` records the provider and model that ran.

Depends on: 2. Source: ADRs 0003, 0005, 0009, 0011.

## 4. [Add repair budgets and the findings ledger](https://github.com/markdlabrecque/orchestration/issues/142)

Implement named repair edges and ordered repair bodies with durable budget accounting. Add the engine-owned findings document, scoped rechecks, immediate follow-up filing, reviewer confirmation and human deferral. At the cap support grant, defer, park and abort.

Acceptance:
- Review and verify share three bounce slots; CI repairs use their separate two slots.
- A repair gate failure spends another slot; a crash does not consume a repair slot merely by restarting.
- Repair agents cannot clear findings, and one reviewer cannot clear another's findings.
- New discoveries in scoped rechecks file follow-ups immediately and never create another bounce.
- Interrupted filing reuses the stable marker; uncertain tracker responses pause without creating duplicates.
- Failed deferral filing leaves the must-fix open; partial deferral does not unblock remaining findings.
- CI repair commits/pushes before rechecking the new SHA; stale CI never authorizes merge.
- Park creates or updates a draft PR listing open findings and ends the run without retirement as if merged.

Depends on: 3. Source: ADRs 0006, 0008, 0010.

## 5. [Support GitLab through the tracker interface](https://github.com/markdlabrecque/orchestration/issues/143)

Implement GitLab ticket reads, assignment, comments, follow-up creation, marker reconciliation, MR operations and CI/merge behavior behind the existing interface. Honor forge detection and explicit override.

Acceptance:
- The same adapter contract suite runs against GitHub and GitLab fakes.
- Pagination and ambiguous remote outcomes cannot cause duplicate follow-ups/comments.
- GitLab merges are pinned to the CI-passed SHA and conflicts remain visible.
- Forge-specific response details do not escape into role prompts or engine branching.

Depends on: 4. Source: ADRs 0005, 0010.

## 6. [Finish terminal controls and read-only observability](https://github.com/markdlabrecque/orchestration/issues/144)

Complete show/tail, abort/retire, crash-limit retry and terminal reporting. Define versioned status/event schemas and preserve history outside worktrees. Use atomic status replacement and tolerate an incomplete trailing JSONL record in readers. These file-writing details support reliable readers without introducing another authoritative run store.

Acceptance:
- Watching a live run never opens its SQLite file.
- Status and events explain current step, outcomes, pauses, blockers, grants and resumption counts.
- Three crashes block; explicit retry permits another attempt. Clean pause is distinguishable from crash recovery.
- Abort occurs after pause; completed/aborted runs print final state without restarting.
- Retirement failure preserves enough state for retry; history survives retirement.
- Full transcripts stay in events while terminal output remains concise.

Depends on: 4. Source: ADR 0002 and its resolution comment.

## 7. [Explain workflows and install from a stable checkout](https://github.com/markdlabrecque/orchestration/issues/145)

Deliver HTML/text explain, workflow diff/reset, stable-checkout installation and updates, version reporting and usage documentation. Add this repository's project override requiring its CI before merge.

Acceptance:
- Explain shows global/effective workflows, patch effects, lanes, settings, runners and unused repairs; run saves the same explanation without opening a browser.
- Reset refuses edited globals without force and preserves a backup; installation preserves an existing global.
- Install refuses ticket worktrees and links the CLI/update command from a stable checkout.
- Documentation covers one terminal per ticket, runner configuration, required project test commands, pause/abort and recovery limitations.
- Run the full fixture workflow and required CI suites using the installed command.

Depends on: 5, 6. Source: ADRs 0004, 0007.
