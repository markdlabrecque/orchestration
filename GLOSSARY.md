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
The tool that carries out a step: a Claude Code subagent, a Codex agent, a Pi subagent, a T3 Code task or a shell command.
_Avoid_: orchestration tool, harness, platform, backend, adapter

**Engine**:
The deterministic loop that walks a workflow step by step and holds its gates. Code decides the order, never a model.
_Avoid_: orchestrator, supervisor, ticket orchestrator

**Gate**:
A check in code that must pass before the next step may run, such as every test green or CI green on the exact commit.
_Avoid_: check, guard

**Global workflow**:
The workflow that applies to every project on a machine unless a project overrides it.
_Avoid_: default pipeline

**Project override**:
A project's committed set of changes to the global workflow: insert, drop, reorder or re-run steps, or start from scratch.
_Avoid_: project config, local workflow

**Ticket**:
The unit of work a workflow runs over: one issue in the project's tracker.
_Avoid_: task, job
