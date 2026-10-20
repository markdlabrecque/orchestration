# Orchestration v2

`orch` runs one GitHub or GitLab ticket through spec, tests, implementation,
review, optional site verification, reporting, PR/MR, CI and merge. Pi Durable
owns checkpoints and agent conversations. The engine owns tracker writes,
repair budgets and exact-head merge gates.

## Install

Requires Node >=22.19, pnpm, Git, Bash and Python 3. Use a dedicated, stable
clone on the v2 branch. Keep that clone: the installed command links to its
source files. Ticket worktrees, detached HEAD and ticket branches are refused.

```sh
git clone --branch v2 https://github.com/markdlabrecque/orchestration.git ~/orchestration-cli
cd ~/orchestration-cli
scripts/install-local
# Add pnpm's global bin directory and ~/bin to PATH if needed.
orch --version
```

Installation runs `pnpm install --frozen-lockfile` and `pnpm link --global`,
creates the global workflow only when absent, and links `~/bin/orch-update`.
`orch-update` pulls the stable checkout with `--ff-only`, installs dependencies
and prints the version and commit. It refuses uncommitted work and preserves
your global workflow. Both commands copy `skills/orch/SKILL.md` to
`~/.pi/agent/skills/orch/SKILL.md`, overwriting local skill edits. No Claude Code
configuration is changed. In Pi, run `/reload`, then `/skill:orch <ticket>`.
See [installation and workflow configuration](docs/v2/usage.md).

## Configure and run

Authenticate `gh` for GitHub or `glab` for GitLab. Configure the Pi provider
credentials and shell agent separately; see [runner setup](docs/v2/usage.md#runners).
DDEV is needed only when the project uses DDEV provisioning or verification.

A configured project has a wrapper folder and a `.orch` file:

```text
~/Projects/example/
  .orch                     BASE_BRANCH=main, MAIN_CHECKOUT=code/main
  code/main/                main Git checkout
  code/145/                 ticket worktree, created on pickup
  .agents/orchestration/runs/145.sqlite
```

`.orch` uses one `KEY=value` per line. The retained setup command is
`scripts/worktree/setup-project/scripts/setup-project.sh`.
`ORCH_PROJECTS_DIR` defaults to `~/Projects`. Run inside the configured project:

```sh
orch validate
orch explain                # writes and opens HTML
orch explain --simple       # terminal text; no browser
orch run 145
orch show 145                # read-only status
orch tail 145                # read-only event stream
```

Use one terminal per ticket. There are no locks or daemon; a second owner can
corrupt the run. Ctrl-C, SIGHUP or SIGTERM pauses; repeat `orch run 145` to resume.
Stop the process before `orch abort 145` or `orch retire 145`. A hard kill may
leave shell descendants alive; stop them before resuming. See
[terminal controls and recovery limits](docs/v2/terminal-controls.md).

The global file is `~/.config/orchestration/workflow.yaml`, or under
`XDG_CONFIG_HOME`. A committed `.orchestration/workflow.yaml` in the project
patches it. Configure the project's full test command and its assertion reporter
before standard-lane work; plain `pnpm test` alone does not supply red-gate
evidence. [The reporter contract](docs/v2/role-execution.md#red-gate-reporter-contract)
defines the required JSON. Trivial and no-code lanes skip the test gates.

```sh
orch workflow diff          # compare global with this installed version
orch workflow reset         # refuses changed globals
orch workflow reset --force # keeps a .bak before replacing edits
```

The first run saves its explanation beside the SQLite file without opening a
browser. Completed steps do not replay. Pi continues its owned conversation;
shell restarts in the existing dirty worktree. History survives retirement.
GitHub requires reported required checks; GitLab requires its head pipeline.
Missing CI never counts as green. Merge is pinned to the CI-passed SHA.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec vitest run test/cli.fixture.test.ts test/install.test.ts
```

`pnpm check` is the cheap per-branch tier: TypeScript, Biome and Vitest.
`pnpm check:release` adds the retained Bash suites and Python project-safety
tests; run it before a release. Orchestration only builds the integration
branch, so the release tier is run by the human or release CI. Fixtures use real local Git worktrees, SQLite and runner
adapters with fake model and forge boundaries. The installation fixture uses
an isolated HOME and pnpm global directory, tests install/update/version and
runs the installed executable through a standard workflow. It never changes
the operator's installed CLI or global workflow.

This repository's project override uses `pnpm check` and requires its `v2 / check`
CI job before merge. Mark that job required in GitHub branch protection so the
engine waits for it; the additional project step refuses missing, wrong-workflow,
failed or stale-head evidence.

[Design spec](docs/v2/spec.md) · [build plan](docs/v2/build-plan.md) ·
[role execution](docs/v2/role-execution.md) · [repairs](docs/v2/repairs.md) ·
[terminal controls](docs/v2/terminal-controls.md) · [glossary](GLOSSARY.md)
