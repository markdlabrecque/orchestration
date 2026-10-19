# Installation and workflow configuration

## Stable checkout

Install from a dedicated clone on a maintained branch, currently `v2`.
`scripts/install-local` resolves its own location, so it works from any current
directory. It refuses all linked Git worktrees, including ticket worktrees,
and detached HEAD or ticket-shaped branch names. A dedicated clone is required
even if you keep a long-lived linked worktree for development.

Node >=22.19 executes TypeScript directly. No build or generated distribution is
involved. The install script runs `pnpm install --frozen-lockfile` followed by
`pnpm link --global`; pnpm must have a global bin directory configured and on
PATH. `pnpm setup` can configure it. The script also links `~/bin/orch-update`;
add `~/bin` to PATH. Nothing installs git hooks or plugin manifests.

Keep the checkout at its installed path. `orch --version` prints the package
version and the checkout's short Git commit. Local source edits immediately
affect the linked CLI; the version commit identifies committed source only.

`orch-update` resolves its symlink to that same checkout, refuses uncommitted
work, runs `git pull --ff-only` and `pnpm install --frozen-lockfile`, then prints
the version. Configure the branch's upstream before updating. Divergence is
refused rather than rebased. If dependency installation fails after a pull,
fix the dependency problem and rerun the command before starting tickets.
Neither install nor update replaces an existing global workflow.

## Two workflow files

The global file is `${XDG_CONFIG_HOME:-$HOME/.config}/orchestration/workflow.yaml`.
Installation copies `workflow.default.yaml` only when the destination is absent,
including preserving an existing symlink. The global file is the complete
workflow. The only project layer is `<main-checkout>/.orchestration/workflow.yaml`,
a version-1 patch committed with the project.

```yaml
version: 1
settings:
  tests: ./scripts/test-with-orchestration-report
  verification: local-tests
  merge-approval: true
patch:
  - insert_before: report
    step:
      id: project-check
      kind: shell
      options: { command: ./scripts/project-check }
```

Settings, runners, budgets and repairs merge by name. A runner entry replaces
that whole named entry, so include its command and all model mappings together.
Patch operations address stable step IDs and apply in order. Use `insert_before`,
`insert_after`, `drop`, `replace`, `set` with `with`, or `move` with one anchor.
`set` recursively merges objects and deletes fields set to null. Invalid patches
fail before pickup. Custom modules remain relative to their declaring file.

`orch workflow diff` prints a Git diff of shipped default versus global. An empty
diff prints a match message. It does not need a configured project.
`orch workflow reset` restores the installed default, refusing any changed global
unless `--force` is supplied. It backs up the previous file as `workflow.yaml.bak`;
later backups use `workflow.yaml.1.bak`, `.2.bak`, and so on without overwriting
older backups. A missing global is created. Review the diff after updates before
resetting; resetting discards local runner mappings from the active file.

## Explain

`orch explain` resolves both files, saves
`<wrapper>/.agents/orchestration/explain.html` and opens it using the operating
system's browser opener. The self-contained page works offline. If opening
fails, the printed path still points to the saved page; open it manually in
Firefox. `--simple` prints the same workflow information without writing or
opening HTML. Explain loads declared modules but does not run preflight, agents,
pickup or tracker commands.

The page shows global and effective steps side by side on desktop, stacked on
narrow screens. Gold borders mark configuration and ordering differences.
Expand steps for conditions, options, gates and repair edges; expand runners,
budgets and repairs for their definitions. The patch source is shown separately.
The lane selector previews standard, trivial and no-code without changing files.
Skipped steps remain visible. A spec result or ticket label chooses the actual
run lane. Text output lists each lane's path and the same definitions.

A new `orch run <ticket>` saves the same HTML as
`<wrapper>/.agents/orchestration/runs/<ticket>.explain.html`, without opening it.
The file is retained across resumes and retirement. It records the configuration
at run creation, not subsequent edits. Older runs created before this feature
may have no explanation; completed runs are not reopened to generate one.
Reports escape workflow content as text. They still contain your runner commands
and settings, so do not place credentials in workflow files or publish a report
without reviewing those values.

## Runners

Pi runs the configured OpenAI or Anthropic model with the provider's normal
credentials, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Set
`runners.pi.models` to a mapping of light, standard, heavy and frontier, each
with `provider` and `model`. Check that the models are available to your account.
Preflight checks configured models, roles and tools without starting an agent;
it cannot prove that a remote credential or account quota will work.

The shipped shell runner uses an authenticated Codex CLI. It passes the requested
model and effort, supplies the role's JSON schema through `--output-schema`, and
captures the final JSON with `--output-last-message` at `ORCH_RESULT_FILE`.
Use a Codex version supporting those flags. The configured sandbox is
`workspace-write`; shell tool permissions remain advisory and are not enforced
by orchestration itself. Read the full [runner contract](role-execution.md).

To use another command, set `runners.shell.command` and its model mappings.
The command reads role text and brief on stdin, returns a handoff on stdout,
and writes schema-valid JSON to `ORCH_RESULT_FILE` before exiting zero.
`ORCH_RESULT_SCHEMA` contains the JSON schema, not a filename. `ORCH_ROLE_FILE`
contains role text. `ORCH_MODEL`, `ORCH_MODEL_TIER`, `ORCH_MODEL_EFFORT` and
`ORCH_TOOLS` carry routing and requested permissions. A plain command that only
prints prose cannot satisfy the role contract. Missing or invalid JSON blocks.

## Test commands and reporters

Set `settings.tests` to the project's full suite command. The shipped `pnpm test`
is a starting value, not a universal test adapter. Standard-lane `tests-red`
requires exit 1 and a fresh JSON report written to `ORCH_TEST_REPORT_FILE` from
actual framework results. Each assertion's test name and message must exactly
match the test-writer's `expectedFailures`. Import, syntax, collection, command
and setup failures belong in `errors`, never in assertion failures. Do not write
a static report or infer assertion success from a nonzero process exit.

The test-writer must configure a framework reporter or wrapper when the project
does not already have one. This repository uses `pnpm check` for all required
suites; its test-writer must add the appropriate framework reporter for any
standard-lane red tests. Type/lint/shell setup failures must still block red.
`tests-green` reruns the full command and requires exit zero. Reporter JSON and
role result JSON are separate contracts. See the
[exact report shape and gate behavior](role-execution.md#red-gate-reporter-contract).

The repository override also inserts `repository-ci` before merge. It requires
the `check` job from the `v2` GitHub workflow to pass on the current PR head.
Keep `v2 / check` required in branch protection so the engine's CI step waits
for it. The policy script does not change repository settings. The engine still
checks and pins the merge SHA after this additional check.

## Process ownership and recovery

Use one foreground terminal per ticket. Status and tail are safe observers,
not additional owners. Stop the owner before abort or retire. There is no
liveness probe or lock. Pausing preserves completed steps; unanswered human
questions are asked again. Pi resumes its conversation, while shell restarts on
the dirty worktree. Three crashes block until explicit `--retry`. Clean pauses
do not count as crashes. A hard kill may leave external descendants alive.

Tracker writes reconcile stable markers before retrying, but do not provide
atomic exactly-once delivery. An uncertain remote result blocks. History remains
outside retired worktrees indefinitely. See [terminal controls](terminal-controls.md)
for abort/retirement recovery and [repairs](repairs.md) for findings and budgets.
