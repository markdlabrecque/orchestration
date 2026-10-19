# Orchestration v2

A terminal workflow for one GitHub ticket: read and assign the ticket, pick up its
worktree, plan with Pi, implement with a shell agent, post the handoff, publish a
PR, wait for required CI, squash-merge the exact approved head, and retire the
checkout. Pi Durable 1.3.0 owns task checkpoints and agent conversations.

This branch implements the first slice of [the v2 spec](docs/v2/spec.md), tracked
in [issue 139](https://github.com/markdlabrecque/orchestration/issues/139).
The [build plan](docs/v2/build-plan.md) separates the remaining work.

## Running this slice

Requires Node >=22.19, pnpm, Git, Bash, Python 3 and an authenticated `gh` command.
DDEV is needed only for projects whose retained provisioning scripts use it.
The Pi runner supports the OpenAI and Anthropic providers using their normal
provider environment variables. The default shell command needs an authenticated
Codex CLI; replace `runners.shell.command` to use another command.

```sh
pnpm install --frozen-lockfile
mkdir -p ~/.config/orchestration
# Copy only when you have no global workflow yet.
test -e ~/.config/orchestration/workflow.yaml || cp workflow.default.yaml ~/.config/orchestration/workflow.yaml
/path/to/orchestration/bin/orch validate
/path/to/orchestration/bin/orch run 139
```

Run inside a configured project. The retained project resolver expects
`$ORCH_PROJECTS_DIR/<project>/.orch`, with `ORCH_PROJECTS_DIR` defaulting to
`~/Projects`. For example:

```text
~/Projects/example/
  .orch                     BASE_BRANCH=main, MAIN_CHECKOUT=code/main
  code/main/                the main Git checkout
  code/139/                 the ticket worktree, created on pickup
  .agents/orchestration/runs/139.sqlite
```

The `.orch` file uses one `KEY=value` per line. The existing project setup engine
is `scripts/worktree/setup-project/scripts/setup-project.sh`; its Bash tests and
configuration rules are retained. Origin must identify a GitHub repository.
Required GitHub checks must be configured: no reported required checks does not
count as green. Only passed required checks on the unchanged PR head allow a
SHA-pinned squash merge.

Use one terminal per ticket. A second process opening the same SQLite file can
corrupt the active execution; there is no lock or daemon. Ctrl-C and SIGHUP pause.
Run the same command to resume. Completed steps do not replay. An interrupted Pi
step continues its owned conversation; shell restarts on the existing dirty
worktree. A hard kill can leave external shell children alive; stop those before
resuming. Run history stays outside the worktree.

Retirement uses the retained engine with `ORCH_RETIRE_KEEP_BRANCH=1`: remove the
checkout and local site, retain the local branch, and record the retained branch
in the existing retirement journal. No branch is deleted. Standalone retirement
keeps its previous manual-branch-cleanup behavior. Failed teardown blocks and is
retried by `orch run`; a confirmed remote merge is never repeated.

## Runner and tracker boundaries

`src/workflow.ts` validates the fixed data-file workflow before pickup.
`src/engine.ts` runs it using Pi Durable tasks and documents. The effective
workflow is saved at the start of a run, so editing the global file does not
change a running ticket's sequence.

Runners accept complete role/brief requests, cancellation and event callbacks.
Pi uses a schema-backed `submit_result` tool. Shell receives role text, a blank
line and the brief on stdin, with these environment variables:

- `ORCH_ROLE_FILE`: role text file.
- `ORCH_RESULT_FILE`: write the result JSON here before exiting.
- `ORCH_RESULT_SCHEMA`: JSON schema for that result.
- `ORCH_TOOLS`, `ORCH_MODEL_TIER`, `ORCH_MODEL_EFFORT`: requested capabilities and routing.

The first-slice result is `{ "outcome": "pass" | "failed", "summary": "..." }`.
An exit-zero command with no valid result fails. Stdout is the handoff. Shell tool
permissions are advisory; the launched agent must enforce its own policy.

`src/tracker/types.ts` defines the forge boundary. The GitHub implementation
reads/assigns tickets, posts comments, files follow-ups, creates PRs, checks CI
and pins merge requests. A run UUID is committed before writes and generates
stable hidden markers. Reconciliation scans all pages before creating anything;
a failed or ambiguous scan blocks. These markers support recovery, not atomic
exactly-once delivery.

The fixed workflow supports agent steps followed by `mr`, `ci`, `merge`. The
complete patch language, role routing and gates, custom registrations, session
reuse between steps, repairs/findings, GitLab, crash-limit controls, status
readers and installation/update commands belong to the later build tickets.
Unsupported workflow fields and project patches fail explicitly. Original role
prompts remain under `roles/` for the role-workflow ticket; this slice uses the
two `slice-*` prompts. The v1 runtime, extension, plugin manifests and its tests
were removed as specified by ADR 0007. The worktree engines and all their Bash
suites remain, including their Python retirement helpers.

## Verification

```sh
pnpm check                 # types, Biome, Vitest, all four retained Bash suites and project safety tests
pnpm exec vitest run test/cli.fixture.test.ts
```

The tagged `[fixture]` test crosses the CLI, real worktree scripts, local Git
remote, SQLite, both real runners, the GitHub adapter, CI and retirement. Only
the provider and GitHub command responses are fake. No test needs network access
or credentials. Additional tests use MemoryStorage, a fake runner/clock and
SQLite restart tests. Separate child processes are killed with SIGKILL during
Pi and shell execution to verify recovery. The 15 independent Python project-safety tests were also retained. No tests were
simplified to make failures pass; the removed v1 tests depended on the deleted
runtime and packaging.

Pi Durable's pinned [README](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md)
and [task API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/types.ts)
control the durability integration. The research on `research/pi-durable-engine`
was checked against the installed 1.3.0 package, rather than its unreleased API.
