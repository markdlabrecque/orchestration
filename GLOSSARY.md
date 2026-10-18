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

**Pickup**:
Making and provisioning a ticket's worktree before its first step. Engine work, not a step.
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

**Ticket**:
The unit of work a workflow runs over: one issue in the project's tracker.
_Avoid_: task, job

**Run**:
One ticket's walk through its workflow, from first start to merge or abort, surviving pauses and crashes.
_Avoid_: session, job, execution

**Pause**:
Stopping an engine cleanly so its run can be resumed later from the same step.
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
