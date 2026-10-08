# orchestration

## The workflow

1. **You start it.** Open a session in the project root (`~/Projects/<project>`),
   type `/orchestration` and list the tickets you want done.
2. **It checks the project.** `BASE_BRANCH` is set in `.orch`, and there's a local
   site to test on (DDEV or a Docker harness). If something's missing, it stops
   and tells you.
3. **Each ticket gets its own space.** A fresh worktree cut from `BASE_BRANCH`,
   its own local site, and its own agent session. Several tickets can run at once.
4. **Each ticket goes through the same steps:**
   - **Spec**: what "done" means.
   - **Tests**: written first, and they fail.
   - **Code**: written until every test passes.
   - **Review**: a second agent checks the code. Up to 2 fix rounds.
   - **Verify**: an agent uses the change like a real user. It reports confusing
     spots and errors (console, network, server logs), plus an accessibility
     scan if `ACCESSIBILITY_TESTS=true`. The results go on the ticket as a
     comment with screenshots.
   - **Report**: a short write-up of what changed.
5. **It opens the MR**, waits for CI, and squash-merges once CI is green. If the
   project says a person must merge, it stops and waits for you instead.
6. **Leftover problems become new tickets.** It doesn't stop to ask about them.
7. **It cleans up.** It removes each finished ticket's worktree and local site.
8. **You get one report**: the MR and merge for each ticket, any errors found,
   the new tickets it filed, and anything a person still needs to check.

If a session crashes, it picks up where it left off.

Run coding tickets end to end. A main orchestrator gives each ticket its own worktree and a ticket-orchestrator session on the harness it runs on (Claude Code, Pi or Codex) and the platform it runs on: headless, Orca, Herdr or Claude Desktop (Claude only). Each ticket orchestrator runs the stage agents (test-writer → implementor → reviewer → verifier → reporter), opens the MR and squash-merges once CI is green. Ticket state lives in SQLite behind the `orch` script, and plugin hooks report every session's health, so a ticket resumes after a crash, sleep or network drop.

## What's inside

| Path | What |
|---|---|
| `skills/orchestration/` | The skill: roles, main orchestrator loop, ticket pipeline, `orch` CLI contract, design notes |
| `skills/setup-project/`, `skills/create-worktree/`, `skills/retire-worktree/` | Project setup and worktree engines |
| `scripts/orch-project.sh` | Shared project-root resolver the shell engines source |
| `agents/` | Stage agents: `test-writer`, `implementor`, `reviewer`, `verifier`, `reporter` (spawned as `orchestration:<name>`; plain `<name>` on Codex) |
| `scripts/orch` | State CLI, Python 3.9+ standard library only |
| `scripts/install-local` | Installs or refreshes this checkout in Claude Code, Codex and Pi |
| `scripts/codex-agents` | Writes the stage agents to `~/.codex/agents` for Codex |
| `hooks/hooks.json` | Reports each session's activity to `orch` (Claude Code and Codex) |
| `pi/extension.ts`, `package.json` | Pi package: the same hooks, plus the stage agents for the `subagents` extension |
| `.codex-plugin/plugin.json` | Codex plugin manifest |
| `tests/` | `python3 -m unittest discover -s tests -v` |

## Requirements

- `python3` 3.9+ and `git`.
- The harness on `PATH`: `claude`, `pi` (with the `subagents` extension) or `codex`. For Orca or Herdr, their CLI too (`orca`, `herdr`). For Desktop, the main session needs the `start_session` tool.
- `glab` or `gh` for MRs and CI.
- The `setup-project`, `create-worktree` and `retire-worktree` skills (bundled) for project setup and worktree setup and teardown.
- A verification environment: DDEV in the project, or a Docker harness command in `<project root>/.agents/orchestration/config.json` (`verify_harness`). Without one, preflight stops before any ticket starts.

## Project setup

Each project lives in its own folder under `~/Projects` (`ORCH_PROJECTS_DIR` overrides):

```
~/Projects/<project>/        project root: run the orchestrator here
├── .orch                    project config (KEY=VALUE)
├── .agents/orchestration/   orch state: state.db, logs/, briefs/, config.json
└── code/
    ├── <main checkout>/     DDEV name: <PROJECT_NAME>
    └── <id>/                ticket worktrees; DDEV name: <id>-<PROJECT_NAME>
```

1. Make `~/Projects/<project>/code/` and clone the repository into it.
2. Run the `setup-project` skill from anywhere in the project folder. It writes `.orch` with every default filled in: `PROJECT_NAME` (the folder's name), `MAIN_CHECKOUT`, `WORKTREE_ROOT` (`code`), `BASE_BRANCH` (from `origin/HEAD`) and `ACCESSIBILITY_TESTS=false`.
3. Check `BASE_BRANCH`. Ticket worktrees are cut from it and MRs squash-merge into it.

Set `ACCESSIBILITY_TESTS=true` in `.orch` to have the verifier run an automated accessibility scan (axe) on every screen a ticket changes. Any other value means off.

`<project root>/STATE.md` is a human-readable log the orchestrator creates on first use, with a `## Notes` section for your own text and a `## Activity` section. `orch` only ever appends lines to the end of the file, never rewriting what is there: `- <UTC timestamp> #<ticket> <event>` for `picked up` (spawn, and resume as `picked up: attempt <n>`), `blocked: <reason>` and `completed: <MR link or commit <sha>>` (`orch merged --mr <url>`). When `ORCH_HOME` is set and no project folder resolves, it is written there instead.

Every key resolves the same way: environment variable, then `.orch`, then the default. Relative paths in `.orch` resolve against the project root.

## Install and invoke

The skill is user-invoked only on every harness. Ticket sessions run on the harness the main orchestrator runs on; `ORCH_HARNESS` overrides the detection.

Run `scripts/install-local` from this checkout. It installs the plugin in every harness on `PATH` (or only the ones you name: `scripts/install-local codex`), and removes older installs from other marketplaces. Re-run it after every change, then restart open sessions. Claude Code and Codex install a copy, so they need the re-run; Pi loads the checkout in place.

| Harness | What the script does | Start it |
|---|---|---|
| Claude Code | Adds this checkout as the `orchestration` marketplace and installs `orchestration@orchestration` | `/orchestration` |
| Pi | `pi install <checkout>` (needs the `subagents` extension for stage agents). Stage agents run on `openai-codex` models by routing tier; set `pi_models` in `~/.config/orchestration/config.json` to use other providers | `/skill:orchestration` |
| Codex | Adds this checkout as the `orchestration` marketplace, installs `orchestration@orchestration`, then runs `scripts/codex-agents`. Ticket sessions enable hooks themselves (`--enable hooks`) | `$orchestration:orchestration` |

Every stage dispatch is routed to a model tier and an effort rung: `orch route` picks it, `orch run` records it, and on Claude the `SubagentStop` hook checks the model the subagent really ran on.

Check a machine with `orch selftest` on each harness you use. On Claude it ends with the routing smoke test (`orch smoke-routing`: subagents really run on `haiku` and `fable`); `--skip-routing` leaves it out.
