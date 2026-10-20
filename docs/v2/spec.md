# Orchestration v2 design spec

Status: ready for implementation. Assembled from the accepted decisions; phase 1 scope confirmed on 2026-10-18.

This spec implements the [v2 map](https://github.com/markdlabrecque/orchestration/issues/125). The [glossary](../../GLOSSARY.md) defines the terms. Accepted ADRs control architectural choices; this document connects them into buildable behavior. The workflow prototype at commit `a251436` demonstrates the file format, but later ADRs override its code and examples.

## Destination and delivery

Phase 1 is a deterministic TypeScript workflow engine running on Pi Durable, started from a regular terminal. A ticket gets a worktree, agents do the work, code checks the results, and code merges only the exact commit whose CI passed. A machine-wide workflow and a committed project patch control the steps. Pi and shell agent runners are replaceable independently of step kinds.

The first build slice must run one GitHub ticket through one real workflow using both runners and merge after CI. Subsequent tickets add the full workflow language, repairs, findings, GitLab and operator commands. No v2 engine is built as part of this planning ticket.

Phase 1 boundary: independent per-ticket processes are supported; coordinated multi-ticket scheduling, chat launchers, dedicated Claude/Codex/T3 runners, a screen UI and remote steering are later work. Shell commands can already launch Claude Code or Codex.

## Ownership and modules

The engine owns ordering, run state, budget accounting, findings and tracker writes. Models return content and typed judgments; they do not choose the next step or establish that a tracker write succeeded.

Keep these modules behind small interfaces:

- Workflow resolution accepts the two files and registrations, returning a validated effective workflow or one located error. It does no run execution.
- Execution walks that workflow and owns durable state. Its dependencies are runners, command execution, tracker operations and a clock.
- Step kinds assemble briefs or run commands and return declared outcomes. Custom kinds receive execution helpers, including a way to call a runner.
- Runners host models. They accept complete requests and never fetch tickets or edit the findings ledger.
- Tracker operations implement GitHub and GitLab behind the same interface, including reconciliation after interrupted writes.

Pi Durable owns persistence and continuation. Pin its exact version and contain its API use. Do not restore v1's Python database, hooks, liveness system or platform launchers. See [ADR 0001](../adr/0001-engine-on-pi-durable.md).

## Run lifecycle

`orch run <ticket>` discovers the project from the current directory, performs preflight, picks up its worktree and executes the workflow. Run files live outside ticket worktrees in the project's `.agents/orchestration/runs/`. Each ticket has its own Pi Durable `<ticket>.sqlite`; one foreground process owns it. The documented rule is one terminal per ticket. There are no locks or daemon, and a second owner can corrupt the running execution.

The same command resumes a paused run. Ctrl-C, SIGHUP and SIGTERM request orderly pause. A crash resumes according to the runner's capabilities. After three crashes of the same step, block and require `orch run --retry` for one additional attempt. Crash counts belong to run state, separately from findings and repair budgets.

`orch abort <ticket>` ends a run after its process has stopped. `orch run` on a merged or aborted run prints its final status and exits. There is no fresh-run flag. Human steps ask on stdin; an unanswered question is asked again after resume. Run history is retained indefinitely.

Pickup and retirement are engine operations outside the patchable step list. Call the retained worktree scripts and retain `.orch` provisioning and retirement hooks. Automatically retire after a confirmed green merge; `orch retire <ticket>` supports manual retirement of blocked or aborted work. Preserve run history. See [ADR 0002](../adr/0002-one-process-and-one-storage-file-per-ticket-run.md) and [ADR 0005](../adr/0005-step-kinds-and-engine-built-ins.md).

## Workflow files

The full global YAML file is `~/.config/orchestration/workflow.yaml`. Installation copies the shipped default only when absent. The optional project patch is `<repo>/.orchestration/workflow.yaml`. Both start with `version: 1`. A project matching the defaults needs no file.

Global sections are `version`, `uses`, `settings`, `runners`, `budgets`, `repairs`, `steps`. A project has `patch` instead of `steps`. There is no `extends`, `from`, scratch mode, private wrapper override or third layer.

Settings, runners, budgets and repairs merge by name, with the project entry winning. `uses` registrations retain the directory of their declaring file for relative path resolution. Duplicate registered names fail. A setting reference must resolve before execution; step code receives resolved options rather than reading settings itself.

Steps have unique IDs and a registered `kind`. Only agent steps name a runner. Other fields include `options`, `when`, `gate`, `on`, and agent timeout/model/session configuration. A repair is a step definition or an ordered list of step definitions, declared once under `repairs`.

`when` supports the prototype's small grammar: `==`, `!=`, `in [a, b]`, `not in [a, b]` over lane or named settings. A list of conditions means all must hold. It is not executable JavaScript. Options can reference settings using `$settings.name`.

Patch operations apply in order:

```yaml
version: 1
settings:
  verification: local-tests
patch:
  - insert_after: review
    step: { id: extra-check, kind: shell, options: { command: ./check.sh } }
  - set: extra-check
    with: { when: 'lane == standard' }
  - move: extra-check
    before: report
```

Supported operations are `insert_before`, `insert_after`, `drop`, `replace`, `set` with `with`, and `move` with exactly one of `before` or `after`. `set` uses RFC 7396 merge semantics, including null deletion, and cannot change an ID. To repeat a step, insert a copy with a new ID.

The first error rejects the whole effective workflow: missing target, duplicate ID, unknown kind/runner, invalid condition, unresolved setting, undeclared repair/budget or invalid outcome mapping. Unused repairs are allowed and reported. See [ADR 0004](../adr/0004-two-workflow-layers.md).

## Step behavior and default order

The default order is spec, tests, implement, review, verify, report, mr, ci, optional human merge approval, merge. Preserve the existing role prompts' useful instructions while removing their v1 launcher and state-management responsibilities.

- `agent` selects a role through `options.role`, constructs the brief and validates its result. Outcomes are `pass`, `findings`, `failed`. Only spec can select a lane. A ticket label can force the lane.
- `shell` runs a command in the worktree through the engine's command helper. Exit zero passes; other exits fail.
- `human` has `options.ask` and `options.choices`. The first choice passes; other choices are named outcomes to map. There is no timeout.
- `mr` commits, rebases onto the base branch, pushes and opens the PR/MR through code.
- `ci` watches the head SHA every 60 seconds for up to 90 minutes. Its outcomes are `passed`, `failed`, `timeout`.
- `merge` squash-merges pinned to the CI-passed SHA. Outcomes are `merged` and `conflict`.

Successful outcomes advance only after the step's gate passes. Unmapped unsuccessful outcomes block. Do not copy the prototype's assumption that every kind's success string is `pass`; `ci` and `merge` have the accepted names above.

Gates are built-in code checks named `tests-red`, `tests-green`, `ci-green-on-head`. Test gates use `settings.tests`. A red test must fail for the intended behavior, rather than an unavailable tool or broken setup. A custom check is a shell step or custom kind. Merge's exact-SHA CI requirement is mandatory in code even if a file omits its gate.

Lanes are standard, trivial and no-code. Tests are conditional; review is skipped for trivial work; browser/site verification runs for standard work when verification is not local-tests. The shipped lane conditions must consistently skip test gates for lanes that do not require them, rather than copying the prototype's unconditional implementation test gate. Verification mode is passed through resolved options. Local-tests, DDEV and Docker verification reuse the role's applicable evidence requirements; removing v1's own Docker scaffolding does not remove a project's Docker verification mode.

The spec result chooses the implementation tier. Other roles and repairs have static tier/effort assignments. Keep light, standard, heavy and frontier, configurable through each runner's mappings; no automatic repair escalation. See [ADR 0009](../adr/0009-spec-selects-the-implementation-tier.md).

Each runner declares tier tables per model family under `families`, each tier giving `provider` and `model`, and names the active family as `family: $settings.model-family`. The shipped default is `model-family: claude` (Pi's `pi-claude-subscription` provider); `openai` is the shipped alternative. A project switches with one setting in its patch. Preflight fails when the selected family is undeclared by a runner the effective workflow uses, or lacks a tier. See [ADR 0011](../adr/0011-project-selects-the-model-family.md).

## Runner contract

A runner receives `prompt`, `role`, `cwd`, `model: { tier, effort }`, `tools`, `timeoutMs`, `resultSchema`, a cancellation signal and an event callback. It returns status `done | failed | aborted | timeout`, handoff, typed result, artifacts, actual provider/model/effort in `ranOn`, usage and any opaque session handle.

Tool words are `read`, `edit`, `shell`, `web`, `mcp:<name>`. Unsupported words fail at load. The shell runner passes these permissions through the environment but cannot enforce them. Live `tool`, `text`, `status` events go to the callback, never directly to the terminal. Default agent timeout is 60 minutes, overridable per step.

Pi uses an owned subagent conversation and a schema-backed `submit_result` tool. Stopping without submitting fails. On crash, continue the same conversation.

Shell runs the configured agent command under bash; the shipped command runs `pi -p`, not Codex. Stdin contains role text, a blank line and the brief; `ORCH_ROLE_FILE` contains the role, `ORCH_MODEL_PROVIDER`, `ORCH_MODEL` and `ORCH_MODEL_EFFORT` carry the resolved family, tier and effort, `ORCH_RESULT_SCHEMA` the result schema, stdout supplies the handoff, and `ORCH_RESULT_FILE` supplies validated JSON. A successful exit without the required valid result does not pass. Cancellation kills the process group. After a crash, rerun on the existing dirty worktree without resetting it.

Fresh sessions are the default. `session: <step id>` continues a previous session only when the runner supports it; a missing handle fails at step start. Store handles in run state, not the findings ledger.

Custom modules default-export `defineRunner` or `defineStepKind`. Registration is explicit via `uses` paths or packages; collisions with built-ins or other modules fail. See [ADR 0003](../adr/0003-runners-host-agent-steps-only.md).

## Repair and findings

An edge such as `on: { findings: { repair: fix, budget: bounces } }` spends a slot, runs the repair and rechecks the detecting step. Default budgets are `bounces: { max: 3 }`, shared across detecting steps, and `ci_repairs: { max: 2 }`.

A repair can contain several steps. For CI repair, include the work needed to commit/rebase/push the repaired change before rechecking CI. CI on the old commit cannot validate a local repair. Any change in head invalidates earlier CI evidence.

A repair failing its own gate spends another slot and reruns with a fresh agent. Crashes instead count toward the crash limit. At a spent budget ask the person to grant one slot, defer selected findings, park as a draft PR with open findings, or abort. Grants are recorded and unlimited. Partial deferral leaves other must-fix findings blocking. Deferral never bypasses gates.

One engine-owned Pi Durable document holds the findings ledger. Findings have stable run-local IDs, detecting step, summary, evidence/location and must-fix or follow-up classification. Status is open, fixed, withdrawn or deferred. Filing status is separately pending or linked.

Repair results describe a change or disagreement for each ID; repair agents cannot clear findings. The detecting reviewer alone confirms fixes or withdraws mistaken findings. Rechecks receive that reviewer's open findings, the repair report and diff. They do not clear another detecting step's findings. New discoveries during scoped rechecks become follow-ups, not additional bounces.

A person may defer with a recorded reason and a linked ticket. Failure to create that ticket leaves the must-fix open. See [ADR 0006](../adr/0006-repair-loops-with-budgets-and-a-human-at-the-cap.md) and [ADR 0008](../adr/0008-engine-owned-findings-ledger.md).

## Tracker and merge operations

Code reads tickets, assigns them, posts comments and files follow-ups. The GitHub adapter is in the first slice; GitLab follows within phase 1. Choose the forge from origin, with `settings.forge` overriding it.

Persist each follow-up in the ledger, file it immediately, then persist the returned tracker identity and URL before continuing. Failed filing pauses progress. Persist a stable hidden operation marker before every ticket/comment filing. On recovery, search for that marker and reuse any existing object. Retry creation only when absence can be established; an ambiguous result stays paused. Markers support reconciliation, not atomic exactly-once delivery. See [ADR 0010](../adr/0010-engine-owned-tracker-operations.md).

Before merge, verify that the PR/MR head still equals the SHA with successful required CI. Pin the forge merge operation to that SHA so a concurrent push cannot slip through. Conflicts block unless the workflow maps them. A repair or rebase producing another SHA requires CI again. Confirm merge before retirement; failure after the remote merge must not cause a second merge or premature loss of history.

## Operator commands and preflight

`orch validate` performs the same preflight as run without pickup. Stop on the first actionable error: invalid workflow, unresolved setting, a tests gate with no test command, missing `BASE_BRANCH`, unavailable runner, selected forge CLI, DDEV when required, or role file. Check tools for the effective workflow, not unrelated optional runners or forges. A configured plain repository with no project override must pass the shipped default.

`orch show <ticket>` reads the engine-written status JSON. `orch tail <ticket>` follows events JSONL. Neither opens Pi Durable storage. Status exposes run status, current step, step outcomes, timestamps, resumption counts and a blocking reason. Events retain full runner events and handoffs; the terminal prints step transitions, one line per tool call and final handoffs. Exact versioned field names are an implementation detail of the observability ticket, tested through these commands.

`orch explain` writes and opens the project's explain HTML with global/effective workflows side by side, highlighted patch operations, lane selection, settings, runners and unused repairs. `--simple` prints the same information as text. Run writes the page into its run folder without opening it.

`orch workflow diff` compares global configuration with the shipped default. `reset` keeps a `.bak` and refuses to overwrite edits without `--force`.

## Repository and validation

One package contains `src/`, `bin/orch`, `roles/`, `workflow.default.yaml`, `scripts/worktree/`, `test/` and `docs/`. Node >=22.19 executes TypeScript directly. Use pnpm, exact Pi Durable pinning, `tsc --noEmit`, Biome and vitest. No compiled distribution or plugin manifests.

The first build slice removes v1 Python, hooks, Pi extension, plugin folders, old orchestration skill/references, Docker scaffolding, obsolete reports, cleanup and Codex scripts from `v2`. Retain worktree engines and their bash tests, project setup and `.orch` support, role prompts, glossary, ADRs and v2 planning sources. Main remains v1.

Install from a stable checkout with `pnpm link --global`; refuse ticket worktrees. Link `~/bin/orch-update` for `git pull` and `pnpm install`. `orch --version` prints package version and commit. See [ADR 0007](../adr/0007-one-package-no-build-symlink-install.md).

Tests cross module interfaces using MemoryStorage, a fake clock, fake runner, fake command execution and Pi's fake model provider. No network in automated tests. Keep a tagged end-to-end fixture run. CI on `v2` checks types, formatting/lint, vitest and retained bash suites.

Required scenarios include invalid patch rejection; pause/crash recovery for both runners; cancellation and invalid results; three-crash blocking; shared budgets and grants; reviewer-owned findings; failed and interrupted tracker filing; CI repair changing head; and refusal to merge any SHA other than the one CI passed. The first slice demonstrates the complete path before later tickets expand its coverage.
