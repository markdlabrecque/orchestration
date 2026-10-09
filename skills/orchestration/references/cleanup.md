# Completed-ticket cleanup

`orch reconcile` is a deterministic one-shot pass, not an agent session. It only retires tickets already in `done` with no retirement timestamp. It never merges, verifies, resumes or dispatches work. Main startup also runs a project-restricted pass before recovering unfinished sessions and dispatching.

## Explicit user timer installation

Linux with a running systemd user manager is required. From a stable checkout that will remain on disk:

```sh
scripts/install-local cleanup install --projects-dir "$HOME/Projects"
scripts/install-local cleanup status
scripts/install-local cleanup disable
scripts/install-local cleanup uninstall
```

Ordinary harness installs never enable cleanup. The separate install action writes `orch-cleanup.service` and `orch-cleanup.timer` under `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, reloads the user manager and enables the timer. It runs about five minutes after the previous pass ends and catches up one minute after the user manager starts. It runs while your user manager is active, not as a root service. No lingering is enabled.

The service references this checkout's absolute `scripts/orch` path. Reinstall cleanup from the new stable checkout if you move it. Its PATH defaults to `~/.local/bin:/usr/local/bin:/usr/bin:/bin`. Supply `--adapter-path /absolute/bin:/usr/bin:/bin` when git, DDEV, Orca or Herdr lives elsewhere. Each ticket's recorded platform chooses its adapter, not the service's headless environment. Paths with spaces, percent signs, dollar signs and backslashes are escaped as systemd values.

`disable` stops the timer and any current service invocation, but keeps unit files. `uninstall` also removes the two owned unit files and reloads the manager. Foreign files and symlinks are refused. `--unit-name NAME` selects an isolated pair for disposable testing; it does not authorize cleanup of other projects.

## Discovery and outcomes

Without `--project`, discovery examines only direct children of `ORCH_PROJECTS_DIR`, default `~/Projects`. Both `.orch` and `.agents/orchestration/state.db` must already exist. A malformed project is reported without stopping other projects. `--project /absolute/project` restricts the pass to that project. Invoking-session state and checkout overrides do not redirect per-project state.

```sh
scripts/orch reconcile --project /absolute/project --json
journalctl --user -u orch-cleanup.service --no-pager -n 100
systemctl --user start orch-cleanup.service
```

Every attention outcome includes project, ticket, worktree and reason in the journal. A best-effort `notify-send` alert supplements the journal. Identical failures are deduplicated across processes using `cleanup-notifications.json` beside the database. Failed notification delivery is retried on the next pass; journal output is never suppressed. A changed failure or a successful recovery permits a later alert.

The service limits a pass to twenty minutes; individual retirement engines have a five-minute bound and adapter calls have their own timeouts. Remaining tickets retry on a later tick. A live retirement owner cannot be displaced because its marker is old. The engine also holds a per-worktree lock while teardown runs.

## Repair and retry

- Dirty tracked or untracked files, including hook edits, block deletion. Preserve or commit that work deliberately before retrying. Automatic cleanup never forces git or adapter removal. Existing ignored provisioning files retain the retirement engine's normal treatment.
- Adapter, session-close, trust-config and git failures leave retirement pending. Restore the named tool or repair its reported failure, then rerun the restricted pass. Missing resources count as removed only when absence is observable.
- Git identity and teardown progress live under the main repository's common git directory in `orch-retirement/<worktree-id>.json`. This lets a later pass finish branch deletion after checkout removal without guessing a branch name. Keep these records during recovery. A changed branch/HEAD, ambiguous worktree identity or missing checkout before confirmed adapter teardown refuses and needs human investigation. Never delete a record just to bypass that refusal.
- Desktop needs its session archive tool, unavailable in a user service. Automatic cleanup leaves the ticket and worktree pending and reports `orch retire <ticket>`. Run that command from a main Desktop session and execute the returned `desktop_archive` action. Retain its returned ref until archival succeeds. Repeated timer passes do not silently complete or repeatedly alert for the same pending archive.

Ticket sessions and stage agents never retire themselves. Cleanup belongs to main or the explicitly enabled user timer.
