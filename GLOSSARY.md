# Orchestration v2

Runs a ticket through a fixed, code-driven sequence of steps, each carried out by a pluggable tool, on top of Pi Durable. This glossary names the concepts; it carries no implementation detail.

## Language

**Workflow**:
The ordered set of steps a ticket goes through, from pickup to merge.
_Avoid_: pipeline, stage list

**Step**:
One stage of a workflow, such as spec, tests, implement, review, fix, report, mr, ci or merge.
_Avoid_: stage, phase

**Step kind**:
The named type of a step that says what it does, such as an agent step or a shell step. New kinds are registered by name.
_Avoid_: step type, plugin

**Runner**:
The tool that hosts a model for an agent step and brings its handoff back: a Pi subagent, a Claude Code or Codex command, or any command that reads a prompt and writes an answer.
_Avoid_: orchestration tool, harness, platform, backend, adapter

**Role**:
The job a model does in an agent step, given by one of the stage prompts: spec-writer, test-writer, implementor, reviewer, verifier, reporter.
_Avoid_: agent, persona, runner

**Model tier**:
A named level used to select a model: light, standard, heavy or frontier. A tier can correspond to different models for different model families and runners.
_Avoid_: model family, model name

**Model family**:
A named set of models, one per tier, from one provider, such as claude or openai. The workflow's `model-family` setting picks it; a project can change it. Default: claude.
_Avoid_: provider, tier, vendor

**Brief**:
The finished prompt an agent step hands its runner: the ticket, the role prompt and the handoffs so far.
_Avoid_: task, context, instructions

**Handoff**:
The final text an agent step returns, alongside any typed result the step asked for.
_Avoid_: output, report, answer

**Session**:
A runner's continuation handle for an agent step's conversation, so a later step may pick up where that agent left off.
_Avoid_: conversation, thread, context

**Agent step**:
A step that puts a role in front of a model through a runner and reads back its handoff and typed result.
_Avoid_: stage agent, subagent step

**Preflight**:
The checks a run performs before its first step: the effective workflow loads, every named setting, tool, runner and role is present, and the project is set up. Any miss stops the run with a reason.
_Avoid_: validation pass, sanity check

**Workspace**:
The working checkout associated with a run, which may be created for the run or explicitly adopted.
_Avoid_: session

**Workspace binding**:
The association between a platform's work context and the workspace where a run's work takes place.

**Adoption**:
Explicitly associating an existing workspace with a run without granting permission to delete it.

**Provisioning**:
Preparing a workspace's dependencies and local services so the project is ready for work, separately from creating its checkout.

**Pickup**:
Establishing a ticket's workspace and its readiness before the first step, through creation or explicit adoption, required platform binding, and provisioning. Engine work, not a step.
_Avoid_: setup, checkout

**Retirement**:
Removing a ticket's worktree and local site after its merge, or on request after an abort. Engine work, not a step.
_Avoid_: cleanup, teardown

**Engine**:
The deterministic loop that walks a workflow step by step and holds its gates. Code decides the order, never a model.
_Avoid_: orchestrator, supervisor, ticket orchestrator

**Gate**:
A check in code that must pass before the next step may run, such as every test green or CI green on the exact commit.
_Avoid_: check, guard

**Global workflow**:
The full workflow a machine runs for every project unless a project overrides it. Installed from the shipped default and editable.
_Avoid_: default pipeline, built-in workflow

**Shipped default**:
The global workflow v2 installs on a fresh machine, and restores on request.
_Avoid_: factory settings, built-in

**Project override**:
A project's committed patch over the global workflow: insert, drop, replace, move or adjust steps, and set settings.
_Avoid_: project config, local workflow, scratch workflow

**Effective workflow**:
The workflow a project actually runs: the global workflow with the project override applied.
_Avoid_: resolved workflow, merged workflow

**Setting**:
A named value in a workflow that `when:` lines and step options may read, with a default in the global workflow and a project's value in its override.
_Avoid_: variable, flag, config key

**Repair**:
A step, or ordered list of steps, that runs when a detecting step reports a problem; the detecting step then runs again, scoped to what the repair changed.
_Avoid_: fix step, bounce step, retry

**Budget**:
A named count of how many times repairs may be taken in one run. Spent when a repair edge is taken; never refilled except by a grant.
_Avoid_: cap, limit, retries

**Finding**:
A problem raised by a detecting step, with an identity that stays the same through repair and re-check. A must-fix blocks progress until the reviewer confirms it fixed or withdraws it, or a person defers it.

**Findings ledger**:
The shared record of a run's findings, which step raised each one, and how each was resolved.

**Follow-up**:
Work recorded for a later ticket rather than a repair in the current run. It remains pending until a linked tracker ticket exists.

**Deferral**:
A person's decision to move a must-fix into a linked follow-up ticket, with a recorded reason.

**Grant**:
A person's answer at a spent budget that adds one more slot.
_Avoid_: exception, extra repair, override

**Park**:
Ending a run without a merge by opening a draft PR that lists the open findings.
_Avoid_: shelve, abandon, defer

**Lane**:
The path a ticket takes through the workflow: standard, trivial or no-code. Reported by the spec step, forced by a ticket label.
_Avoid_: skip lane, mode, track

**Ticket**:
The unit of work a workflow runs over: one issue in the project's tracker.
_Avoid_: task, job

**Run**:
One ticket's walk through its workflow, from first start to merge or abort, surviving pauses and crashes.
_Avoid_: session, job, execution

**Execution owner**:
The single engine execution permitted to advance a run, distinct from the interfaces observing or controlling it.

**Control request**:
An identified instruction to operate a run whose acceptance is distinct from its completion. Retrying the same request does not repeat its effects.

**Control receipt**:
The durable record that a particular control request was accepted and of its subsequent outcome. Acceptance does not imply completion.

**Human request**:
An identified question belonging to a run that awaits an explicit human answer about a specific action or revision.

**Question subject**:
The specific action or revision a human request asks a person to authorize. A changed subject is a new human request.

**Answer provenance**:
The stated origin of a human answer: given directly by the person, or relayed by an agent or platform on their explicit behalf. Recorded as stated, not verified.

**Answer admission**:
Recording an explicit human answer for a run without advancing the run.
_Avoid_: resume, offline execution

**Recovery needed**:
A run condition in which safe continuation cannot yet be established because ownership, surviving workers, or interrupted effects remain uncertain.

**Pause**:
Stopping the engine and its owned workers cleanly and saving recovery state so the same run can be resumed.
_Avoid_: stop, suspend, interrupt

**Abort**:
Ending a run for good: its agents are stopped and the ticket is marked aborted.
_Avoid_: cancel, kill, stop

**Human step**:
A step that waits for a person to answer before the workflow continues, such as merge approval.
_Avoid_: approval gate, manual step, prompt

**Wrapper folder**:
The per-project folder beside the checkouts, `.agents/orchestration/`, that holds runs and anything not committed to the repo.
_Avoid_: state dir, orchestration dir
