---
status: accepted
date: 2026-10-18
---

# Six built-in step kinds, one of them `agent`; pickup, retirement and preflight are engine built-ins

The workflow file names steps by kind, and v2 ships six: `agent`, `shell`, `human`, `mr`, `ci` and `merge`. There is one `agent` kind for every role (`options: { role: reviewer }`) with outcomes `pass`, `findings` and `failed`; the role prompt file carries the typed result the model must return, and only the spec-writer's result may set the lane. Gates are a field on a step naming a built-in check (`tests-red`, `tests-green`, `ci-green-on-head`) and the test command is `settings.tests`. Custom kinds and runners are TypeScript modules listed under `uses:` by relative path or npm package name; a clashing name fails at load. Pickup (worktree and provisioning through the kept `setup-worktree.sh`), retirement (`retire-worktree.sh` after a green merge, or `orch retire`) and preflight are engine work outside the step list: every ticket needs them in the same place, so making them steps adds nothing to patch.

## Considered options

- A kind per role (`review`, `implement`) with its own outcomes. Rejected: the roles differ in prompt and result shape, not in how the engine runs them.
- A `gate` step kind. Rejected: a gate belongs to the step it checks; a project needing its own check adds a `shell` step with an `on:` mapping.
- Pickup and retirement as patchable steps. Rejected: no project has a reason to move or drop them; project differences go through the existing provision and retire hooks in `.orch`.
- Custom kinds from an auto-loaded directory or the Pi Durable registry. Rejected: explicit `uses:` lines make the effective workflow readable from the file alone.

## Consequences

- `shell`: a command in the worktree, exit 0 is `pass`, anything else `failed`.
- `human`: `options: { ask, choices }`, asked on the running terminal; the first choice is `pass`, the others are outcomes to map; no timeout; pause and resume ask again.
- `mr`, `ci`, `merge` pick GitHub or GitLab from the origin host, overridable by `settings.forge`. `ci` polls every 60 seconds with a 90 minute cap and reports `passed`, `failed` or `timeout`; `merge` squash-merges pinned to the SHA that passed and reports `merged` or `conflict`.
- Preflight runs before pickup and stops on the first miss with a reason: workflow files that do not load or patch, a named setting without a value, a tests gate without `settings.tests`, a missing `BASE_BRANCH`, a runner that cannot start, a missing `gh`, `glab` or `ddev`, a missing role file. `orch validate` runs the same checks alone. The shipped default must pass preflight on a plain repository with no override file.
- `.orch` and the shell engines stay as they are in phase 1.
