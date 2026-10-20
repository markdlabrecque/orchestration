---
name: orch
description: Implement tickets through the orch CLI in orchestration-configured projects. Use when asked to implement a ticket in a project with .orch, explicitly run orch, or inspect or resume an orchestration run.
---

# Operate orch

Use `orch` to execute the configured ticket workflow. Your job is to start or observe the run and bring human decisions back to the user. The CLI owns implementation, role prompts, model selection, review loops, and repair budgets. Do not independently implement the same ticket or launch competing agents.

## Preflight

1. Identify the ticket and project wrapper containing `.orch`. Resolve ticket URLs to the identifier the installed CLI accepts. Ask if the project or ticket is ambiguous. Read project instructions and inspect the configured main checkout's branch and `git status --short --branch`. Surface uncommitted work before starting; preserve it. Existing run-owned edits can be expected on resume, but establish their ownership first.
2. Run `orch --version` and `orch --help`. Use installed help and documentation for current behavior rather than guessing flags. If the CLI or `.orch` is missing, stop and report the prerequisite. Do not silently install, update, or configure a project.
3. From the wrapper, inspect `orch show <ticket>` before starting or resuming. Distinguish a missing run from a read error. Establish whether another terminal or process owns the ticket. Status alone is not a liveness check: a crashed process can leave a running status. If ownership is uncertain, ask the user. Never open a second owner of the same run.
4. For executable work, run `orch validate` and inspect `orch explain --simple`. Check that the configured runners and their required authentication are available using non-secret status checks. Validation cannot prove remote credentials or quota will work. Never print credentials, read secret stores, or invoke 1Password. Ask the user to configure missing authentication privately.
5. Check the effective workflow's permissions and approval gates against the request before starting. Stop for clarification if it would perform unauthorized actions. Never run a workflow that logs into or writes to production.

## Run or resume

- Use `orch run <ticket>` to start a new run or resume saved progress, only after confirming no live owner remains. Let orch manage its ticket worktree; do not substitute the current agent's worktree or manually create one.
- Keep one foreground interactive terminal per ticket. Use a tool capable of retaining that terminal and relaying input. If none is available, give the user the exact command and wrapper directory to run themselves; do not launch it through a short-lived shell timeout or an unattended background process.
- Observe with `orch show <ticket>` or `orch tail <ticket>`. Use bounded observations, not a busy polling loop. Retain the ticket, wrapper path, and terminal handle so later turns can find the same run.
- Relay human questions and approval requests verbatim enough to preserve their meaning. Wait for the user's answer and submit only that answer. Do not approve on their behalf.
- Ctrl-C, SIGHUP or SIGTERM pauses a run; the same run command resumes it. Before resuming after a crash, check for surviving descendants. Use `--retry` only after investigating the blocker and obtaining explicit user authorization, never as an automatic retry loop.
- Completed or other terminal runs are results to report, not invitations to start a replacement. On failure, report the current step and actionable blocker. Preserve saved state; never edit SQLite or status/event projections to force progress.
- Run `orch abort <ticket>` or `orch retire <ticket>` only when requested and after confirming the owner has stopped. Neither command checks liveness.

## Report

Report the observed state, any blocker or decision needed, and links to existing ticket, PR/MR, or report artifacts. Distinguish running, paused, blocked, and completed. Claim tests or implementation succeeded only when the run's recorded results support it. Review logs and reports for secrets before sharing them.
