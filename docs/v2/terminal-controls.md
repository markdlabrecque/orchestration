# Terminal controls and run observations

One foreground process owns each ticket's Pi Durable SQLite file. Stop that
process before running abort or retire. This is an operator convention, not a
liveness check. No lock, daemon, control channel or second run database was
added. A second owner can still corrupt a live run.

## Commands

- `orch run <ticket>` starts or resumes the saved workflow. Ctrl-C, SIGHUP and SIGTERM
  record an orderly pause and close the engine and its owned work.
- `orch run <ticket> --retry` permits one more attempt after the crash limit.
  The flag also works before the ticket number.
- `orch show <ticket>` prints the status projection as JSON once.
- `orch tail <ticket>` follows complete event records until interrupted.
- `orch abort <ticket>` records an abort intent, cancels the stopped run's
  saved task and owned conversations, then reconciles the tracker abort marker.
  It does not retire the worktree. A failed or interrupted tracker write retains
  the intent and stable marker for the next run command.
- `orch retire <ticket>` retires stopped blocked, aborted, parked or completed
  work. The intent is committed before calling the retained retirement engine.
  Failure leaves the intent pending. Retire or run retries it. An aborted run
  stays aborted after retirement; unfinished work becomes terminal `retired`.

Merged, completed, parked, aborted and retired runs print their final state
without executing the workflow again. Final-state reads, abort recovery and
manual retirement do not require the workflow file or agent tools to remain
installed. Abort cannot change a confirmed merge into an aborted run.
Automatic retirement records completion so later retire commands are no-ops.
The existing retirement engine retains its dirty-worktree checks and recovery
records. Repair a refusal and retry; the CLI does not force worktree deletion.

## Crash accounting

The engine commits the current step before executing it. Reopening a run left
running at that step counts one crash in the Pi Durable run document. Clean
pauses do not count. Three crashes block before execution resumes. Reading a
blocked run again does not count another crash or resumption. Explicit retry
retains the crash history; if that attempt crashes, another explicit retry is
required. Repair budgets remain separate.

The crash count is observed on restart. A status file left by a killed process
can therefore still say running until the next owner recovers it. Status is
not proof that a process is alive. Abort and retirement failures are counted
when those operations themselves crash.

## File schemas

All files remain in the wrapper's `.agents/orchestration/runs/` after worktree
retirement. Pi Durable owns authoritative state in `<ticket>.sqlite`.
The other files are read projections, never recovery inputs.

`<ticket>.status.json` has `version: 1`, `ticket`, `runId`, `status`, `reason`,
`currentStep`, `outcomes`, `startedAt`, `updatedAt`, `resumptions`, `crashes`,
`budgets`, `repair` and `retirement`. Times are ISO UTC strings. `updatedAt`
is the projection publication time. `crashes` maps step names to counts;
`budgets` includes durable spent slots and grants. `currentStep` is null when
no step is active. `retirement` is null or records its prior status and
`pending`/`done` state. Status is written to a sibling temporary file and
atomically renamed over the previous projection.

Each complete line in `<ticket>.events.jsonl` has `version: 1`, `ticket`,
`runId`, `timestamp`, `step`, `type` and `data`. Types are `status`, `text` and
`tool`. Data preserves the runner payload, full result or final handoff;
status publications also carry the status projection. The terminal prints step
starts and outcomes, one line per tool call and final handoffs. Intermediate
runner text remains in events.

Readers reject unknown versions and malformed complete JSON records. Tail
waits for the newline before parsing a trailing record. On writer recovery,
only an incomplete final record is truncated before appending. Complete
history is retained. Show and tail never open SQLite or load runner tools.

## Validation

Tests use the approved CLI, execution and runner seams, real SQLite files,
local worktrees and fake provider/forge boundaries. Process tests send SIGKILL
three times at a step, verify blocking, exercise explicit retry and crash that
retry again. Other process tests send SIGINT, kill after the tracker abort
write, and kill after retirement takes effect. Reopening storage reconciles
those operations without repeating completed work or duplicating remote
markers. An incomplete event append is recovered without losing prior records.

CLI fixtures verify versioned status, retained transcripts, concise terminal
output and final-state behavior after removal of the workflow file. Execution
tests cover four clean pauses without crash charges, retirement failure and
retry, and refusal to abort a confirmed merge. No tests were retired or
weakened. No live forge writes or production access were used.

Final integration validation: `pnpm check` passed type checking, Biome,
178 TypeScript tests, 412 bash assertions and 15 Python tests after merging
integration tip `30408b0`. The GitLab factory, forge overrides and tracker tests
remain intact. The original implementation base was `17c1e02`.
