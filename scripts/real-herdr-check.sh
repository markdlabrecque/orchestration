#!/usr/bin/env bash
# MANUAL check, not run in CI: drives the real orch-herdr adapter against a REAL Herdr
# (0.9.1) in a disposable NAMED session. Never touches the default session.
# Usage: scripts/real-herdr-check.sh [session-name]
# Requires: herdr on PATH with a server already running for the named session
# (this script does not start one), and a git repo as the current directory.
set -euo pipefail

# Clear any inherited Herdr context so nothing can leak into the default session.
for v in $(env | grep -o '^HERDR_[A-Z_]*' || true); do unset "$v"; done

SESSION="${1:-orch-check-$$}"
case "$SESSION" in default|"") echo "refusing session '$SESSION'" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(git rev-parse --show-toplevel)"
TICKET="check$$"
WT="$(dirname "$REPO")/$(basename "$REPO")-ticket-$TICKET"
ORCH_HERDR="$ROOT/bin/orch-herdr"

echo "session=$SESSION repo=$REPO worktree=$WT"
herdr --session "$SESSION" worktree list --cwd "$REPO" >/dev/null || { echo "no server for session $SESSION" >&2; exit 1; }

echo "== run (start only, stopped after a few seconds) =="
timeout 15 "$ORCH_HERDR" run "$TICKET" --session "$SESSION" --worktree-path "$WT" --interval 1000 || true
herdr --session "$SESSION" worktree list --cwd "$REPO"

echo "== release (clean tree should be removed; a dirty one must print dirty_worktree_requires_force) =="
"$ORCH_HERDR" release "$TICKET" --session "$SESSION"
herdr --session "$SESSION" worktree list --cwd "$REPO"
echo "done; stop the disposable session yourself"
