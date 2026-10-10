---
name: orchestration
description: >-
  Run coding tickets end to end. A main orchestrator gives each ticket its own worktree and ticket-orchestrator session on the same harness (Claude Code, Pi or Codex) and platform (headless, Orca, Herdr or Claude Desktop) it runs on; each ticket orchestrator runs test-writer, implementor, reviewer, verifier and reporter subagents, opens the MR and squash-merges on green CI. State lives in SQLite behind the `orch` script and plugin hooks report each session's health, so tickets resume after a crash or network drop. User-invoked only: type `/orchestration` (or `/orchestration:orchestration`) in Claude Code, `/skill:orchestration` in Pi, or `$orchestration:orchestration` in Codex to start, resume or supervise tickets. Ticket sessions are launched with that full form.
disable-model-invocation: true
---

# Orchestration

Two kinds of orchestrator and a set of stage agents:

| Role | Runs as | Does | Never does |
|---|---|---|---|
| **Main orchestrator** | The session the user talks to | Preflight, adds tickets, creates worktrees, spawns and resumes ticket orchestrators, retires finished worktrees | Ticket work of any kind |
| **Ticket orchestrator** | One session per ticket, in its worktree, on the main orchestrator's harness and platform | Writes the stage spec, runs the stage agents, triages review, opens the MR, merges on green CI | Create worktrees, spawn other ticket sessions, retire itself |
| **Stage agents** | Subagents of a ticket orchestrator | One phase each (table in [references/ticket-pipeline.md](references/ticket-pipeline.md)) | Write state, talk to the user |

## Principles

1. **State is scripted, never judged.** Every phase change goes through `orch` ([references/orch-cli.md](references/orch-cli.md)). No agent edits state by hand or infers it from memory.
2. **Read fresh.** Run `orch show <ticket>` before every decision and after every resume. What you remember from earlier in the conversation may be stale.
3. **Judge actions, not state.** An ambiguous review comment or an out-of-scope test failure is the ticket orchestrator's call. It decides, acts, then records the result through `orch`.
4. **Gates are opt-in per project.** Linting and project rules run where the project's `AGENTS.md` turns them on. Nothing is assumed globally.
5. **Merge binds to a commit.** `orch merged` refuses unless CI passed for that exact SHA.

`orch` is `scripts/orch` in the plugin: `${CLAUDE_PLUGIN_ROOT}/scripts/orch` in Claude Code; in Pi and Codex, `../../scripts/orch` from the directory holding this file. Below it is written as `orch`.

Stage agents are named per harness: `orchestration:<name>` in Claude Code (the Agent tool) and Pi (the `subagent` tool); `<name>-<tier>-<effort>` as the `spawn_agent` agent type in Codex (the `agent` `orch route` prints), from `~/.codex/agents` (`scripts/codex-agents` writes them). [references/ticket-pipeline.md](references/ticket-pipeline.md) uses the Claude names.

## Which role am I?

- The prompt says **"You are the ticket orchestrator for <ticket>"** → follow [references/ticket-pipeline.md](references/ticket-pipeline.md). Start with `orch show <ticket>`.
- Otherwise you are the **main orchestrator** → follow the section below.
- A coding request with **no ticket** (a quick fix in the current repo) → run the ticket pipeline in this session without `orch` state: you act as the ticket orchestrator, the worktree is the current checkout, and completion follows the project's `AGENTS.md`.

## Main orchestrator

A request to start, work on, or resume tickets authorizes this whole loop. Do not re-ask for each step.

1. **Check the project.** Run from the project root (`~/Projects/<project>`). If `.orch` is missing, run the `setup-project` skill first. Then check the main checkout (`MAIN_CHECKOUT` in `.orch`): branch and working tree. Surface uncommitted work before starting; preserve it.
2. **Preflight.** `orch init`, then `orch preflight`. It reports the harness and platform you are running on; every ticket session you start runs there too (see "Platforms" below). Exit 5 is a stop: nothing gets created. Tell the user what failed. A missing `BASE_BRANCH` needs a line in `.orch`. Under the default `auto` policy, no verification environment (no DDEV, no `verify_harness` Docker harness) needs a decision on how verification should run. A project may explicitly select `verify_policy: "local-tests"` in project-root `.agents/orchestration/config.json` instead; see [references/orch-cli.md](references/orch-cli.md#configjson). Ask once, two options max, with a recommendation.
3. **Recover first.** Run `orch reconcile --project <absolute project root>` to retire `done` tickets still awaiting cleanup. Inspect every attention outcome; preserve dirty work and repair the reported adapter or trust failure before retrying. For Desktop, run `orch retire <ticket>` manually and carry out its `desktop_archive` action. Apply [Assignment](#assignment) to active existing tickets on `orch list`, then use `orch stale` to find dead unfinished sessions and `orch resume <ticket>` each cleared ticket. The ticket orchestrator picks up from its recorded phase. Finish this recovery pass before adding or dispatching tickets.
4. **Add tickets.** For each requested ticket: read the ticket, its comments and linked MRs; check dependencies and readiness per the project's `AGENTS.md`; complete [Assignment](#assignment); then `orch add <ticket> --title "<title>" --url <url>`.
5. **Dispatch.** `orch next` returns what fits under `max_workers`. Complete [Assignment](#assignment) for each before creating its worktree or spawning its session:
   1. Create and provision the worktree with the `create-worktree` skill. The worktree name is the ticket id alone (`19`, not `ticket-19`). It is cut from `BASE_BRANCH`.
   2. Write the brief (template below) to a temp file, using `verify_env` from preflight. For `local-tests`, require all project-required automated tests, independent review and exact-head CI; go from review to report without a separate verify, browser or accessibility stage. Accessibility tests are `on` only when `.orch` in the project root has `ACCESSIBILITY_TESTS=true` (any case). Missing, or any other value, is `off`.
   3. `orch spawn <ticket> --worktree <absolute path> --brief-file <file>`. On Desktop, carry out the printed action (below).
   A ticket whose prerequisite is not `done` stays in `ready` until it is.
6. **Supervise until every ticket is done.** Run `orch wait --since <watermark>` in the background (Claude Code: Bash `run_in_background`; Codex and Pi: their background command mechanism). It returns when a ticket is `blocked`, asks a `question`, is `done`, `idle`, `dead` or `stalled`. React to the printed events by the rules below, then start the next `wait` with the printed watermark (the first one needs no `--since`). Exit 6 means nothing happened; re-run it. Keep a slow fallback `orch list` check (every 20-30 minutes) in case a wait dies. Apply [Assignment](#assignment) before resuming or messaging an active ticket to carry on, and before dispatching newly unblocked tickets. React by phase and `health`:
   - Confirmed shared baseline failure → follow [Shared baseline failures](references/orch-cli.md#shared-baseline-failures). Record explicit reproduction evidence and the owning fix ticket; `orch next` prioritizes its ready owner. Keep affected implementation and unrelated work moving. Once the owner is done, identify the actual integrated fix SHA and run `baseline resolve`, even if it had already merged at confirmation. Send recorded refresh requests to affected ticket orchestrators; main never rebases their worktrees.
   - `done` with no retirement timestamp → `orch retire <ticket>` and, on Desktop, carry out its action. This command already removes the worktree and DDEV project through the retirement engine; successful retirement needs no second teardown. Inspect refusals and preserve the pending cleanup for retry. Then dispatch anything newly unblocked.
   - `dead` and not done (`orch stale`) → `orch resume <ticket>`. If the same ticket dies twice in a row at the same phase, look at why (headless: the tail of `<project root>/.agents/orchestration/logs/<ticket>.log`; Orca/Herdr/Desktop: the session itself), fix the cause if it is environmental, and resume. Otherwise, report it.
   - `idle` and not done or blocked → the session finished a turn without finishing the ticket. Headless sessions exit at that point and show `dead`, so they get resumed. On Orca, Herdr or Desktop the session stays open, so send it a message (`orca terminal send`, `herdr agent prompt`, or the Desktop session tool): "Run `orch show <ticket>` and carry on."
   - `stalled` → look at the session. Kill it only if it is truly stuck; it then shows `dead` and gets resumed.
   - `question` → apply the answer rules below, then `orch answer <ticket> <question-id> <answer>`. The session's `orch ask` returns it.
   - `blocked` → read the reason with `orch show`. If it is a permitted stop (see the pipeline reference), ask the user, then `orch resume <ticket> --note "<answer>"`. Resume restores the phase the ticket was blocked from.
7. **Report.** When the batch is done: per ticket, the MR, the merge SHA, the errors the verifier reported (listed in the MR description), the follow-up tickets filed, and anything a person still needs to look at.

The main orchestrator never runs stages, edits code, or merges. If a ticket session cannot be started, report the blocker; never fall back to doing the ticket in this session.

### Answer rules

- May answer: facts the main orchestrator can see (other tickets' scope, phase or files touched, known baseline failures, whether a dependency is merged).
- Must escalate to the human: scope, product behaviour, anything the ticket's binding decisions leave open, anything a brief says not to decide. Ask the human, then `orch answer` with their reply. The ask may time out first; the ticket then blocks and is resumed after the answer.
- Recorded: every question and answer stays in `orch events` and STATE.md. An answer that changes what the ticket does is also posted as a ticket comment.

### Assignment

The main orchestrator assigns every picked-up ticket to the requesting human. Run this check for new tickets and active existing tickets on the board from `orch list`, including unassigned tickets. Skip done and retired historical tickets.

1. Resolve the requester's tracker identity from an explicit request or project convention first. Use the authenticated identity only when it identifies the requesting human, not an unrelated bot or service account. If unresolved, ask which tracker user to assign.
2. Read current remote assignees. If the requester is already assigned, leave them unchanged with no mutation. Repeated checks are idempotent. Preserve all existing assignees. If the tracker permits only a single assignee and another user is assigned, stop and ask whether to replace that user.
3. On GitHub, use `gh issue edit <url> --add-assignee <login>`. On GitLab, fetch `glab api projects/<project-id>/issues/<iid>` and resolve the requester's numeric user ID. Update with `glab api --method PUT projects/<project-id>/issues/<iid> --field 'assignee_ids=<JSON array>'`, using the union of existing assignee IDs and the requester ID, never only the requester when others are assigned. Use the ticket's repository and host for every command.
4. Read back remote assignees after any update, using `gh issue view <url> --json assignees` or the GitLab GET above. Verify the requester and preserved assignees are present before `orch add`, and before dispatch, resume or a carry-on message. A fresh read confirming an already-assigned requester also satisfies the check. On tracker, auth, permission or read-back failure, report the error and stop that ticket's pickup or existing-ticket resume. Local orch state is not evidence of successful remote assignment.

### Ticket brief

```
You are the ticket orchestrator for <ticket-ref> (<ticket-url>), working in
<absolute-worktree-path> on branch <branch>. Follow
references/ticket-pipeline.md. Start with `orch show <ticket-id>`;
the recorded phase is where you are. BASE_BRANCH is <base>: rebase onto it and
target your MR at it. Verification environment: <ddev | docker | local-tests>.
Accessibility tests: <on | off>. You own this
ticket until it is merged. Do not create worktrees, spawn ticket sessions, or
retire anything. Record every phase change with `orch`.

Scope: <scope and acceptance criteria>
Known premises to verify: <premises>
Dependencies / related tickets: <list or none>
Unsure of a fact the main orchestrator can see? `orch ask`. A decision only the human can make, or an ask that timed out? `orch block`.
```

## Platforms

The platform running the main orchestrator hosts every ticket session it starts: `headless`, `orca`, `herdr` or `desktop` (`orch platform`). Ticket sessions also run on the main orchestrator's harness, `claude`, `pi` or `codex`, which `orch` detects (override: `ORCH_HARNESS`, or `--harness` on `spawn`/`resume`). Desktop hosts Claude only. Stage agents always run inside their ticket session.

- **headless, orca, herdr:** `orch spawn`/`resume` start the session themselves. On Orca and Herdr each ticket gets its own terminal or workspace, so you can watch and type into it.
- **desktop:** `orch` cannot open a Desktop session, so it prints an action and you carry it out:
  - `desktop_start` → start a linked session with the `start_session` tool in `cwd`, titled `title`, with the contents of `prompt_file` as its prompt. Then `orch attach <ticket> --ref <the new session id>`.
  - `desktop_resume` → if the session in `ref` still exists, message it with the contents of `prompt_file`; otherwise start a new one as above and `orch attach` it.
  - `desktop_archive` → archive the session in `ref`.
  If `start_session` is not available in this session (it isn't on every Desktop build or account), don't start anything. Tell the user Desktop can't host ticket sessions here, and that they can run the main session from a terminal instead (headless), or inside Herdr or Orca to watch tickets live. Desktop recovery needs this main session running; the other platforms can recover from any session.
- A ticket stays on the platform it started on while its session lives. A dead ticket can move with `orch resume <ticket> --platform <platform>`.

The plugin's hooks report every session's activity to `orch`, whoever started it. That is how `orch list` knows each ticket's `health` (`working`, `idle`, `stalled`, `dead`).

## Recovery, in one line

Sessions die; state does not. The main orchestrator completes [Assignment](#assignment) before continuing the same session with `orch resume`. The ticket orchestrator reads `orch show`, then redoes the recorded phase from its start if that phase's output is not on disk.

## Design background

[references/design.md](references/design.md) holds the reasoning behind this layout and its open questions.
