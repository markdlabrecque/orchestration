---
status: accepted
date: 2026-10-17
---

# A runner hosts a model for an agent step and knows nothing else

A runner is the tool that puts a finished prompt in front of a model and brings the answer back: a Pi Durable subagent in phase 1, or any command that reads a prompt on stdin and writes its handoff on stdout (`claude -p`, `codex exec`). Only agent steps name a runner. The step kind builds the brief from the ticket, the role prompt and earlier handoffs, and interprets the typed result; the runner never reads the tracker, the workflow or the ledger. Steps that run commands themselves (mr, ci, merge, custom kinds) use the engine's `exec` helper and no runner.

## Considered options

- A runner carries out any step, so mr, ci and merge are `kind: shell` steps with `runner: shell`. Rejected: it folds two seams into one and makes every shell step carry agent-shaped input and output it does not use.
- Runners that read the ticket and assemble their own prompts. Rejected: the spec step would have to change whenever a runner is swapped.

## Consequences

- The seam is one call: a request in (`prompt`, `role`, `cwd`, `model: { tier, effort }`, `tools`, `timeoutMs`, `resultSchema`), a result out (`status` of done, failed, aborted or timeout; `handoff`; typed `result`; `artifacts`; `ranOn`; `usage`; `session`). Evidence such as test output is part of the typed result the step kind asks for, never a field of its own.
- Tool permissions are shared words (`read`, `edit`, `shell`, `web`, `mcp:<name>`) each runner maps to its own tools. A word a runner cannot honour fails at load. The shell runner passes the words through in the environment and cannot enforce them.
- The runner reports live events (`tool`, `text`, `status`) through one callback and never prints; the engine writes the events file and the terminal.
- Cancellation is a signal the runner must obey: abort the conversation or kill the process group, then return `aborted` or `timeout`. A timeout is a failure a repair edge can catch. Agent steps default to 60 minutes.
- Each runner declares whether it is resumable. After a crash the Pi runner continues the same conversation; the shell runner reruns the command from scratch on the dirty worktree, which the engine never resets. Both count toward the ledger's crash limit.
- A step may continue a previous step's agent (`session: implement`) when the runner supports sessions; the ledger keeps the opaque session handle, and a handle the runner cannot find fails the step at start.
- The Pi runner realises `resultSchema` as a `submit_result` tool that ends the run; stopping without calling it fails the step. The shell runner reads the result as JSON from the file named by `ORCH_RESULT_FILE`; the role prompt is on stdin before the brief and also in the file named by `ORCH_ROLE_FILE`.
- Runners are registered by name like step kinds: built-in `pi` and `shell`, custom ones through `uses:` modules exporting `defineRunner`. Runner settings live in a `runners:` block of the workflow file, overridable per project: each runner's tier-to-model tables per model family (the family chosen by `settings.model-family`, ADR 0011), shell's named commands. Which step gets which tier is a separate decision.
