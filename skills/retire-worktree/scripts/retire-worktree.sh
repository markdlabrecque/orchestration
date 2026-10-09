#!/usr/bin/env bash
set -uo pipefail

# Generic worktree-teardown engine (worktree-promotion-spec.md). This is the
# GLOBAL, project-agnostic half of a base/override pair -- see this skill's
# SKILL.md and create-worktree/SKILL.md for the two-layer model. A project
# with no shim at all still works: project config comes from the shared
# resolver (scripts/orch-project.sh), and RETIRE_HOOK is entirely optional.
#
# Retire a finished worktree: close its Herdr workspace, delete its DDEV
# project (or hand that to a project's RETIRE_HOOK, if one resolves), remove
# the worktree, and delete its local branch. The Herdr close is the engine's
# own step (outside --ddev-only), hook or not. Failures leave teardown pending.
# `orch` closes a ticket's platform itself and sets ORCH_RETIRE_MANAGED=1
# to skip the engine's Herdr step.
#
# Usage: retire-worktree.sh <id> [--force] [--ddev-only]
#
# <id> is the worktree directory name. Run it from anywhere inside the
# project root, including the worktree being retired. Flags may appear in
# any order after <id>.
#
# --force skips the uncommitted-work check (step 2) and lets git discard it
# anyway.
#
# --ddev-only skips Herdr discovery, runs steps 1, 2 and 4 (worktree lookup,
# retire-hook resolution,
# the uncommitted-work check, then the DDEV delete or the retire hook) and
# stops with exit 0, leaving the worktree checkout and its branch in place
# for the caller's platform to remove (e.g. `orca worktree rm`). Combinable
# with --force; without it a dirty worktree still refuses with exit 2.
# Saved workspace obligations from earlier direct calls must still close.
#
# Every step below is destructive and none of it is recoverable outside git's
# own reflog, so the order matters.
#
# This script deliberately does NOT check whether the branch has landed
# anywhere -- direct invocation trusts the caller on merge state. The one
# real gate for "has this branch landed" is reap-worktrees.sh's
# branch_has_landed.
#
# The optional project retire hook (PROVISION_HOOK's counterpart on the
# teardown side): RETIRE_HOOK in the environment, then RETIRE_HOOK in
# <project root>/.orch, then the conventional
# <worktree>/scripts/retire-worktree.sh. When one resolves, it runs with cwd
# set to the still-existing worktree, BEFORE the worktree is removed, and
# REPLACES this engine's own DDEV-delete step (step 4) only. The Herdr
# close (step 3) runs before it from the engine itself either way, and the
# git-level teardown (step 5: `git worktree remove` plus the branch delete)
# runs only after adapter success, since only the engine has the main checkout's
# context once the worktree directory is gone. A project with no retire hook
# anywhere is not required to have one -- the engine's own step 4 runs.
#
# Self-workspace deferral: if the resolved Herdr workspace id equals
# $HERDR_WORKSPACE_ID (the agent is retiring the worktree it is running
# in), closing it in step 3 would kill the agent's own pane -- and this
# script with it -- before steps 4-6 ever run. In that case the close is
# deferred until steps 4 (ddev) and 5 (git worktree + branch removal) finish.
# Step 6 reports success only after the deferred close succeeds.
# A different or unset $HERDR_WORKSPACE_ID closes in step 3 as before. The
# deferred workspace identity is saved outside the checkout for retry. A
# failed close exits 4, even when git teardown has already succeeded.
#
# Exit codes: 1 = usage/refusal (bad args, missing/escaping path), 2 = dirty
# worktree without --force, 3 = re-entered from its own retire hook (see
# below), 4 = incomplete adapter, hook, recovery or git teardown.
#
# Re-entry guard: the conventional <worktree>/scripts/retire-worktree.sh hook
# is frequently a thin delegate shim that execs straight back into this
# engine. When this engine invokes a resolved hook it exports
# RETIRE_WORKTREE_IN_HOOK=1 into the hook's environment; if this engine ever
# sees that variable already set, it knows it has been re-entered from its
# own hook rather than invoked directly, refuses immediately (exit 3), and
# touches nothing. The OUTER invocation captures the hook's exit code: 0
# means the hook handled step 4 (DDEV delete). Exit 3 identifies a delegate
# shim and runs the engine's own step 4. Other nonzero exits refuse teardown;
# repair the hook and retry. Hook edits are ordinary uncommitted work.

if [ "${RETIRE_WORKTREE_IN_HOOK-}" = "1" ]; then
  echo "retire-worktree: re-entered from its own retire hook (the hook is a delegate shim back to this engine); refusing." >&2
  exit 3
fi

id="${1:-}"
force=0
ddev_only=0
shift || true
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    --ddev-only) ddev_only=1 ;;
  esac
done

if [ -z "$id" ]; then
  echo "usage: $(basename "$0") <id> [--force] [--ddev-only]" >&2
  exit 1
fi

if ! [[ "$id" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "retire-worktree: id must be lowercase letters, digits and hyphens: $id" >&2
  exit 1
fi

ORCH_PROJECT_LIB="${ORCH_PROJECT_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)/scripts/orch-project.sh}"
# shellcheck source=../../../scripts/orch-project.sh
. "$ORCH_PROJECT_LIB"

orch_resolve "$PWD" || exit 1
main_repo="$MAIN_CHECKOUT"
# Never stand inside the worktree being removed.
cd "$ORCH_ROOT" || exit 1

# Persist exact git identity before adapters can destroy anything. The record
# survives checkout removal, including interruption before branch deletion.
progress="$(dirname "$ORCH_PROJECT_LIB")/retirement-progress.py"
# On Linux, the inherited lock also covers an engine whose orch parent died.
# Keep it in git metadata, not in the directory being removed.
if command -v flock >/dev/null 2>&1; then
  common="$(git -C "$main_repo" rev-parse --git-common-dir)" || exit 4
  case "$common" in /*) ;; *) common="$main_repo/$common" ;; esac
  mkdir -p "$common/orch-retirement" || exit 4
  exec 9>"$common/orch-retirement/$id.lock" || exit 4
  flock -n 9 || { echo "retire-worktree: teardown already running for $id; retry later." >&2; exit 4; }
fi
identity="$(python3 "$progress" prepare "$main_repo" "$id" "${ORCH_RETIRE_PATH:-}")" || exit $?
mapfile -t identity_lines <<< "$identity"
worktree="${identity_lines[0]}"
branch="${identity_lines[1]}"
stage="${identity_lines[2]}"
saved_workspace="${identity_lines[3]:-}"
workspace_absent() {
  local target="$1" worktrees workspaces
  worktrees="$(herdr worktree list 2>/dev/null)" || return 1
  workspaces="$(herdr workspace list 2>/dev/null)" || return 1
  printf '%s' "$worktrees" | jq -e --arg id "$target" \
    '(.result.worktrees | type == "array") and ([.result.worktrees[] | select(.open_workspace_id == $id)] | length == 0)' >/dev/null 2>&1 || return 1
  printf '%s' "$workspaces" | jq -e --arg id "$target" \
    '(.result.workspaces | type == "array") and ([.result.workspaces[] | select(.workspace_id == $id)] | length == 0)' >/dev/null 2>&1
}
close_workspace() {
  local target="$1"
  if ! command -v herdr >/dev/null 2>&1 || { ! herdr workspace close "$target" >/dev/null 2>&1 && ! workspace_absent "$target"; }; then
    echo "retire-worktree: failed to close herdr workspace $target for $worktree; repair Herdr and re-run retire-worktree.sh $id." >&2
    return 4
  fi
  python3 "$progress" closed "$main_repo" "$id" "$worktree" || return $?
  echo "retire-worktree: herdr workspace $target closed."
}
finish_git() {
  local flags=()
  if [ "$force" -eq 1 ]; then flags+=(--force); fi
  python3 "$progress" finish "$main_repo" "$id" "$worktree" "${flags[@]}"
}
if [ ! -e "$worktree" ]; then
  if [ -n "$saved_workspace" ]; then close_workspace "$saved_workspace" || exit $?; fi
  if [ "$ddev_only" -ne 1 ]; then finish_git || exit $?; fi
  echo "retire-worktree: recovered teardown of $worktree."
  exit 0
fi

# --- Resolve the optional project retire hook -------------------------------
#
# Resolve before checking dirtiness, but preserve hook edits just like any
# other tracked or untracked work.
resolve_retire_hook() { # -> prints path, rc0 if found
  local val
  val="$(orch_get "$ORCH_ROOT" RETIRE_HOOK)"
  if [ -n "$val" ]; then
    orch_abs "$ORCH_ROOT" "$val"
    return 0
  fi
  if [ -f "$worktree/scripts/retire-worktree.sh" ]; then
    printf '%s' "$worktree/scripts/retire-worktree.sh"
    return 0
  fi
  return 1
}

retire_hook=""
retire_hook="$(resolve_retire_hook)" || retire_hook=""

# --- Step 2: uncommitted work -----------------------------------------------
if dirty="$(git -C "$worktree" status --porcelain --untracked-files=all 2>&1)"; then
  status_failed=0
else
  status_failed=$?
  echo "retire-worktree: git status failed in $worktree (exit $status_failed); treating as dirty for safety." >&2
  : "${dirty:=git status exited $status_failed with no output}"
fi

if [ -n "$dirty" ] && [ "$force" -ne 1 ]; then
  echo "retire-worktree: $worktree has uncommitted work; refusing without --force:" >&2
  printf '%s\n' "$dirty" >&2
  exit 2
fi

echo "retire-worktree: retiring $id at $worktree."

# --- Step 3: close the Herdr workspace, BEFORE the DDEV step / retire hook
#     and BEFORE the worktree is removed. Always the engine's own job (a
#     retire hook does not replace it); discovery skipped under --ddev-only.
#     UNLESS the resolved workspace is the caller's own (workspace_id ==
#     $HERDR_WORKSPACE_ID, non-empty): closing it here would kill the
#     agent's own pane -- and this script with it -- before steps 4-6 ever
#     run. In that case defer_own_close is set and the actual close is
#     pushed after git teardown, before the success report. ---------------
workspace_id="$saved_workspace"
defer_own_close=0
# A previous direct call may have left a workspace obligation. A different
# invocation mode must not erase it when handing deletion to its adapter.
if [ -n "$saved_workspace" ] && { [ "$ddev_only" -eq 1 ] || [ "${ORCH_RETIRE_MANAGED:-0}" = 1 ]; }; then
  close_workspace "$saved_workspace" || exit $?
fi
if [ "$ddev_only" -ne 1 ] && [ "${ORCH_RETIRE_MANAGED:-0}" != 1 ]; then
  if command -v herdr >/dev/null 2>&1; then
    wt_json="$(herdr worktree list 2>/dev/null)" || {
      echo "retire-worktree: cannot inspect Herdr worktrees for $worktree; repair Herdr and retry." >&2
      exit 4
    }
    if ! printf '%s' "$wt_json" | jq -e '.result.worktrees | type == "array"' >/dev/null 2>&1; then
      echo "retire-worktree: invalid Herdr worktree response for $worktree; repair Herdr and retry." >&2
      exit 4
    fi
    if [ -z "$workspace_id" ]; then
      workspace_id="$(printf '%s' "$wt_json" | jq -r --arg p "$worktree" \
        '.result.worktrees[] | select(.path==$p) | .open_workspace_id // empty' 2>/dev/null | sed -n '1p')"
    fi

    if [ -z "${workspace_id:-}" ]; then
      ws_json="$(herdr workspace list 2>/dev/null)" || {
        echo "retire-worktree: cannot inspect Herdr workspaces for $worktree; repair Herdr and retry." >&2
        exit 4
      }
      if ! printf '%s' "$ws_json" | jq -e '.result.workspaces | type == "array"' >/dev/null 2>&1; then
        echo "retire-worktree: invalid Herdr workspace response for $worktree; repair Herdr and retry." >&2
        exit 4
      fi
      workspace_id="$(printf '%s' "$ws_json" | jq -r --arg p "$worktree" \
        '.result.workspaces[] | select(.worktree.checkout_path==$p) | .workspace_id // empty' 2>/dev/null | sed -n '1p')"
    fi

    if [ -n "$workspace_id" ]; then
      ORCH_RETIRE_WORKSPACE="$workspace_id" python3 "$progress" workspace "$main_repo" "$id" "$worktree" || exit $?
    fi
    if [ -n "${workspace_id:-}" ] && [ -n "${HERDR_WORKSPACE_ID:-}" ] && [ "$workspace_id" = "${HERDR_WORKSPACE_ID:-}" ]; then
      defer_own_close=1
      echo "retire-worktree: $workspace_id is the caller's own workspace; deferring its close until after teardown (defer)."
    elif [ -n "${workspace_id:-}" ]; then
      close_workspace "$workspace_id" || exit $?
    else
      echo "retire-worktree: no herdr workspace found for $worktree."
    fi
  elif [ -n "$saved_workspace" ]; then
    echo "retire-worktree: herdr not on PATH for pending workspace $saved_workspace at $worktree; repair PATH and retry." >&2
    exit 4
  else
    echo "retire-worktree: herdr not on PATH, skipping workspace close."
  fi
fi

# --- Step 4: delete the DDEV project, from inside the still-existing
#     worktree. Factored into a function so it can run either as the
#     engine's default behaviour, or for a delegate shim identified by exit
#     3. Other hook failures refuse rather than fall back. Sets ddev_project. --
run_own_teardown() {
  ddev_project=""
  if [ -f "$worktree/.ddev/config.local.yaml" ]; then
    ddev_project="$(
      sed -n 's/^name:[[:space:]]*//p' "$worktree/.ddev/config.local.yaml" |
        tail -n 1 |
        tr -d '\r' |
        sed -e "s/^['\"]//" -e "s/['\"]\$//"
    )"
  fi
  ddev_project="${ddev_project:-$(ddev_project_name "$id" "$PROJECT_NAME")}"
  # The main checkout's DDEV project is named <PROJECT_NAME>. A worktree
  # carrying that name (copied config, hand edit) must never delete it.
  if [ "$ddev_project" = "$PROJECT_NAME" ]; then
    echo "retire-worktree: $worktree is registered as '$ddev_project', the main checkout's DDEV project; refusing to delete it." >&2
    return 4
  elif command -v ddev >/dev/null 2>&1; then
    if [ -d "$worktree/.ddev" ]; then
      if ( cd "$worktree" && ddev delete -yO ) >/dev/null 2>&1; then
        echo "retire-worktree: DDEV project $ddev_project deleted."
      else
        echo "retire-worktree: failed to delete DDEV project $ddev_project; retry when DDEV is available." >&2
        return 4
      fi
    else
      echo "retire-worktree: no .ddev directory in $worktree, skipping DDEV delete."
    fi
  elif [ -d "$worktree/.ddev" ]; then
    echo "retire-worktree: ddev not on PATH for $worktree; install DDEV or repair PATH and retry." >&2
    return 4
  else
    echo "retire-worktree: no .ddev directory, skipping DDEV delete."
  fi
}

if [ "$stage" = ready ]; then
  ddev_project="(previously removed)"
elif [ -n "$retire_hook" ]; then
  echo "retire-worktree: delegating DDEV teardown to $retire_hook."
  ( cd "$worktree" && RETIRE_WORKTREE_IN_HOOK=1 "$retire_hook" )
  hook_rc=$?
  if [ "$hook_rc" -eq 0 ]; then
    ddev_project="(handled by $retire_hook)"
  elif [ "$hook_rc" -eq 3 ]; then
    echo "retire-worktree: delegate shim $retire_hook; running the engine's own DDEV step." >&2
    run_own_teardown || exit $?
  else
    echo "retire-worktree: retire hook $retire_hook failed (exit $hook_rc); repair it and retry." >&2
    exit 4
  fi
else
  run_own_teardown || exit $?
fi
python3 "$progress" ready "$main_repo" "$id" "$worktree" || exit $?

if [ "$ddev_only" -eq 1 ]; then
  # The hook may have written new work. Check again before handing deletion
  # to an external adapter, just as finish_git does for plain git teardown.
  dirty="$(git -C "$worktree" status --porcelain --untracked-files=all 2>&1)" || {
    echo "retire-worktree: git status failed after teardown in $worktree; refusing." >&2
    exit 4
  }
  if [ -n "$dirty" ] && [ "$force" -ne 1 ]; then
    echo "retire-worktree: $worktree has uncommitted work after teardown; refusing." >&2
    exit 2
  fi
  echo "retire-worktree: --ddev-only: left the worktree and branch in place."
  echo "retire-worktree:   DDEV project: $ddev_project"
  echo "retire-worktree:   path: $worktree"
  exit 0
fi

# --- Step 5: remove the worktree and branch, from the main checkout --------
if ! finish_git; then
  echo "retire-worktree: git worktree remove failed for $worktree; branch left untouched." >&2
  if [ "$defer_own_close" -eq 1 ]; then
    echo "retire-worktree: herdr workspace $workspace_id (the caller's own) was left open — its close was deferred until after teardown, which did not complete. Fix the removal failure above, then re-run retire-worktree.sh to finish the teardown and close it." >&2
  fi
  exit 4
fi

branch_report="${branch:-none (detached worktree)} (removed or already absent)"

# --- Deferred step 3: identity survives checkout deletion for retry. ---------
if [ "$defer_own_close" -eq 1 ]; then
  close_workspace "$workspace_id" || exit $?
fi

# --- Step 6: final report ----------------------------------------------------
echo "retire-worktree: done."
if [ "$defer_own_close" -eq 1 ]; then
  echo "retire-worktree:   workspace: $workspace_id (closed last: caller's own workspace)"
elif [ -n "$workspace_id" ]; then
  echo "retire-worktree:   workspace: $workspace_id"
else
  echo "retire-worktree:   workspace: none closed"
fi
echo "retire-worktree:   DDEV project: $ddev_project"
echo "retire-worktree:   path: $worktree"
echo "retire-worktree:   branch: $branch_report"
