# `orch` state CLI

`orch` is the plugin's state script: `scripts/orch` (`${CLAUDE_PLUGIN_ROOT}/scripts/orch` in Claude Code), Python 3.9+ standard library only. It is the only writer of ticket state. Agents read state through it before every decision and never edit the database by hand.

`orch` does not need to own a session's process to watch it. The plugin's hooks report every session's activity to `orch` (see "Hooks"), so a session started by `orch`, Orca, Herdr, Claude Desktop or a person typing `claude` is tracked the same way.

## Where state lives

State lives in the **project root** under `.agents/orchestration/`, outside any git repository. The project root is the folder directly under `ORCH_PROJECTS_DIR` (default `~/Projects`) that holds the cwd, so `orch` runs from the project root, the main checkout or any worktree. A worktree outside the project root is traced through its main checkout (`git rev-parse --git-common-dir`). `ORCH_HOME` overrides the directory (used by tests).

The project root also holds `.orch` (written by the `setup-project` skill). `orch` reads `BASE_BRANCH` and `MAIN_CHECKOUT` from it: environment first, then `.orch`. Without `MAIN_CHECKOUT`, the main checkout is the one folder in `WORKTREE_ROOT` (default `code`) whose `.git` is a directory.

| Path | Holds |
|---|---|
| `state.db` (+ `-wal`, `-shm`) | SQLite store: tickets, the append-only event log and the stage-agent runs ("Model routing") |
| `logs/<ticket>.log` | Output of headless ticket sessions (appended across attempts) |
| `briefs/<ticket>.md`, `briefs/<ticket>.resume.md` | Prompt given to the session by `spawn` / `resume` |
| `config.json` | Optional project settings (below) |

SQLite runs in WAL mode with a busy timeout. Every command is one transaction, so a killed process leaves either the old state or the new one, never half. Writes take `BEGIN IMMEDIATE`; read-only commands (`list`, `show`, `next`, `stale`, `events`, `route`, `runs`, `platform`, `watch`) use a plain deferred read. `spawn`, `resume`, `retire` and baseline refresh are exceptions: they never hold the write lock while a platform command or worktree engine runs, and hold the ticket's in-flight marker instead (see "Launching sessions"). Older databases gain new columns and tables (`bounces`, `runs`) automatically on first use.

## STATE.md synchronization

SQLite is authoritative. `<project root>/STATE.md` is a deterministic projection of committed workflow data, not another state store. If no project root resolves and `ORCH_HOME` is set, the file lives there. Read or change ticket state through `orch`; rebuilding the document does not change workflow decisions or call a provider/platform.

```sh
orch state-md check --json
orch state-md rebuild --json
```

`check` returns `{"fresh": true}` and exit 0 only when the managed bytes match the current committed revision and all observed retained legacy tails. Missing, stale, tampered or malformed content returns `{"fresh": false}` and exit 3 without repairing the file. `rebuild` publishes the current committed snapshot and returns `{"fresh": true}` on success. Rebuilding unchanged data preserves identical bytes and stored timestamps.

The generated section has two ownership delimiters, each on its own line:

```text
<!-- orch:state-md begin -->
... generated workflow records ...
<!-- orch:state-md end -->
```

Keep human notes outside those delimiters. Initial migration retains every byte of a legacy document, including its old activity log, and adds the managed section after it. Later replacements preserve text outside the section. Missing, duplicate, reversed or malformed delimiters refuse replacement rather than guessing which text can be removed. Retain the file and investigate the ownership damage before retrying; repeated rebuilds cannot resolve ambiguous ownership.

The snapshot starts with a compact recorded-ticket table and activity history ordered by stored event sequence. Detailed JSON rows follow for tickets ordered by ID, events, stage runs, CI evidence and shared baseline records. Together these expose phase, phase-derived status, attempt, retirement, recorded activity and observation time, lifecycle reservations, and recorded recovery/completion evidence. It does not probe live health, infer a current subtask, or classify run outcomes. `selftest-*` tickets and their associated events, runs and CI rows are excluded. Synthetic-only changes do not advance the source revision.

A transactional source revision tracks inserts, updates and deletes, including changes without an event. SQLite triggers also observe writes by older sibling processes. The document records that revision and the event watermark; matching managed bytes are the publication acknowledgment. A process dying between commit and export leaves detectable stale content. A process dying after a complete replacement can leave an already-fresh file, with no second acknowledgment write required.

Successful write transactions publish after commit, including lifecycle intent before platform launch, compensation after failed launch, baseline reservations/results and hook updates. Publication never holds a SQLite write transaction. A stable `.STATE.md.lock` serializes publishers across file replacements. Each publisher captures a fresh committed snapshot and reads the current human text after obtaining that lock, writes and fsyncs a temporary file, atomically replaces STATE.md, then fsyncs the directory. Existing file permissions are retained. A waiting older publisher therefore cannot replace a newer snapshot with cached data.

Already-running legacy appenders lock the STATE.md inode, not `.STATE.md.lock`. Before replacement, the publisher also locks that inode and creates a hard link in `.STATE.md.legacy/`. Each link's name records its device, inode and pre-replacement byte length. The publisher fsyncs the old file and both directories before replacing STATE.md. An old appender that opened the file before replacement can still write to the retained inode after the publisher releases its lock.

Later `check` calls compare every retained tail with its rendered copy. A new tail makes the document stale; rebuild and automatic repair render it under "Retained legacy appends", separately from database activity. Raw bytes remain in the linked file; JSON strings in the projection escape marker-like text and preserve arbitrary bytes using UTF-8 surrogate escapes. The publisher fsyncs observed tails before publishing them. There is no consumed-offset acknowledgment to lose in a crash: each export reads the complete tail from the recorded original length. If a publisher dies before replacement, a link still pointing to the current inode is ignored during tail collection, and its original length is reset under the inode lock before the next replacement. Those bytes are already in the current document, so repair preserves them once.

Keep `.STATE.md.legacy/` with STATE.md in backups and recovery. Retention is indefinite and consumes disk space for replaced documents; there is no automatic pruning because an arbitrarily delayed old writer may still hold any replaced descriptor. Filesystems must support same-filesystem hard links and fsync. Failure to retain the old inode refuses replacement and reports synchronization failure. This protocol preserves cooperating legacy appenders; unrelated editors that replace or truncate files without the locks remain outside it. A legacy writer's own un-fsynced write can still be lost to a machine crash before any repair observes it, just as under the old helper.

Ordinary successful database commands, `init` and `watch` also reconcile stale output. Hooks reconcile even when an activity update is throttled. Commands that only inspect environment/platform configuration do not open the database and do not repair the document. `check` is the explicit non-repairing inspection path.

**Commit and export are separate.** A synchronization failure reports `database commit succeeded; STATE.md is stale or synchronization failed` on stderr. It retains the database commit and does not treat an export error as a failed launch or roll back lifecycle state. The ordinary CLI exits 3 after lifecycle cleanup; hooks retain exit 0 and expose the diagnostic on stderr. SQLite snapshot failures use the same controlled diagnostic, with any open read transaction released before lifecycle work continues. After fixing the reported filesystem, ownership or database-read problem, run `rebuild`, then `check`. Inspect committed state before retrying the original mutation: it may already have succeeded despite the nonzero exit.

## `config.json`

```json
{
  "max_workers": 3,
  "claude_args": ["--dangerously-skip-permissions"],
  "verify_policy": "auto",
  "verify_harness": "docker compose -f .agents/orchestration/verify.yml up -d",
  "stall_minutes": 20
}
```

Ticket sessions run unattended, so by default they skip permission prompts: without that, every push, merge and worktree command stops and waits. A project can set a narrower `claude_args` here. All keys are optional. Defaults: `max_workers` 3, `claude_args` as shown, `verify_harness` unset, `stall_minutes` 20. A `config.json` that is not a valid JSON object makes any command that reads it exit 3 with the path and parse error.

`verify_policy` is read only from this root state-directory `config.json`, with `ORCH_HOME` overriding the directory. Its exact accepted values are `auto` and `local-tests`; absence defaults to `auto`. Null, booleans, empty strings, wrong case and all other values refuse with exit 5 at preflight or spawn. Checkout/worktree config, `.orch`, environment policy variables and prose `AGENTS.md` do not override it.

`auto` preserves DDEV-first, Docker-second detection and missing-environment refusal. `local-tests` explicitly selects local automated tests even if containers exist, requiring no DDEV/Docker tool. All project-required automated tests, independent review and exact-head CI before merge remain required. The ticket pipeline goes from review to report without separate verify, browser or accessibility checks. Other preflight gates are unchanged.

`spawn` stores local-tests instructions in the brief before launch. Both continuable resume and fresh recovery replay that retained context rather than current config. Legacy callers without a verification environment still launch; preflight remains the missing-environment gate.

## Platforms

A **platform** is what hosts the sessions: `headless`, `orca`, `herdr` or `desktop`. The platform running the main orchestrator runs every ticket session it starts. Stage agents always run inside their ticket session.

`orch platform` prints the platform, first match wins: `ORCH_PLATFORM` (must be one of the four, else exit 2); the platform the environment shows: `HERDR_ENV=1` → `herdr`, `ORCA_TERMINAL_HANDLE` or `ORCA_WORKTREE_ID` set → `orca`, `CLAUDE_CODE_ENTRYPOINT=claude-desktop` → `desktop`; otherwise `headless`. Nothing is saved between calls (see [platforms.md](platforms.md) "Platform resolution").

Each ticket records the platform it was launched on. It keeps it while its session is alive. A ticket whose session is dead may be resumed on a different platform with `resume --platform`.

Binaries: `ORCH_CLAUDE_BIN` (default `claude`), `ORCH_ORCA_BIN` (default `orca`), `ORCH_HERDR_BIN` (default `herdr`). Claude's user config (folder trust, below): `ORCH_CLAUDE_JSON`, else `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`; tests always set `ORCH_CLAUDE_JSON` to a temp file.

## Harnesses

A **harness** is the agent CLI a session runs: `claude` (Claude Code), `pi` or `codex`. Ticket sessions run on the main orchestrator's harness. It is independent of the platform: any harness runs on `headless`, `orca` and `herdr`; `desktop` hosts `claude` only (anything else exits 3).

The harness is, first match wins: `--harness` on `spawn`, `resume` and `selftest`; `ORCH_HARNESS` (one of the three, else exit 2); detection from the environment the main orchestrator's shell inherits: `PI_CODING_AGENT=true` → `pi`, `CODEX_THREAD_ID` set → `codex`, `CLAUDECODE=1` → `claude` (when several are set, one harness started inside another, the nearest harness process above `orch` decides); the machine config's `harness` (`orch setup --harness`). With none, `claude` (source `default`). `orch platform` and `preflight` print `harness` and `harness_source`; `preflight` also checks the harness binary for `pi` and `codex`.

Each ticket records its harness (`harness`, null meaning `claude`). `resume` keeps it, or moves a dead ticket with `--harness`, which always starts a fresh session from the brief.

| | `claude` | `pi` | `codex` |
|---|---|---|---|
| Binary | `ORCH_CLAUDE_BIN` | `ORCH_PI_BIN` (default `pi`) | `ORCH_CODEX_BIN` (default `codex`) |
| Args from `config.json` | `claude_args` | `pi_args` (default `["--approve"]`) | `codex_args` (default `["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--enable", "hooks"]`) |
| Prompt prefix | `/orchestration:orchestration ` | `/skill:orchestration ` | `$orchestration:orchestration ` |
| Session id | chosen by `orch` | chosen by `orch` (`--session-id`, which also resumes) | chosen by Codex: null until the `SessionStart` hook names the thread |
| Headless start | `claude -p --session-id <sid> --output-format stream-json --verbose <args>` | `pi -p --mode json --session-id <sid> <args>` | `codex exec --json <args> -` |
| Headless resume | `claude -p --resume <sid> ...` | same as start | `codex exec resume --json <args> <thread> -` |
| Interactive (orca, herdr) | `claude --session-id\|--resume <sid> <args>` | `pi --session-id <sid> <args>` | `codex <args>`; resume: `codex resume <args> <thread>` |
| Hooks | `hooks/hooks.json` | `pi/extension.ts` (Pi package) | `hooks/hooks.json` (Codex plugin) |
| Folder trust (orca, herdr) | `~/.claude.json` | none needed | `$CODEX_HOME/config.toml` |

The skill is user-invoked only on every harness, so the prompt prefix loads it. The resume prompt carries it too on Pi and Codex (a session killed before its first turn was saved has no skill loaded); on Claude it is plain text, as before.

- **Pi** sets its process title to `pi`, so the session id is not on its command line: a headless launch records the start time (`pid_start`) with the pid. The Pi extension runs `orch hook` with `ORCH_HOOK_AGENT_PID` set to the Pi process. Subagent children (`PI_SUBAGENT_CHILD=1`) report `PostToolUse` under the parent session's id, as Claude's subagents do. A launch drops the `PI_SUBAGENT_*` and `ORCH_PI_PARENT_SESSION` variables from the child's environment. Stage agents carry no model and no thinking level: the dispatcher passes both on each `subagent` call, from `orch route` (see "Model routing").
- **Codex** picks its thread id. `spawn` records `session_id` null; the first `SessionStart` attaches the thread: on `headless` only from the process `orch` launched (the hook waits up to 3 s for step 3 to record its pid), on `orca`/`herdr` the first session to report in. A headless session killed before its hook ran is still found: `resume` reads the last `thread.started` line of the ticket's log. Resume continues the thread only when Codex saved it (`$CODEX_HOME/sessions/*/*/*/rollout-*-<thread>.jsonl`); otherwise it starts fresh from the brief. On `orca` and `herdr`, `orch` appends `[projects."<worktree realpath>"]` / `trust_level = "trusted"` to `$CODEX_HOME/config.toml` (default `~/.codex`) when the file has no table for that path, records it as `trust_codex` and a `trust_mark` event (detail `codex <path>`), and removes exactly that table on retire (Codex ignores `-c projects…` overrides for the trust dialog). The same signature-checked temp-file replace and retries as for Claude's config apply; a missing file is created.

## Phases

One `phase` per ticket. `status` is derived from it and never stored separately.

| Phase | Status | Set by |
|---|---|---|
| `ready` | ready | `orch add` |
| `dispatched` | in_progress | `orch spawn` |
| `spec`, `tests`, `implement`, `fix` | in_progress | ticket orchestrator via `orch phase` |
| `review` | in_review | ticket orchestrator |
| `verify`, `report`, `mr`, `ci` | verified | ticket orchestrator |
| `done` | done | `orch merged` only |
| `blocked` | blocked | `orch block` |

Allowed `orch phase` transitions (anything else exits 3):

```
dispatched -> spec
spec       -> tests | implement        (implement = skip lane: trivial or no-code)
tests      -> implement
implement  -> review
review     -> fix | verify | report    (report = no-code or local-tests lane)
fix        -> review | ci
verify     -> fix | report
report     -> mr
mr         -> ci
ci         -> fix | mr
```

- Entering `review` adds 1 to `review_rounds`.
- CI repairs do not count as review rounds. `fix -> ci` returns straight to CI after such a repair.
- `review -> fix` and `verify -> fix` share three successful bounces per ticket, persisted in `bounces`. A fourth exits 3 before dispatch. Budget exhaustion is checked before the last-implementor `frontier/high` gate, which may refuse earlier without consuming a bounce. Review entries have no cap.
- `ci -> fix` consumes one of two independent repairs, persisted in `ci_repairs`; a third exits 3. It changes neither `bounces` nor `review_rounds` and is not subject to the review frontier gate. `fix -> ci` consumes nothing.
- A successful repair transition consumes its slot even if dispatch never happens or the agent fails. Phase, counters and one phase event commit together under `BEGIN IMMEDIATE`. Illegal or retired transitions are checked first. Refusal leaves state and successful event history unchanged; it does not automatically block.
- After refusal, stop routing, recording and dispatching the requested fix. Retain the findings and explicitly `orch block <ticket> --reason "<budget or frontier gate>; findings: <link>"` for a human. A route read is not permission to bypass refusal. Follow-ups do not authorize declaring unresolved must-fix work complete.
- Neither budget resets on escalation, new agents, restart, resume/attach, block/unblock, or other phase edges. Routes and run records do not consume either budget. Record each implementor through `orch run` before dispatch; its `bounce_count` remains the current bounce snapshot.
- `done` is reachable only through `orch merged`.

## Durable budgets and legacy history

SQLite is authoritative. `orch show` exposes `bounces` and `ci_repairs` in text and JSON; JSON `null` means unknown, not zero. New tickets start with both counts known at zero. Existing bounce counts, review-entry history and run snapshots are preserved exactly, including over-cap counts.

On first addition of a missing budget column, a transactional migration counts successful `kind=phase` transitions into `fix` from the relevant origins. It requires an initial `add` event into `ready`, a continuous recorded phase chain and agreement with the current phase. Missing or detectably truncated history produces a durable unknown count. Later opens do not repeat migration or recalculate initialized counts downward. Pre-bounces databases use the same history checks for review/verify bounces. Complete history with no repairs establishes zero.

These checks cannot detect every loss, such as removal of an entire round trip that leaves a continuous chain. Preserve database backups and external tracker/session evidence. If history is known or suspected to be incomplete, stop for human investigation before requesting repair; do not treat an apparently reconstructed zero as proof against that evidence. Unknown counts refuse the relevant repair until evidence-backed human reconciliation. An unknown bounce count also refuses every `orch run` with exit 3 because a dispatch snapshot cannot record unknown as zero or NULL. There is no reconciliation, reset or override CLI command. Keep the ticket blocked pending separately authorized state maintenance that recovers the actual count, never forgives attempts. Retain the recovered count, the reasoning and supporting event exports, backups, tracker links or session records in the tracker or durable evidence files; link those records in the block reason. The CLI does not itself collect or validate external reconciliation evidence.

## Shared baseline failures

A baseline record names one owning fix ticket, affected tickets and the `full-suite` gate. Confirmation is an explicit attestation that the failure reproduced on a base commit, not an inference from another ticket's red run. Command and output evidence must be nonempty. Retain the actual logs at the evidence paths. IDs must reference registered tickets; the base commit must exist in configured `BASE_BRANCH` history. Repeating identical confirmation is idempotent; a different finding needs a new ID.

```sh
orch baseline confirm ID --owner FIX --affected TICKET --affected OTHER \
  --gate full-suite --base-sha BASE_SHA --command 'reproduction command' \
  --output 'failure output and retained log path' --verified
orch baseline show ID --json
orch baseline gate TICKET --gate full-suite --json
orch baseline resolve ID --fix-sha INTEGRATED_SHA
```

`show` exposes the evidence, `fix_sha` and per-ticket `refreshes`. `gate` returns `clear`, `wait`, `refresh`, `retest` or `recovery-needed`, with exit 0 even for a wait. Only the named gate waits; implementation and unrelated tickets remain runnable. The owner never waits on its own record. No phase or generic dependency graph is created. `next` puts ready owners of unresolved shared full-suite blockers before FIFO peers without changing worker limits.

Main runs `resolve` once the owner is recorded `done` through `merged`, including immediately after confirmation when the fix was already merged. First update/check the configured base through the normal integration workflow. Pass the actual integrated commit from the tracker or verified merge evidence. `merged --sha` is the CI candidate, **not** necessarily the squash commit. `resolve` verifies reachability from the local configured base, records the fixing revision, and requests refresh only for stale affected worktrees. It never changes worktree Git. Repeat it after new worktrees appear; unchanged requests and events are idempotent.

### Ticket-local refresh

At a serial stage boundary, after the previous invocation and all its children have stopped:

```sh
orch baseline refresh ID --ticket TICKET --stage-boundary
```

Run from exactly the ticket worktree. It must be linked to `MAIN_CHECKOUT`, on its recorded branch, with no tracked, staged or untracked changes and no Git operation or index/HEAD lock in progress. `spawn` now records `worktree_branch` separately from platform `worktree_ref`. Legacy tickets without a recorded branch use their conventional ticket worktree name, never the observed current branch; a legacy custom branch requires separately authorized identity reconciliation. The configured base must still contain the fix. The command rebases onto that checked base SHA, with autostash disabled. It never force-resets, resolves conflicts or aborts a rebase.

Pending `runs` are active/unknown stage evidence. A boundary flag, age, dead/idle session or handoff alone does not clear them. Existing complete `SubagentStop` evidence can establish completion. For harnesses that do not provide it, the **ticket orchestrator**, after the invocation returns, may attest one exact run:

```sh
orch complete-run TICKET --run SEQ --stopped \
  --evidence 'returned call ID; child-process cleanup evidence; retained handoff path'
```

This requires the ticket-local linked worktree, a nonempty evidence string and explicit attestation that the invocation and all child work stopped. Known Pi child callers refuse. Completion is immutable and idempotent; it writes only `completed_at`, `completion_evidence` and an event. It does not forge `SubagentStop`, resolve the model, change routing/budgets, classify success or failure, or clear other pending runs. Failed or never-started invocations still need their own evidence before attestation. Model-routing diagnostics remain independent.

Refresh commits a durable per-ticket reservation before running Git, without holding SQLite's write lock during the rebase. `run`, `spawn`, `resume`, `retire` and merge refuse while reserved. Other tickets can continue. Requested, guard-refused, refreshing, conflicted and success outcomes, plus recovery evidence, are inspectable in `show` and append-only ticket events. A guard refusal commits its event despite exit 3. Phase, bounce and CI repair counts stay unchanged.

A conflict is retained for the ticket's recovery decision. An interrupt, timeout or crash leaves the reservation in place, even when the original process dies; a Git descendant may survive. No expiry clears it. After inspecting the process tree, stopping any remaining writers, and explicitly resolving or otherwise recovering Git state without discarding work:

```sh
orch baseline recover ID --ticket TICKET --stage-boundary --stopped \
  --evidence 'process cleanup and Git recovery evidence'
```

Recovery refuses a still-live refresh process, pending stages, dirty work or unfinished Git operations. It changes only coordination state, not Git. If HEAD contains the fix, the next action is `retest`; otherwise the request remains for another refresh. It invalidates old CI and acknowledgment evidence. A malformed or uncertain reservation requires investigation, never automatic clearing.

**Guard limits.** This is a cooperative serial-work protocol, not a filesystem sandbox. The CLI cannot authenticate the truth of attestation text, inspect every detached child, block an unrecorded agent or editor, or protect ignored/external files. Record every dispatch before starting it. The ticket orchestrator must exclude those writers throughout refresh and recovery, preserve ignored assets separately if needed, and leave unknown completion pending. Git hooks or unrelated terminals that bypass the protocol are outside the reservation. Do not attest merely to get past a refusal.

### Fresh gates after refresh

Revision-changing refresh appends invalidating CI verdicts without deleting historical results. Tests and independent review must run again against the current candidate. Keep the existing phase; redo the evidence work without inventing a backwards phase transition or spending a repair budget merely for refresh. Respect normal transitions if review actually requires a repair.

After all required tests pass and a fresh independent reviewer returns, acknowledge both with retained evidence:

```sh
orch baseline ack ID --ticket TICKET --sha CURRENT_HEAD \
  --tests 'full-suite command, green summary and log path' \
  --review 'independent reviewer, verdict and artifact path'
```

Acknowledgment requires current clean HEAD containing the fix and no pending stages. It expires on any HEAD change. Record passing CI for that exact HEAD through `orch ci` as usual. CI alone cannot replace the acknowledgment, and acknowledgment alone cannot replace CI. Check `baseline gate` before the remote merge; `orch merged` also enforces the baseline gate and refreshed exact HEAD. The CLI records attestations, not the truth of external test/review output, so retain the artifacts. Project `local-tests` policy still omits separate browser/accessibility verification; it does not omit automated tests or independent review.

## Session health

Every ticket shows `health`, derived on read:

| Health | Meaning |
|---|---|
| `none` | No session yet (`ready`, or `dispatched` before any session reported in) |
| `working` | Alive, and the last activity is a tool call or session start within `stall_minutes` |
| `idle` | Alive, and the last activity is a `Stop` (turn finished, waiting) |
| `stalled` | Alive, `working`, but no activity for longer than `stall_minutes` |
| `dead` | Not alive |

**Alive** means all of:

- a process id is recorded, and that process exists;
- it is the same process: when a process start time was recorded, `ps -o lstart= -p <pid>` still matches it; otherwise its command line (`ps -ww -o command= -p <pid>`) contains the session id as an argument;
- the last activity is not `ended` (a `SessionEnd` hook).

Every `ps` call runs with `LC_ALL=C` and `TZ=UTC`, so a start time recorded by the hook compares equal from any process whatever its time zone or language.

A pid reused by an unrelated process is therefore not alive: `stale` lists the ticket, `resume` is allowed, and `retire` does not signal it.

## Hooks

The plugin ships `hooks/hooks.json`, which runs `orch hook` on `SessionStart`, `PostToolUse`, `Stop`, `SubagentStop` and `SessionEnd` in **every** session where the plugin is enabled. `orch hook` reads the hook's JSON from stdin (`session_id`, `cwd`, `hook_event_name`, `source`, `reason`).

It always exits 0, prints a stdout context line only on `SessionStart` for a matched ticket, catches every error, and returns at once when there is no `<project root>/.agents/orchestration/state.db` for `cwd`. STATE.md synchronization failures remain visible on stderr, as described in [STATE.md synchronization](#statemd-synchronization). It matches under a plain read and takes the write lock (`BEGIN IMMEDIATE`) only when it is about to write, re-checking the ticket under the lock.

**Matching.** The hook belongs to the non-retired ticket whose worktree (realpath) equals `cwd` or contains it. No match → leave ticket records unchanged, so the main orchestrator (in the project root or the main checkout) is never matched. A row whose worktree is a main checkout (its `.git` is a directory) never matches either. Then:

- `SessionStart` on a `done` ticket writes and prints nothing.
- `SessionStart` from a session id other than the recorded one takes the ticket over (logged as an `attach` event) only when the recorded session is not alive, or the hook's Claude process is the recorded pid (`/clear` starts a new session id in the same process). Otherwise it is ignored entirely and prints nothing, so a second session opened in the worktree cannot hijack a live ticket session.
- **Hijack window.** Until the launched session has reported in (`session_seen` is 0), a `SessionStart` from another session id never takes over a `headless`, `orca` or `herdr` ticket, alive or not: that ticket's own session id is known and its `SessionStart` is on the way. A `desktop` ticket still allows it, since Desktop picks the session id. So does a `codex` ticket with no session id yet (see "Harnesses").
- Other events from a session id other than the recorded one are ignored.

**Process id.** The hook records the harness process it runs under (Claude's described here; `pi` and `codex` are recognised the same way by name). The Pi extension names its process in `ORCH_HOOK_AGENT_PID`, which replaces the walk. Otherwise: walk up from the hook's parent process (at most 8 levels) to the first process that is Claude, and record that pid and its `lstart`. A process is Claude when its executable (`ps -o comm=`, the path; it may contain spaces, as on Desktop) has basename `claude` or contains `/claude/versions/` (the native installer runs `~/.local/share/claude/versions/<version>`), or its command line's first word has basename `claude`, or that first word is a script runtime (`node`, `bun`, `deno`, `python…`) whose first non-option argument is a script file with basename `claude` (an npm install; a script with a shebang shows its interpreter on macOS). Shells (`sh`, `bash`, `zsh`), shell strings (`-c '…'`) and modules (`python -m claude`) are not Claude. The walk runs only after a ticket matched, and only on `SessionStart`. When the walk finds nothing for the recorded session id, or finds a process whose start time `ps` cannot read, the recorded pid and start time are kept as a pair. Test override: `ORCH_HOOK_CLAUDE_PID=<pid>` replaces the walk; `ORCH_HOOK_CLAUDE_PID=none` means "the walk found nothing".

| Event | Writes |
|---|---|
| `SessionStart` | session id (if it takes over: `attach` event), pid + start time (kept when the walk finds nothing), `session_seen`=1, activity `working`, `last_seen_at`. Prints the context line `You are the ticket orchestrator for <ticket>. Run \`orch show <ticket>\` before anything else.` Nothing on a `done` ticket or an ignored session. |
| `PostToolUse` | activity `working`, `last_seen_at`. Skipped when the activity is already `working` and `last_seen_at` is under 15 s old (keeps hooks cheap). |
| `Stop` | activity `idle`, `last_seen_at` |
| `SessionEnd` | activity `ended`, `last_seen_at`, `session_end` event with the reason |
| `SubagentStop` | activity `working`, `last_seen_at`; for a stage agent, its run (see "Model routing") |

Only `SessionStart`, `SessionEnd` and `SubagentStop` write events; activity updates do not.

**`SubagentStop`** (Claude Code). Matched like the other events; a session id other than the recorded one is ignored before anything is read. The role is the `agent_type` after `orchestration:`; any other agent type is not a stage agent and only bumps the activity. For a stage agent the hook reads `agent_transcript_path` and takes `message.model` of the last `type: "assistant"` line (the transcript is written asynchronously: it retries for up to 2 s). It first checks the exact ticket, role and usable `agent_id` against filled runs, including mismatched and unresolved runs. Missing or falsy ids and the literal `unknown` sentinel never establish reuse. A known agent stays attached to its original run and never consumes a pending run or emits `dispatch_unrecorded`. Otherwise it pairs with the ticket's oldest run of that role whose `agent_id` is null, ordered by sequence rather than model similarity, and fills `agent_id`, `model_resolved`, `effort_resolved` (the same line's top-level `effort`, null when the transcript has none), `resolved_at` and `match`: 1 when the resolved id starts with `claude-<requested alias>-` (`sonnet` ↔ `claude-sonnet-5-5`) and the transcript names no effort or the one requested, else 0 plus a `model_mismatch` event (role, requested, resolved, and `effort requested=… resolved=…` on an effort mismatch). No model in the transcript: only `agent_id` is filled, `model_resolved` stays null, and a `model_unresolved` event (role, agent id) is written. No known identity or pending run for a stage agent: a `dispatch_unrecorded` event (role, resolved model, and the call's `model` from the transcript's `.meta.json` when present).

Known-agent follow-ups preserve recorded evidence, `resolved_at` and `match`. Repeated unresolved or identical mismatched evidence does not duplicate the original diagnostic. Late model evidence may complete an unresolved run using the normal alias-prefix and effort checks, retaining its original `model_unresolved` event. With the same recorded model, compatible newly available effort fills only a missing `effort_resolved`; no requested effort is permissive and absent observed effort remains acceptable. A contradictory observed model or effort, including newly available effort that contradicts the request, leaves the run unchanged and emits a separate `model_mismatch` event identifying the run, agent, retained evidence and new observation. `show` still counts mismatches from run verdicts, not these events. Intentional model upgrades require a new agent and a new recorded dispatch. Missing model evidence alone does not block a ticket; the existing 2-second retry bound, activity updates and transactional rechecks remain unchanged.

## Launching sessions

`spawn` and `resume` start a session on a platform:

| Platform | How `orch` starts it | `launch_ref` recorded |
|---|---|---|
| `headless` | `claude -p --session-id <sid> --output-format stream-json --verbose <claude_args>`, prompt on stdin from the brief file, detached in its own process group, output to `logs/<ticket>.log`. Pid recorded at once. | `{"pid": <pid>}` |
| `orca` | `orca terminal create --worktree path:<worktree> --title t<ticket> --command '<cmd>' --json`, then `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 20000 --json` (folder-trust check, below) | `{"terminal": <handle>}`, the first string value under a key named `handle` in the JSON reply |
| `herdr` | `herdr worktree open --cwd <main checkout> --path <worktree> --label t<ticket> --no-focus`, then `herdr agent start <agent> --kind claude --pane <root pane id> -- <session args> <claude_args>`, then `herdr agent prompt <agent> '<prompt>'` | `{"workspace": <id>, "pane": <id>, "agent": <agent>}` from `.result.workspace.workspace_id` and `.result.root_pane.pane_id`; `<agent>` is `t` + the lowercased ticket id with characters outside `[a-z0-9_-]` turned into `-`, cut to 32 characters |
| `desktop` | Nothing: `orch` cannot open a Desktop session. It records the intent and prints an action for the main orchestrator. | set later by `orch attach --ref` |

For `orca`, `<cmd>` is an interactive session: `claude --session-id <sid> <claude_args> "$(cat '<brief file>')"` (shell-quoted). For `herdr`, Herdr starts `claude` itself (`--kind claude`, so `ORCH_CLAUDE_BIN` does not apply) and the prompt goes in with `agent prompt`. The pid arrives with the `SessionStart` hook.

- The terminal's shell must understand `"$(cat …)"`: a POSIX `sh`-compatible shell (bash, zsh) or fish 3.4 or later.
- The prompt is one command-line argument, so a prompt (brief, or resume prompt with its note) over 128 KB (131072 bytes) is refused on `orca` and `herdr` with exit 3 before step 1.
- Herdr exits 0 even when a command fails: any reply with a top-level `"error"` is a failure. Orca fails with a non-zero exit and `"ok": false`.

**Folder trust.** Interactive `claude` in a folder Claude has not trusted stops at the "trust this folder" dialog (headless `-p` does not). On `orca`, the `terminal wait` reply then carries `blockedReason: "agent-trust-workspace"` (the wait can add up to 20 s to each orca launch); on `herdr`, `agent start` replies with error code `agent_not_ready` ("blocked during startup"), or `agent prompt` with `agent_blocked`, and it counts as the trust block only when the error or the agent's screen (`herdr agent read <agent> --source visible`) mentions "trust"; any other block is a plain launch failure. To keep it from happening, `orca` and `herdr` launches (start and resume, not headless or desktop) first mark the worktree trusted in Claude's user config: `projects[<worktree realpath>].hasTrustDialogAccepted = true`, other keys untouched, written to a temp file with the original's mode and `os.replace`d, then re-read and retried (3 writes at most) when a concurrent claude dropped it. A missing or invalid config file is never created or overwritten: a warning (never the file's contents), no mark, and the launch goes on. The ticket's `trust_marked` (0 nothing, 1 the key, 2 the whole entry) and a `trust_mark` event record what `orch` added; trust that was already there is not recorded and never removed. A launch that fails in step 2 removes the trust it added. Details in [platforms.md](platforms.md) "Folder trust". If the dialog still appears, `orch` records the launch (step 3 runs, plus a `trust_prompt` event), leaves the terminal or workspace open, and exits 3 with `claude is waiting at the folder-trust prompt in <worktree>; open that terminal and accept it once (orch could not mark the folder trusted)`. Once accepted, the session reports in through the hook as usual. On `herdr` the prompt was not sent yet: the message adds the `herdr agent prompt` command that sends it.
- No `--` is placed before the prompt: `claude --help` does not document `--` as end of options. A brief that starts with `-` could be read as an option; start briefs with text.

For `desktop`, `spawn` and `resume` exit 0 and print `{"action": "desktop_start", "cwd": ..., "prompt_file": ..., "title": "t<ticket>"}` (resume: `"action": "desktop_resume"`, plus `"ref"` when one is recorded). The main orchestrator starts or messages the Desktop session itself, then runs `orch attach <ticket> --ref <desktop session id>`. The session id and pid arrive with the `SessionStart` hook.

**Steps.** (1) Commit the intent: phase, platform, session id, worktree, attempt, pid NULL, event, and the in-flight marker (below). (2) Start it. (3) Commit the pid (headless) and `launch_ref`, and clear the marker. On `orca` and `herdr` step 3 has no pid; a `SessionStart` hook that arrived during step 2 (Orca's trust wait, Herdr's `agent start` and `agent prompt`) already recorded the session's pid and start time, and step 3 keeps them. A crash after step 1 leaves the ticket active with no live session, so `stale` lists it. If step 2 fails (binary missing or not executable, worktree gone, platform command exits non-zero or its JSON lacks the id), step 3 restores the ticket exactly as it was, removes the events written in step 1, and the command exits 3 with `cannot start <what> in <cwd>: <error>`. One exception: when a resume closed the old orca terminal or herdr workspace before the failed start, `launch_ref` is restored as null, not as a ref to the closed one. A herdr reply that names a workspace but no root pane, or a failed `agent start` (other than the trust block) or `agent prompt`, closes that workspace before the refusal, unless `worktree open` reported it `already_open`; then, if the agent had started (a failed `agent prompt`, or `agent_not_ready`), `herdr pane close <root pane>` stops it. An orca `terminal create` whose reply names no handle runs `orca terminal close --worktree path:<worktree> --all --json` before the refusal. When `spawn` created the worktree itself (no `--worktree`), a failed launch also removes that worktree again. Writing the prompt file happens before step 1, so a failure there changes nothing. An empty or whitespace-only brief is refused with exit 3 before step 1.

**In-flight marker.** `spawn`, `resume` and `retire` release the write lock while platform commands and engines run, so each first claims the ticket: the `launching` column holds `{"token", "op", "pid", "pid_start", "at"}` (the orch process and when). `spawn` claims it before creating a worktree, `resume` in step 1, `retire` before it closes anything. While a ticket holds a live marker, `spawn`, `resume` and `retire` (with or without `--force`) on it exit 3 with `launch in progress for <ticket>: orch pid <pid> started a <op> at <time>; ...`; so does a `spawn` without `--worktree` of another ticket with the same worktree name. The owner clears the marker in step 3, in the step-2 rollback, when retire finishes or fails, and on any error or interrupt. A marker older than 10 minutes, or whose orch process is gone (pid not running, or running with another start time), is abandoned and ignored, so a crash mid-launch never wedges the ticket.

**Resume prompt.** When the session has reported in before (`session_seen`, or for headless a log line carrying the session id), resume continues it: `--resume <sid>` with a prompt telling the session to run `orch show <ticket>` first and replaying any retained local-tests instructions from the stored brief. Otherwise it starts fresh with `--session-id <same sid>` and the stored brief. `--note` text is appended to either prompt. A fresh start with no stored brief exits 3 (`no stored brief; re-spawn`).

**Resume on `orca` / `herdr`** first closes the old terminal or workspace when `launch_ref` names one (best effort, ignore errors): `orca terminal close --worktree path:<worktree> --all --json`, `herdr workspace close <workspace>`. Then it opens a new one the same way as `spawn`. Resuming onto `desktop` keeps `launch_ref` only when it is a Desktop ref; any other ref is cleared.

## Model routing

`orch` picks the model of every stage dispatch, mechanically, so the choice does not depend on what the orchestrator remembers. Tiers, lowest first, and what each harness dispatches:

| Tier | Claude (Agent tool `model`) | Codex (agent file model) | Pi (`subagent` call model) |
|---|---|---|---|
| `light` | `haiku` | `gpt-6-luna` | `openai/gpt-6-luna` |
| `standard` | `sonnet` | `gpt-6.1-sol` | `openai/gpt-6.1-sol` |
| `heavy` | `opus` | `gpt-6-astra` | `openai/gpt-6-astra` |
| `frontier` | `fable` | `gpt-6-astra` | `openai/gpt-6-astra` |

Each tier has two effort rungs, `low` and `high`, one word on every harness: Claude Agent tool `effort`, Codex `model_reasoning_effort`, Pi `thinking`. The tier picks the model, the effort the rung. Rungs form one ladder: `light/low` < `light/high` < `standard/low` < ... < `frontier/low` < `frontier/high` (the top).

Role defaults: `filer`, `investigation`, `reviewer`, `verifier`, `reporter` light; `test-writer`, `implementor` standard. Then, in order:

Every role starts at effort `low`; bumps below change the tier, not the effort.

1. `--ambiguous`: one tier up.
2. `--files N` > 5 or `--lines N` > 300: `investigation` and `reviewer` one tier up (other roles ignore the size).
3. Floors from the ticket's runs: an implementor after a bounce (the ticket's `bounces` grew since the last implementor run) runs one rung above the last implementor run (effort first, then tier: `standard/low` -> `standard/high` -> `heavy/low`), and is refused (exit 3, "block") when that was `frontier/high`; a reviewer runs at most one tier below the last implementor; every role runs at most one tier below the highest recorded tier on the ticket (no mid-ticket de-escalation). Both floors are lower bounds clamped at `light`: reviewer tier >= last implementor tier minus one, and every role's tier >= highest recorded ticket tier minus one. Role defaults, ambiguity or size can raise the result. A `heavy` implementor requires at least a `standard` reviewer; a `frontier` implementor requires at least `heavy`. With a `heavy` implementor as the highest recorded run and no other bumps, the reviewer routes at `standard/low`.
4. Everything caps at `frontier/high`.

Enter `fix` successfully before routing, recording or dispatching the repair. Merely being in `review` or `verify` does not add a rung; the successful review/verify-to-fix transition increases `bounces`. Routing escalates only when `ticket.bounces > last_implementor.bounce_count`.

The ordinary last-implementor `frontier/high` refusal happens at `orch phase <ticket> fix`, after the budget check. It exits 3 with human-block advice and leaves state unchanged. A read-only implementor route remains possible in `review` after that refusal and normally returns `heavy/low` without extra flags, since no bounce was recorded. It cannot authorize a fix dispatch: stop, retain the findings and explicitly block for a human. Routing's defensive frontier/high refusal applies only when the bounce count actually exceeds that implementor's snapshot. A last implementor at `frontier/low` still has `frontier/high` available after a successful bounce if budget remains.

A CI repair (`ci -> fix`) is not a bounce and adds no bounce rung. It leaves `bounces` and `review_rounds` unchanged; entering `review` still adds to review-entry history. The repair uses the normal role default and applicable floors, including highest recorded tier minus one. With `heavy` as the highest recorded tier, a last implementor run that recorded the current bounce count, and no other escalation, the CI-repair implementor routes at `standard/low`. This is not an unconditional standard route and does not retain the previous effort. Review/verification bounces still trigger the effort-first escalation above.

On Pi the machine config's `pi_models` (`${XDG_CONFIG_HOME:-~/.config}/orchestration/config.json`) overrides the models by tier (`{"light": "<provider>/<model>", ...}`); the old keys `haiku`, `sonnet`, `opus` still work as `light`, `standard`, and `heavy` plus `frontier` (both run on one model; a tier key wins). `pi/extension.ts` `piModels()` reads the same map. On Codex, `scripts/codex-agents` writes one agent per stage, tier and effort (`<name>_<tier>_<effort>.toml`, agent `<name>-<tier>-<effort>`, with that tier's model and the effort as `model_reasoning_effort`; the reviewer read-only, the verifier on the session's sandbox) and removes the `<name>.toml` and `<name>_<tier>.toml` of earlier versions (only ones it generated: the first line says so); `orch route` prints the agent to spawn. Codex's `spawn_agent` `model` field is behind a config option, so the agent file carries the model instead.

**Runs.** `orch run` records each dispatch **before** it happens in the `runs` table: `seq`, `ticket`, `role`, `model_requested`, `tier`, `effort_requested`, `bounce_count` (the ticket's `bounces` at dispatch), `requested_at`, and, filled by the `SubagentStop` hook on Claude, `agent_id`, `model_resolved`, `effort_resolved`, `resolved_at`, `match` (1/0; null until resolved). `match = 0` is the loud failure: the subagent ran on another model or effort than asked. `orch runs` and `show` print `EFFORT` and `EFFORT_RESOLVED` columns.

### Infrastructure retry

When infrastructure prevents a recorded stage from completing, use `orch retry <ticket> --run <seq> --json`. This records a new attempt and one `retry` event without changing phase or consuming bounce/CI repair budget. Read the fresh output and dispatch from its `dispatch` object; it is already recorded, so do not call `route` or `run` again. Recomputing a route can lose the high effort of a recorded fix.

Exact replay retains the source role, tier, model/provider, effort, harness and routing inputs. It checks current floors and requires unchanged phase/repair context and model mapping. Refusals exit 3 without changing tickets, runs or events. Blocked, done or retired tickets, unknown counters, missing legacy provenance and invalid repair history also refuse. Reconcile the reported problem before dispatch.

A deliberate routing decision uses all three flags: `--model <tier-or-value> --effort <low|high> --reason <nonempty-text>`. Missing components exit 2. This permits an explicit model mapping or harness change, but still requires compatible phase/repair context and current floors. It records the reason and retains the old identity through the source link. This command does not classify failures or authorize bypassing a refused fix transition. A genuine review rejection enters `fix` and escalates normally; a new CI repair uses normal defaults/floors, not replayed effort.

`run`, `retry` and `runs` JSON rows add:

- `dispatch`: `role`, `harness`, `tier`, actual dispatch `model`, `effort`, plus Pi `thinking` or a Codex stage `agent`. Unlike `model_requested`, `dispatch.model` never contains a Codex agent name.
- `routing_context`: `files`, `lines`, `ambiguous`, `phase`, `bounces`, `ci_repairs`, and `transition`, the latest phase event's `seq`, `from_phase`, `to_phase`, or null. The transition identifies the repair entry and prevents replay across separate visits to the same phase.
- `retry_of`: immediate source run sequence, or null for ordinary runs. Follow these links to the original dispatch.
- `retry_reason`: exact deliberate reason, or null for ordinary runs and exact replay.

SQLite adds nullable TEXT columns with those names; dispatch/context are JSON text and `retry_of` is emitted as an integer. Legacy rows retain null provenance rather than inferred values. Each retry has a fresh sequence/time and null resolution fields; its source stays unchanged. Tabular output is unchanged.

**Smoke test.** `orch smoke-routing [--model M]... [--effort E]` (`E` low or high, default `high`; default models `haiku` and `fable`; Claude only, other harnesses exit 3 "not supported") starts, per model, `claude -p --session-id <sid> --output-format stream-json --verbose <claude_args>` in the project root, asking it to dispatch a `general-purpose` subagent with that `model` and `effort`. After it exits (timeout 180 s) it reads `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project key>/<sid>/subagents/agent-*.jsonl` (the key is the project root with every non-alphanumeric character replaced by `-`) and checks the last assistant entry's `message.model` is `claude-<alias>-…` and its top-level `effort` is the requested one. The transcript is the verdict, never the subagent's self-report. Prints `REQUESTED RESOLVED RESULT` rows (`haiku/high`, `claude-haiku-5-5/high`); exit 0 when all pass, 3 otherwise. `fable`, not `claude-fable-5-1`: the Agent tool accepts only the aliases `sonnet`, `opus`, `haiku`, `fable`.

## Commands

Every command accepts `--json`, before or after the command name (one JSON object on stdout). Exit codes: `0` ok, `2` usage, `3` gate refused, `4` ticket not found, `5` preflight failed. Refusals print the reason on stderr.

| Command | Who | Effect |
|---|---|---|
| `orch init` | main | Create the directory and database, and synchronize STATE.md. Safe to re-run. |
| `orch state-md check` / `orch state-md rebuild` | any | Inspect freshness without repair / publish committed records. See [STATE.md synchronization](#statemd-synchronization). |
| `orch platform` | any | `{"platform": ...}` per "Platforms", and `harness`, `harness_source` per "Harnesses". |
| `orch preflight` | main | Exit 0 and print `verify_env` (`ddev`, `docker` or `local-tests`), `base_branch` and `platform`. Exit 5 listing every failure. Checks: `BASE_BRANCH` set in the environment or `.orch` (an optional `export ` prefix is allowed; a quoted value is the text inside the quotes, an unquoted value ends at the first whitespace-then-`#` comment); verification environment is `local-tests` when `verify_policy` explicitly selects it, otherwise `ddev` when the main checkout has `.ddev/config.yaml` **and** `ddev` is on `PATH`, else `docker` when `config.json` has `verify_harness` **and** `docker` is on `PATH`, else failure; the platform's binary (`orca` or `herdr`) is on `PATH` when the platform needs one. |
| `orch add <ticket> --title T [--url U]` | main | New ticket in `ready`. Exit 3 if it exists. Exit 2 unless the id matches `^[A-Za-z0-9][A-Za-z0-9._-]*$` with no `..` (it names files under `logs/` and `briefs/`). |
| `orch list` | any | All tickets: id, phase, status, platform, health, activity, last_seen_at, review_rounds, pid, alive, retired. |
| `orch show <ticket>` | any | One ticket in full, including `alive`, `health` and `launch_ref`, plus `bounces`, `runs` (as `orch runs`), `model_mismatches` (runs with `match` 0) and `unrecorded_dispatches` (`dispatch_unrecorded` events). The text form prints the runs as a table after the fields. |
| `orch next` | main | `ready` tickets, unresolved shared full-suite blocker owners first, then oldest first, limited to `max_workers` minus active tickets. Active = not `ready`/`done`/`blocked` and not retired. |
| `orch spawn <ticket> [--worktree P] --brief-file F [--platform X] [--harness H]` | main | Requires `ready`. Without `--worktree`, the platform adapter creates the worktree first ([platforms.md](platforms.md)). Exit 3 if the realpath of `P` is the main checkout or contains it, lies inside the main checkout without being a linked worktree of its own (`git rev-parse --show-toplevel` there is the main checkout), or equals, contains or lies inside the worktree of another non-retired ticket that is not `ready` or `done`. Exit 3 while a launch is in progress (in-flight marker). Stores the brief, then launches per "Launching sessions" on `--platform` (default: the configured platform). Phase `dispatched`, attempt 1. |
| `orch resume <ticket> [--note N] [--platform X] [--harness H]` | main | Exit 3 if the session is alive, a launch is in progress (in-flight marker), or the ticket is `ready`, `done` or retired. A `blocked` ticket first returns to its remembered phase (`unblock` event). Attempt + 1, then launches per "Launching sessions" on the ticket's platform, or `--platform`. |
| `orch attach <ticket> [--ref R] [--session-id S]` | main | Record a Desktop session ref (stored as `{"desktop": R}`) and/or a session id for a session `orch` did not start. Writes an `attach` event. |
| `orch stale` | main | Active tickets whose health is `dead`, including `dispatched` ones nobody reported in for: the recovery list. An `orca`, `herdr` or `desktop` ticket that no session has reported in for yet (no pid) is listed only once `stall_minutes` have passed since its launch, since its pid only arrives with the first hook. |
| `orch hook` | hooks | See "Hooks". |
| `orch phase <ticket> <phase> [--note N]` | ticket | Validated transition (table above). |
| `orch block <ticket> --reason R` | either | Phase `blocked`; remembers the prior phase. The reason is recorded in STATE.md. |
| `orch unblock <ticket>` | either | Back to the remembered phase. Exit 3 if there is none. |
| `orch ci <ticket> --sha S (--passed \| --failed)` | ticket | Records the CI verdict for that commit. Requires phase `ci`. |
| `orch merged <ticket> --sha S [--mr URL]` | ticket | Requires phase `ci`. Exit 3 unless the latest CI verdict for exactly `S` is `passed`. Then phase `done`; the committed merge event retains the SHA and optional MR URL. |
| `orch retire <ticket> [--force] [--keep-worktree]` | main | Requires `done` (or `--force`) and no launch in progress; holds the in-flight marker while it runs, so no `resume` launches meanwhile. Closes what the platform opened. `headless`: signals the session's process group (SIGTERM, SIGKILL after 3 s) when alive and leading its group. `orca`: `orca terminal close --worktree path:<worktree> --all --json`. `herdr`: `herdr workspace close <workspace>`. Platform close errors are reported but don't block retiring. After closing, a session still alive by the identity check is signalled. Then, unless `--keep-worktree`, removes the folder trust `orch` added for the worktree (the key, or the entry it created; a failure only warns) and removes the worktree, branch and DDEV project through the platform adapter (see [platforms.md](platforms.md)); a refusal there (uncommitted work without `--force`) leaves the ticket un-retired and exits 3. Then sets `retired_at`. `desktop`: prints `{"action": "desktop_archive", "ref": ...}` for the main orchestrator to archive the session. |
| `orch watch [--interval S] [--once]` | any | Live table of non-retired tickets; see [platforms.md](platforms.md). |
| `orch selftest [...]` | main | Lifecycle self-check; see [platforms.md](platforms.md). |
| `orch events <ticket>` | any | The ticket's event log, oldest first. |
| `orch route <ticket> --role R [--files N] [--lines N] [--ambiguous]` | ticket | Read-only: the tier, effort and dispatch value for the ticket's harness ("Model routing"). Text: the model on the first line, then `tier:`, `effort:`, `thinking:` (Pi), `agent:` (Codex, stage roles) and a `why:` line per bump or floor applied. `--json`: `{"tier", "model", "effort", "thinking" (Pi), "agent" (Codex), "floors": [reasons]}`. Roles: `filer`, `investigation`, `test-writer`, `implementor`, `reviewer`, `verifier`, `reporter`; another exits 2. An implementor after a `frontier/high` bounce exits 3 (block for a human). |
| `orch run <ticket> --role R --model M --effort E [--files N] [--lines N] [--ambiguous]` | ticket | Records the dispatch in `runs` before it happens, and a `run` event; prints the run's `seq` (`--json`: the row). `M` is the harness's dispatch value (Claude alias, Codex or Pi model) or a tier name (recorded as that tier's dispatch value); on Codex also the per-rung agent name (`implementor-heavy-high`, which implies its tier and must agree with `E`), and a bare `gpt-6-astra` (heavy and frontier share it) is `heavy`. An unknown value exits 2. `E` is `low` or `high`, required (else exit 2); the run records `effort_requested`. A rung below what `orch route` gives for the same flags exits 3 with the reason. The pipeline passes `route`'s `tier`, since a shared model (Pi heavy/frontier, Codex roles without an agent) would be read as the lower tier. |
| `orch runs <ticket>` | any | The ticket's runs, oldest first. |
| `orch retry <ticket> --run SEQ [--model M --effort E --reason TEXT]` | ticket | Records a linked attempt; prints its sequence, or the dispatch-ready run row with `--json`. See "Infrastructure retry". |
| `orch smoke-routing [--model M]...` | main | Checks Claude's Agent tool really runs subagents on the requested model; see "Model routing". |

Workflow events retain timestamp, ticket, kind, from phase, to phase and detail. Some updates, such as hook activity, have no event; the source revision still tracks them.
