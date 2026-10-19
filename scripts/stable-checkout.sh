# Sourced after the caller changes to its resolved package directory.
orch_require_stable_checkout() {
  local git_dir common branch
  git_dir=$(git rev-parse --absolute-git-dir)
  common=$(git rev-parse --path-format=absolute --git-common-dir)
  branch=$(git symbolic-ref --quiet --short HEAD) || {
    printf '%s\n' 'Use a stable checkout on a named branch, not detached HEAD.' >&2
    return 1
  }
  if [[ "$git_dir" != "$common" ]]; then
    printf '%s\n' 'Use a stable checkout (a dedicated clone), not a linked ticket worktree.' >&2
    return 1
  fi
  if [[ "$branch" =~ (^|/)([0-9]+|issue-[0-9]+|ticket-[0-9]+)([-/].*)?$ || "$branch" == t3/* ]]; then
    printf '%s\n' 'Use a stable checkout branch, not a ticket branch.' >&2
    return 1
  fi
}
