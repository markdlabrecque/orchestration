# Workflow modules and preflight

`loadWorkflow(globalPath, projectPath?)` loads explicit `uses` entries and returns
`{ workflow, registrations }`. Relative modules and npm packages resolve from the
file declaring them, including packages with import-only exports. An absent
project file is valid. `resolveWorkflow(globalYaml, projectYaml?, { registrations })`
is the synchronous resolution interface for callers that already have registrations.

Project settings, runner configurations, budgets and repairs replace entries by
name. A null project entry removes that name. Only `set.with` recursively merges
objects using RFC 7396; its null members delete fields and its arrays replace
arrays. Options resolve after all patches, so references removed by a patch do
not survive in the effective workflow. `unusedRepairs(workflow)` reports repair
names without incoming references.

Modules default-export a definition made with `defineStepKind` or `defineRunner`
from `src/registration.ts`. Kind names and runner names have separate namespaces;
each rejects collisions with its built-ins and earlier modules.

A custom kind declares `name`, `outcomes` and an async `run(step, helpers)`.
Its first declared outcome advances the workflow. Other outcomes block until
repair execution is implemented. The helper provides the ticket worktree as
`cwd`, command execution as `exec`, the cancellation `signal`, `onEvent`, and
`runAgent(name, request)`. If the kind calls runners, it must declare their names
in its `runners` list so preflight can check them before pickup.

A custom runner declares `name`, `resumable`, supported `tools`, and
`create(config)`. The returned object implements the shared `Runner` interface.
An optional async `preflight(config, { cwd, exec })` checks external requirements
without starting an agent. Both the hook and factory must be safe to call during
validation. Configuration comes from the effective workflow's named runner entry.
The engine keeps functions outside Pi Durable's serialized workflow state.

`orch validate` and `orch run` share preflight. It validates the effective workflow,
BASE_BRANCH, roles, active runners, the selected forge CLI, and DDEV when the
retained provisioning scripts or resolved verification options need it. It considers
all possible lanes, excludes statically disabled steps, and follows reachable
repair references. Shell runner preflight checks shell syntax and a simple leading
executable without executing the command. Arbitrary shell programs can still fail
at runtime, including commands selected inside conditionals.

The retained Pi/shell agent, GitHub, CI and pinned merge path remains executable.
Custom kinds, custom agent runners, shell steps and conditions now execute through
the same engine. A workflow without a successful merge completes without retirement.
Role routing, human interaction, sessions, test gates and repair execution remain
for the later build tickets. Human/session/test-gate steps currently block explicitly;
failed outcomes block rather than silently advancing through an unimplemented repair.
GitLab execution still requires its planned tracker adapter.

No behavior tests were retired or simplified for this change. The CLI fixture now
loads modules from both workflow layers and exercises them before its existing
Pi/shell, exact-head CI, merge and retirement checks. The full `pnpm check` passed
with 65 TypeScript tests, the retained bash suites and 15 Python tests.
