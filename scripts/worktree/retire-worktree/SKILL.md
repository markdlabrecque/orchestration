---
name: retire-worktree
description: Retire a finished git worktree. Use when asked to retire, tear down, remove, clean up, or delete a worktree or its DDEV project.
---

# Retire a worktree

This skill is a **base/override pair** (worktree-promotion-spec.md), the
teardown counterpart of `create-worktree`: a generic engine here
(`scripts/retire-worktree.sh`, `scripts/reap-worktrees.sh`), plus an
optional thin per-project shim that configures and delegates to it. A
project with no shim at all still works — see `create-worktree/SKILL.md`
for the full inheritance-pattern diagram; it applies the same way here.

```
scripts/retire-worktree.sh <id> [--force] [--ddev-only]
scripts/reap-worktrees.sh [--dry-run]
```

Both run from anywhere inside the project root (`~/Projects/<project>`),
including the worktree being retired: they find the project root and the
main checkout the same way `create-worktree` does (`.orch`, see its
SKILL.md), then step out to the project root before removing anything.

`retire-worktree.sh` finds the worktree through `git worktree list`: `<id>` must
be the directory name of a linked worktree of the main checkout, wherever it
lives on disk. `WORKTREE_ROOT` is not used by it (only by `reap-worktrees.sh`).

Tears down the Herdr workspace, the DDEV project
(handed to a project's `RETIRE_HOOK` if one resolves), and the directory on
disk. Any remaining local branch is retained for manual cleanup; retirement
stays pending until a retry verifies its absence. For ticket worktrees, use `orch retire <id>`:
it closes the recorded platform through its adapters, calls this engine
with its Herdr step disabled, and records completion only after teardown
succeeds. Automatic cleanup uses that same path without `--force`.

For direct engine calls, confirm the branch has landed before proceeding.
The engine trusts the caller on merge state. Stop on any refusal, preserve
the remaining resources, repair the named failure and retry the same id.

1. Resolve the linked worktree and save its exact path, branch and HEAD in
   the repository's common git directory under `orch-retirement/`. Missing
   or unregistered targets without a recovery record refuse with exit 1.
   Ambiguous or changed identity refuses; the main checkout is never a target.
   A missing checkout is recoverable only after recorded adapter success.
2. Check `git status --porcelain --untracked-files=all`. Uncommitted work,
   including untracked or modified conventional hooks, refuses with exit 2
   and the full file list on stderr. A failed status check also refuses.
   Only an explicit manual `--force` permits discarding dirty work.
3. Close the Herdr workspace, before the DDEV step and before the worktree
   is removed. Lookup: `herdr worktree list` (the entry whose `path` is the
   worktree → `open_workspace_id`), falling back to `herdr workspace list`
   (the entry whose `worktree.checkout_path` is the worktree →
   `workspace_id`), then `herdr workspace close <id>`. Without Herdr on PATH
   and without a saved workspace obligation, the engine reports a skip.
   Valid inventories with no match report no workspace found. Every entry
   must have valid identity fields and absolute paths; malformed entries,
   including null or missing identities, cannot prove absence. A null
   `open_workspace_id` explicitly means a closed worktree. Failed
   inspection or close refuses with exit 4 before DDEV or git teardown,
   unless both inventories confirm the workspace is already absent.
   The workspace identity is saved for retry. A `RETIRE_HOOK` does not
   replace this step.

   If the resolved workspace id equals `$HERDR_WORKSPACE_ID` (the agent is
   retiring the very worktree it is running in), its close is deferred:
   steps 4 and 5 run before closing it. Stdout explains the deferral.
   A failed deferred close exits 4 without reporting completion. Retry uses
   the saved workspace identity even after the checkout is gone.
   If git removal fails first, stderr names the workspace left open and
   asks for a retry after repair. A different or unset `$HERDR_WORKSPACE_ID`
   closes in step 3 as normal.
4. Delete the DDEV project — or, if a `RETIRE_HOOK` resolves (env, then
   `.orch`, then the conventional
   `<worktree>/scripts/retire-worktree.sh`), delegate this step to it
   instead. The hook runs with cwd set to the still-existing worktree,
   before it is removed, with `RETIRE_WORKTREE_IN_HOOK=1` exported into its
   environment. A project with no retire hook anywhere is not required to
   have one. Without a hook, the engine runs `ddev delete -yO` when `.ddev`
   exists. Unavailable or failing DDEV refuses with exit 4, preserving the
   checkout and branch for repair and retry. No `.ddev` means no DDEV delete.
   A DDEV name equal to `<PROJECT_NAME>` refuses teardown to protect the
   main checkout's project.

   The conventional `<worktree>/scripts/retire-worktree.sh` hook is often a
   thin delegate shim that `exec`s straight back into this same engine. The
   engine treats exit 0 as successful project teardown. Exit 3 is reserved
   for delegate-shim re-entry: the inner engine detects
   `RETIRE_WORKTREE_IN_HOOK=1` and touches nothing; the outer engine then
   runs its own DDEV step. Every other nonzero hook exit refuses teardown
   with exit 4 and names the hook and exit code. Repair the hook and retry;
   the engine does not substitute DDEV deletion for failed custom teardown.

   `RETIRE_WORKTREE_IN_HOOK=1` is exported, so it is inherited by every
   process the hook spawns, not just a direct `exec` back into this engine.
   A hook must not itself shell out to this engine's `retire-worktree.sh`
   (e.g. to retire other worktrees as a side effect), nor to
   `reap-worktrees.sh` — `reap-worktrees.sh` in turn invokes
   `retire-worktree.sh` per worktree it reaps, and that inner invocation
   would inherit the guard variable and refuse immediately with exit 3,
   exactly as if it were the delegate-shim re-entry case above.
5. Recheck dirtiness and identity, then run `git worktree remove <worktree>`
   from the main checkout. Only explicit manual `--force` adds that flag.
   Retain any saved branch that still exists, even with `--force`, and exit 4
   with manual recovery instructions. Git's branch ref lock does not exclude
   another worktree claiming that branch, so neither an ownership check nor
   an expected-old ref deletion makes automatic branch removal safe.
   Follow [manual branch recovery](../orchestration/references/cleanup.md#manual-branch-recovery).
   Keep the recovery record until a retry verifies branch absence. Detached
   worktrees with no branch obligation can complete unattended.
6. Final report: workspace id (`none closed` when there was none; marked
   "closed last: caller's own workspace" when its close was deferred per
   step 3), DDEV project name (the name the still-present
   `.ddev/config.local.yaml` actually names, not a fresh re-derivation — a
   worktree provisioned under an older naming rule must report what
   `ddev delete` really acted on), path, branch.

`--ddev-only` skips Herdr discovery and runs steps 1, 2 and 4 (lookup,
the uncommitted-work check, then the DDEV
delete or the retire hook) and stops with exit 0, leaving the checkout
and its branch in place. This is partial project teardown, not permission
for a caller to delete the branch. `orch` uses the full engine on every
platform, including Orca. It combines with `--force`; without it a
dirty worktree still refuses with exit 2. It rechecks dirtiness after the
hook. A saved workspace
obligation from an earlier direct invocation must still be closed, even when
retrying in `--ddev-only` or orch-managed mode.

`reap-worktrees.sh` enumerates every worktree under `WORKTREE_ROOT`, decides
whether each branch has landed on `$REMOTE/$BASE_BRANCH` (ancestor,
patch-equivalent/rebase, or squash — three tiers), and hands anything landed
to the sibling `retire-worktree.sh` (without `--force`, so a dirty worktree
survives and is reported as skipped). `--dry-run` prints what would be
retired without calling it. The main checkout, which sits in `WORKTREE_ROOT`
by default, is skipped by real-path comparison. `BASE_BRANCH` is resolved
environment, then `.orch`, then refuses (no literal default — see the overrides
table); `REMOTE` defaults to `origin`.

Completion requires successful adapter teardown, checkout removal and verified
branch absence. Retained branches are a user-approved manual obligation, not
a completed retirement. Exit 0 from `--ddev-only` confirms only its partial teardown. For
pending `orch` retirement, use the recovery guidance in
`../orchestration/references/cleanup.md`; retain recovery records until all
obligations are resolved.

## Layers, precisely

Same two-layer model as `create-worktree`: a caller runs
`<project>/scripts/retire-worktree.sh` (or `reap-worktrees.sh`) if the
project has one — a thin shim that sets project config and delegates — and
this engine underneath does the actual work. A project with **no shim at
all** can call this engine directly: the plugin ships it at
`${CLAUDE_PLUGIN_ROOT}/skills/retire-worktree/scripts/retire-worktree.sh`.
`orch` calls a project shim with `RETIRE_ENGINE` set to that path, so a shim
can delegate with `exec "$RETIRE_ENGINE" "$@"`; the engine itself does not
read `RETIRE_ENGINE`.

## Overrides

Same precedence rule as `create-worktree`: **environment, then
`<project root>/.orch`, then the convention/default.**

| Variable | What it does | Default / convention | Read from |
|---|---|---|---|
| `WORKTREE_ROOT` | Where worktrees live on disk — must agree with `create-worktree`'s value for the same project. | `<project root>/code` | environment, `.orch` |
| `RETIRE_HOOK` | Project's own teardown script, replacing this engine's own DDEV-delete step (4) if it exits 0. Exit 3 is reserved for a delegate shim and runs the engine's DDEV step. Other nonzero exits refuse for repair and retry. The Herdr close (step 3) and git-level teardown (step 5) always stay with the engine. | conventional `<worktree>/scripts/retire-worktree.sh` | environment, `.orch`, convention |
| `RETIRE_WORKTREE_IN_HOOK` | Set to `1` by the engine itself when invoking a resolved retire hook; not meant to be set by callers. If already set when the engine starts, it refuses immediately (exit 3) — this is what makes re-entry via a delegate-shim hook safe. | unset | environment (engine-internal) |
| `BASE_BRANCH` (`reap-worktrees.sh` only) | Branch checked for "has this landed". | **No fallback default** — env, then `.orch`; refuses (non-zero, reaps nothing) if neither resolves | environment, `.orch` |
| `REMOTE` (`reap-worktrees.sh` only) | Remote checked for "has this landed". | `origin` | environment only |

## Conventions (no configuration required)

- **Retire hook**: `<worktree>/scripts/retire-worktree.sh`, run with cwd set
  to the still-existing worktree, before it's removed, whenever
  `RETIRE_HOOK` doesn't resolve to something else first.
- `reap-worktrees.sh` needs no per-project convention beyond `WORKTREE_ROOT`
  agreeing with the create side — it calls the sibling
  `retire-worktree.sh` for anything landed, which then resolves its own
  `RETIRE_HOOK` the normal way.

## Adopting this on a new project

1. **Nothing to create beyond `.orch`.** Both engines read the same `.orch`
   (written by `setup-project`), so they agree on `WORKTREE_ROOT` and
   `PROJECT_NAME` with no extra setup.
2. **Add a shim only for project-specific teardown** — a `RETIRE_HOOK`, or
   anything else that varies per project. Otherwise call the global engine
   directly.

## Tests

`tests/run-all.sh` (in the `create-worktree` skill) runs this skill's two
suites (`retire-worktree.test.sh`, `reap-worktrees.test.sh`) alongside
`create-worktree`'s own, and prints one combined verdict. **These suites are
manual: nothing in CI runs them** — run `bash
../create-worktree/tests/run-all.sh` (or this skill's own test files
directly) after changing either engine, before relying on the change.
