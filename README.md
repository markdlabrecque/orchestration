# orchestration

## The workflow

1. **You start it.** Open a session in the project root (`~/Projects/<project>`),
   type `/orchestration` and list the tickets you want done.
2. **It checks the project.** `BASE_BRANCH` is set in `.orch`, and there's a local
   site to test on (DDEV or a Docker harness), unless the project explicitly
   selects `local-tests` below. If something's missing, it stops
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
     comment with screenshots. Under `local-tests`, review goes straight to
     report without browser or accessibility checks; all project-required
     automated tests, independent review and exact-head CI still must pass.
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
- A verification environment: DDEV in the project, or a Docker harness command in `<project root>/.agents/orchestration/config.json` (`verify_harness`). Without one, default preflight stops before any ticket starts. Projects requiring only local automated tests can explicitly select `verify_policy` below.

### Verification policy

Set `"verify_policy": "local-tests"` in `<project root>/.agents/orchestration/config.json` to select local automated tests even when DDEV or Docker is available. No container or container tool is required. Completion requires all project-required automated tests with complete passing evidence, independent review and exact-head CI before merge.

The only accepted values are `auto` and `local-tests`. Absence defaults to `auto`, preserving DDEV-first, Docker-second detection and refusal when neither is available. Every other supplied value, including null, booleans, empty strings and wrong case, is rejected. This setting uses the existing root state-directory config loading, with `ORCH_HOME` overriding that directory. Checkout/worktree config files, `.orch`, environment policy variables and prose in `AGENTS.md` do not select it. It does not change base-branch, platform, harness or merge gates.

`spawn` retains local-tests instructions in the stored ticket brief and both resume paths replay them, so config changes do not switch an existing ticket's policy. Legacy launch callers still work without a verification environment; preflight remains the missing-environment gate.

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

1. Start with either a repository cloned inside `~/Projects/<project>/code/`, or an existing checkout at `~/Projects/<project>/` with a real `.git` directory.
2. Run the `setup-project` skill. For a root checkout, the agent explains the move and asks for explicit confirmation before any mutation. Approval allows `setup-project.sh --relocate-checkout`, invoked at the project root, to move the checkout into `code/main`. This preserves Git history, the current branch, hidden and untracked entries, and symlinks. The outer folder keeps its name and retains `.orch` and `.agents` state. Declining or withholding confirmation leaves everything unchanged. Any existing `code` entry causes refusal; linked worktrees with a `.git` file are not relocated.
3. For an already arranged checkout inside `code/`, setup runs from anywhere inside the project without relocation. It writes `.orch` with every default filled in: `PROJECT_NAME`, `MAIN_CHECKOUT`, `WORKTREE_ROOT=code`, `BASE_BRANCH` from `origin/HEAD`, and `ACCESSIBILITY_TESTS=false`. Existing `.orch` requires separate overwrite approval and `--force`; that flag never authorizes relocation.
4. Check `BASE_BRANCH`. If `origin/HEAD` is unavailable, setup warns and leaves it empty. Ticket worktrees are cut from this branch and MRs squash-merge into it.

Set `ACCESSIBILITY_TESTS=true` in `.orch` to have the verifier run an automated accessibility scan (axe) on every screen a ticket changes. Any other value means off.

`<project root>/STATE.md` shows committed SQLite workflow records in a generated section, alongside preserved human notes and legacy activity. Use `orch state-md check` to inspect freshness and `orch state-md rebuild` to repair stale output. Use `orch state-md diagnostics --json` for read-only retained inode, logical byte and scanned-tail byte accounting. Changed publications retain complete previous documents indefinitely; unchanged rebuilds retain nothing new. For metric definitions, per-check costs, same-filesystem and backup requirements, writer-quiescence requirements before authorized manual cleanup, section ownership and recovery after export failures, see [STATE.md synchronization](skills/orchestration/references/orch-cli.md#statemd-synchronization).

Every `.orch` key resolves the same way: environment variable, then `.orch`, then the default. Relative paths in `.orch` resolve against the project root.

## Install and invoke

The skill is user-invoked only on every harness. Ticket sessions run on the harness the main orchestrator runs on; `ORCH_HARNESS` overrides the detection.

Run `scripts/install-local` from this checkout. Its first line says which version Claude Code has installed and which this checkout offers; when they match (same version and commit, clean tree) it exits there. Otherwise it installs the plugin in every harness on `PATH` (or only the ones you name: `scripts/install-local codex`), and removes older installs from other marketplaces. Re-run it after every change, then restart open sessions. Claude Code and Codex install a copy, so they need the re-run; Pi loads the checkout in place.

| Harness | What the script does | Start it |
|---|---|---|
| Claude Code | Adds this checkout as the `orchestration` marketplace and installs `orchestration@orchestration` | `/orchestration` |
| Pi | `pi install <checkout>` (needs the `subagents` extension for stage agents). Stage agents run on `openai` models by routing tier; set `pi_models` in `~/.config/orchestration/config.json` to use other providers | `/skill:orchestration` |
| Codex | Adds this checkout as the `orchestration` marketplace, installs `orchestration@orchestration`, then runs `scripts/codex-agents`. Ticket sessions enable hooks themselves (`--enable hooks`) | `$orchestration:orchestration` |

### Optional completed-ticket cleanup

On Linux, explicitly enable a systemd user timer from a stable checkout with
`scripts/install-local cleanup install --projects-dir "$HOME/Projects"`.
Ordinary harness reinstall does not enable it. Use `cleanup status`,
`cleanup disable` or `cleanup uninstall` to inspect or remove it.
The timer retries completed, unretired tickets about every five minutes while
its user manager runs, including startup catchup. It never resumes or dispatches
agents, forces dirty deletion, installs a root service or enables lingering.
For one project, run `scripts/orch reconcile --project /absolute/project`.
See [cleanup installation and recovery](skills/orchestration/references/cleanup.md)
for adapter PATH configuration, journal commands, notification deduplication,
interrupted teardown recovery and Desktop manual archival.

Every stage dispatch is routed to a model tier and an effort rung: `orch route` picks it, `orch run` records it, and on Claude the `SubagentStop` hook checks the model the subagent really ran on.

Check a machine with `orch selftest` on each harness you use. On Claude it ends with the routing smoke test (`orch smoke-routing`: subagents really run on `haiku` and `fable`); `--skip-routing` leaves it out.
