#!/usr/bin/env bash
set -euo pipefail

# Write <project root>/.orch with every key at its default, derived from the
# folder layout, and create the orch state folder.
#
#   setup-project.sh [--force] [--relocate-checkout]
#
# Run from anywhere inside $ORCH_PROJECTS_DIR/<project> (default ~/Projects).
# A root checkout moves into code/main only with --relocate-checkout. Environment
# overrides are ignored: the template records the layout's own defaults.
# Refuses when .orch exists unless --force is given.

LIB="${ORCH_PROJECT_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)/scripts/orch-project.sh}"
# shellcheck source=../../../scripts/orch-project.sh
. "$LIB"

force=0
relocate=0
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    --relocate-checkout) relocate=1 ;;
    *) echo "usage: $(basename "$0") [--force] [--relocate-checkout]" >&2; exit 1 ;;
  esac
done

root="$(orch_project_root "$PWD")"
orch="$root/.orch"

if { [ -e "$orch" ] || [ -L "$orch" ]; } && [ "$force" -ne 1 ]; then
  echo "setup-project: $orch already exists. Re-run with --force to overwrite it." >&2
  exit 1
fi

refuse() {
  echo "setup-project: $*" >&2
  exit 1
}

# Validate retained paths before writing through them, including dangling links.
[ ! -L "$orch" ] || refuse "symlinked .orch is unsafe."
[ ! -e "$orch" ] || [ -f "$orch" ] || refuse ".orch must be a regular file."
for retained in "$root/.agents" "$root/.agents/orchestration"; do
  [ ! -L "$retained" ] || refuse "symlinked $retained is unsafe."
  [ ! -e "$retained" ] || [ -d "$retained" ] || refuse "$retained must be a directory."
done

moving=0
if [ -e "$root/.git" ] || [ -L "$root/.git" ]; then
  [ "$(pwd -P)" = "$root" ] || refuse "invoke from the project root to use --relocate-checkout."
  [ "$relocate" -eq 1 ] || refuse "root checkout requires explicit --relocate-checkout approval; --force only overwrites config."
  [ ! -L "$root/.git" ] && [ -d "$root/.git" ] || refuse "relocation requires a real .git directory, not a symlink or linked worktree."
  [ ! -e "$root/code" ] && [ ! -L "$root/code" ] || refuse "code already exists; refusing to merge or replace it."
  [ ! -e "$root/.git/worktrees" ] || refuse "checkout has linked worktrees; relocation would break their metadata."
  [ ! -e "$root/.git/objects/info/alternates" ] || refuse "checkout uses alternate object storage; relocation is unsafe."
  [ -z "$(git -C "$root" config --get core.worktree || true)" ] || refuse "checkout has core.worktree configured; relocation is unsafe."
  moving=1
  main="$root"
else
  main="$(orch_find_main_checkout "$root/code" 2>/dev/null)" || {
    refuse "no single main checkout in $root/code. Clone the repository into $root/code/ first."
  }
fi

base="$(git -C "$main" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
base="${base#origin/}"

# Roll back only our moves and empty directories. Never delete checkout data.
tmp=""
created_code=0
created_agents=0
created_state=0
committed=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -eq 0 ]; then
    if [ "$created_code" -eq 1 ]; then
      for entry in "$root/code/main"/* "$root/code/main"/.[!.]* "$root/code/main"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        name="${entry##*/}"
        if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then
          echo "setup-project: rollback conflict for $entry; data retained there." >&2
          status=1
        else
          mv "$entry" "$root/$name" || status=1
        fi
      done
      rmdir "$root/code/main" "$root/code" 2>/dev/null || status=1
    fi
    [ "$created_state" -eq 0 ] || rmdir "$root/.agents/orchestration" 2>/dev/null || status=1
    [ "$created_agents" -eq 0 ] || rmdir "$root/.agents" 2>/dev/null || status=1
  fi
  [ -z "$tmp" ] || rm -f "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$moving" -eq 1 ]; then
  mkdir "$root/code"
  created_code=1
  mkdir "$root/code/main"
  for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in code|.orch|.agents) continue ;; esac
    mv "$entry" "$root/code/main/"
  done
  main="$root/code/main"
fi

tmp="$(mktemp "$root/.orch.XXXXXX")"
cat > "$tmp" <<ORCH
# Orchestration config for this project. Relative paths resolve against this folder.
PROJECT_NAME=$(basename "$root")
MAIN_CHECKOUT=code/$(basename "$main")
WORKTREE_ROOT=code
BASE_BRANCH=$base
ACCESSIBILITY_TESTS=false
# Optional. Uncomment to use.
# DB_DUMP=
# PROVISION_HOOK=
# RETIRE_HOOK=
ORCH
if [ ! -d "$root/.agents" ]; then
  mkdir "$root/.agents"
  created_agents=1
fi
if [ ! -d "$root/.agents/orchestration" ]; then
  mkdir "$root/.agents/orchestration"
  created_state=1
fi
mv "$tmp" "$orch"
committed=1

echo "setup-project: wrote $orch."
if [ -z "$base" ]; then
  echo "setup-project: could not read origin/HEAD in $main. Set BASE_BRANCH in $orch before creating worktrees." >&2
fi
