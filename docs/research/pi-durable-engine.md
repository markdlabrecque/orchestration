# What Pi Durable gives and demands as the v2 engine and runner

Research for ticket #126. v2's Engine is a Pi Durable program (ADR 0001): a Workflow runs as Pi Durable tasks, Steps run as owned subagent conversations or shell commands, and Gates are code between steps. This note records what `@earendil-works/pi-durable` 1.3.0 actually provides for that, point by point, with exact identifiers and a source per claim, and what the sources leave open.

Vocabulary: Workflow, Step, Step kind, Runner, Engine, Gate and Ticket are v2 words (GLOSSARY.md). Harness, Session, Conversation, Entry, Task, Tool, Document, Submission, Extension and Registry are Pi Durable words (README, Concepts).

## Sources

Everything below was read, not run. Package files were treated as data.

| Label | What | Where |
|---|---|---|
| PKG | npm tarball `@earendil-works/pi-durable@1.3.0`, published 2026-10-15T19:13:35Z, 327 files | `npm pack`; paths below are inside `package/` |
| README | `package/README.md` in PKG, byte-identical to the repo at tag `v1.3.0` (`diff -q`) | https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md |
| CHANGELOG | `package/CHANGELOG.md` in PKG, byte-identical to the tag | https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/CHANGELOG.md |
| pkg.json | `package/package.json` in PKG | https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/package.json |
| d.ts | `package/dist/**/*.d.ts` in PKG; generated from `packages/durable/src/**/*.ts` at the tag, which the links point at | https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable/src |
| REPO | github.com/earendil-works/pi at tag `v1.3.0`, commit `71023aec1546d6d677a65669c5665c0927ce0dd0` ("Release v1.3.0", 2026-10-15) | https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable |
| SPEC | `packages/durable/docs/spec.md` at the tag (295 KB, normative); only the sections cited were read | https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md |
| EX-nn | `packages/durable/test/examples/nn-*.ts` at the tag; all 32 were read | https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable/test/examples |
| TESTS | `packages/durable/test/*.ts` helpers and the tests cited | https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable/test |
| MAIN | `main` at commit `482c1381a00d8d00bc81697e4a980c593db6803e` (2026-10-18), used only for unreleased changes | https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/CHANGELOG.md |
| POST | "Pi Durable", Earendil Engineering, 2026-10-01 | https://earendil.com/posts/pi-durable/ |
| HARNESS-POST | "What is a harness?" (background only; nothing below depends on it) | https://earendil.com/posts/what-is-a-harness/ |

Package facts (pkg.json): `"type": "module"`, exports are `import` only; `engines.node >= 22.19.0`; no `peerDependencies`; regular dependencies pinned exactly: `@earendil-works/chord 1.3.0`, `@earendil-works/pi-ai 1.3.0`, `@earendil-works/pi-codemode 1.3.0`, `typebox 1.3.27`, `diff 8.0.4`, `@silvia-odwyer/photon 0.3.3`. Subpath exports: `.`, `./env`, `./env/node`, `./codemode`, `./tool-search`, `./tools`, `./images`, `./images/node`, `./images/cloudflare`, `./storage/memory`, `./storage/jsonl`, `./storage/jsonl/node`, `./storage/sqlite`, `./storage/sqlite/cloudflare`, `./storage/sqlite/node`, `./testing`. The README install line also names `@earendil-works/pi-ai` and `@earendil-works/chord` (README, Installation). The coding agent package (`@earendil-works/pi-coding-agent`) is also at 1.3.0 at the tag (REPO `packages/coding-agent/package.json`); how it hosts Pi Durable was not part of this question and was not read.

## 1. Process and ownership

**One process owns a storage.** "One process owns a storage at a time; there is no cross-process locking." (README, Storage.) The post says the same and adds the attach model: "One process owns a storage at a time, and other clients attach to that process." and "everything a UI needs is committed state, so any number of clients can attach to any conversation in the harness." (POST.)

**Opening is a write, not a read.** `Harness.open(storage, options, context)` (d.ts `harness/harness.d.ts`; src https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/harness.ts#L447-L469) calls the scheduler's `open()`, which commits a transaction that rewrites every surviving `running` task to `pending`: "Load live tasks and change surviving `running` tasks back to `pending`. Dispatches nothing." (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/scheduler.ts#L288-L314.) The spec states it as "On open, running-task reconciliation changes surviving `running` tasks back to `pending`, preserving their checkpoint and abort mark" (SPEC §5.1, around L1915). Consequence, inferred, not stated by the sources: a second process that opens a storage another live process owns rewrites that process's running tasks, so even a "look only" open of a live storage is unsafe. `harness.inspect()` and the view/watch APIs are read-only once open, but the open itself is not.

**Open options.** `HarnessOptions` (d.ts `harness/types.d.ts`): `models: Models` (pi-ai; required even for task-only harnesses, the examples pass `createModels()` with no provider, EX-12, EX-13, EX-24), `registry: RegistryReader` (must come from `createRegistry()`, which holds the built-in tasks; open throws "Registry lacks built-in tasks ...; create it with createRegistry()" otherwise, harness.ts L453-L458), `settings?: HarnessSettings`, `env?: (target: EnvTarget, context) => ExecutionEnv | undefined | Promise<...>`, `conversationCreated?(tx, conversation)`, `now?: () => number`, `onReport?: (error) => void`. Every call takes a Chord `Context`; `BACKGROUND_CONTEXT` from `@earendil-works/chord/context` never cancels; "Cancelling a wait only cancels that wait, never the work." (README, Quick Start.)

**Root and resume.** `harness.root(context, { agent?, init? })` "Return the reserved root conversation, creating it with `agent` and `init` in one commit when absent" (d.ts `harness/types.d.ts`, `Harness.root`); the root always has ID 1 (`ROOT_CONVERSATION_ID`, EX-06 comment). Nothing runs until scheduling is enabled: `harness.resume()` "Enable task scheduling. Idempotent; throws after close. Calls that ask for progress enable it too: `Conversation.submit()`, `Conversation.compact()`, `Conversation.abort()`, `Submission.wait()`, `waitForTask()`, `Harness.waitForIdle()`, and `Conversation.waitForIdle()`. Read-only viewers never do." (d.ts `harness/types.d.ts`, `Harness.resume`.) "Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too." (README, Persist and Resume.) EX-13 opens a second Harness "that never resumes, so nothing runs" to read a saved record.

**Shutdown.** `harness.close(context)`: "Seal admission, settle admitted commits, then close storage." (d.ts `types.d.ts`, `Session.close`.) The spec: "`close()` marks the runtime closing, seals admission and reservation, signals invocations, and ends states and watches. Outside the Session line it settles admitted commits and joins invocations before closing storage. ... Later runtime commits reject, and close writes no task outcome. Closing starts no fresh phase or abort invocation. It does not set abort marks, terminalize tasks, retire task documents, or publish document retirement." (SPEC §5.1, around L1923-L1930.) "Closing waits for running task code to return, so code that ignores its abort signal delays `closed`." (README, Errors.) `harness.closed: Promise<SessionEnd>` settles `{ reason: "closed" }` or `{ reason: "failed", error }`; the README's restart idiom is `harness.closed.then((end) => { if (end.reason === "failed") reopen(end.error); })` (README, Errors). A storage error fails the Session: every later call rejects with `SessionFailed` (`cause` is the storage error), watches end with `session_failed`, and the Harness closes itself; "Reopen to recover" (README, Errors; d.ts `errors.d.ts`).

**Storage backends.** `openNodeSqliteStorage(path, { walAutoCheckpointPages?, busyTimeoutMs? (adapter default 5,000 ms), prefix? })` from `@earendil-works/pi-durable/storage/sqlite/node` on Node's built-in `node:sqlite` (d.ts `storage/sqlite/node.d.ts`); "WAL mode with `synchronous = NORMAL`: commits survive process crashes; the newest may be lost on power or host failure." `openNodeJsonlStorage(directory, context, { fsync? })` "Keeps the whole history in memory too ... use SQLite for long-running agents." `MemoryStorage`: "Nothing is persisted." (README, Storage.)

**Attaching from a second process.** The package has no server, daemon, lock or attach protocol. The in-process attach surface is `viewState()`, `watch()`, `watchEvents()`, `watchDoc()`, `watchTaskGraph()` (point 8); `watch()` is described as delivering "the exact Chord operations of each commit ... for example to a remote client that applies them" (README, Watching a Conversation). The transport is left to the host; `@earendil-works/chord` ships links (`memoryLinkPair`, `ipcLink`, `webSocketLink`, `acceptWebSockets`), `createHost`, and `@earendil-works/chord/node` lists `processLock` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/chord/README.md, Entry points; `processLock` semantics were not read). The spec's only words on it: "The hosting layer stops exposing Harness state to clients before it closes the Harness, for example by closing the Chord host whose objects serve it; reconnecting to a reopened Session hydrates the last committed state" (SPEC §5.1, L1927-L1930).

**The sources do not say:** whether two processes may ever open one SQLite file (they say only that there is no locking; the open-time write above makes it unsafe while the owner runs); how a CLI should detect a live owner; what happens to child processes of a running `bash` call when the owning process is killed.

## 2. Tasks

**Definition.** `defineTask<I, S extends { phase: string }, R, H extends object = object>(definition: TaskDefinition<I, S, R, H>): Task<I, S, R, H>` (d.ts `tasks.d.ts`). `TaskDefinition` (d.ts `types.d.ts`): `name` ("Registered task kind persisted in `TaskRecord.kind`"), `version`, `initial(input: I): S` ("First durable checkpoint"), `phases: { [P in S["phase"]]: PhaseHandler }` ("Exhaustive phase map; each handler receives the task narrowed to its phase"), `abort(task, runtime, context)` (required: "Runs in a fresh invocation after an abort mark and must commit a terminal outcome"), `migrate?(input, checkpoint, fromVersion)` ("runs at reservation"), `hooks?`. Tasks reach the Harness through an extension: `registry.install(defineExtension({ name: "payments", tasks: [Payment] }))` (EX-12); "pending tasks of an extension's `tasks` resume once it is installed" (README, Reload). Input, checkpoint and result are JSON (`TaskRecord<JsonValue, JsonValue, JsonValue>` in storage).

**Phases and `runtime.commit`.** `PhaseHandler = (task: RunningTask<I, P, R>, runtime: TaskRuntime<I, S, R, H>, context) => Promise<void>`: "It must commit a changed checkpoint or a terminal outcome through `runtime.commit()`; returning without durable progress faults the task." `runtime.commit(change: (tx, current) => NextTaskState<S, R> | undefined, context)`: "Commit on the Session line after rereading the task. Rejects when the task is terminal, the invocation ended, the Harness is closing, or, in a run invocation, the task carries an abort mark. A returned state replaces the task's state in the same commit; returning nothing leaves it unchanged. `tx.createTask()` defaults to the task's conversation. Inside the callback read only through `tx`" (d.ts `types.d.ts`, `TaskRuntime.commit`). `NextTaskState` is `{ status: "running", checkpoint }`, `{ status: "waiting", checkpoint, on: TaskId[], policy: JoinPolicy }` or `{ status: "terminal", outcome }`; a terminal state "is stored as `completing` while ordinary owned work below the task is live". `TaskOutcome<R>`: `completed { result }`, `failed { error: { message, detail? }, result? }`, `aborted { reason?, result? }`, `orphaned { reason }`, `faulted { error }`. `TaskState.status` in 1.3.0: `pending`, `running`, `waiting`, `completing`, `terminal` (d.ts `types.d.ts`).

After every phase the scheduler applies one rule (SPEC §5.1, L1895-L1912): terminal/completing/waiting: stop; Session closing: stop and keep the checkpoint; abort mark in run mode: end the run, start the abort invocation once owned work drained; uncaught error: `faulted`; checkpoint changed: next phase (same invocation or handover); checkpoint unchanged: `faulted` "because no durable progress was made".

**Waiting on children.** From the README (Child Tasks) and EX-24:

```ts
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ...commit the checkout's own outcome
},
```

"Waiting: the task runs no code while it waits. With `allSettled` it resumes once every task in `on` is done; with `failFast` the first failed child also aborts the others. `on` may name other tasks too, with `allSettled`." "Finishing: a task that finishes while work it owns is still running is `completing` ... `waitForTask()` returns, only once that work is done. A failed or aborted outcome aborts that work first." "Aborting: abort runs bottom-up." (README, Child Tasks.) `JoinPolicy = "failFast" | "allSettled"` (d.ts `types.d.ts`). A wait that closes a cycle is rejected by `runtime.commit()` since 1.2.0 (CHANGELOG 1.2.0, Fixed). In-memory alternatives inside a phase: `runtime.waitForTask(id, context)` ("rejects when the invocation ends"), `runtime.getTask`, `runtime.ownedTasks(context)` ("also those an earlier invocation created, before a restart"), `runtime.abortOwned(id, context)` (d.ts `types.d.ts`).

**Ownership and background.** `TaskOptions`: `ownership: { kind: "conversation" } | { kind: "task", taskId }` (required), `conversationId?`, `background?` ("Conversation-owned tasks only: excluded from ordinary idle waits, conversation aborts, and cascades"), `abandonOnRestart?` (d.ts `types.d.ts`). "A task created with `{ background: true }` is a boundary: work it owns survives the parent's abort and does not keep the parent busy. `root.abort(context, { background: true })` aborts it too." (README, Abort and Subagents.) EX-23 uses a background `Anchor` task that completes at once purely to own a long-lived subagent conversation, and background `Reporter` tasks.

**Abort trees.** `harness.abortTask(id, context): "marked" | "terminal"` "Commit the abort mark, signal and join an active run invocation, and schedule the abort invocation. A task whose definition cannot take it settles as `orphaned` instead." `Conversation.abort(context, { background? })`: "Withdraw queued inputs (queued writes stay), mark every live non-background task of the ordinary ownership scope, signal them, and resolve once the scope is idle. Background subtrees survive unless `background` is set." (d.ts `harness/types.d.ts`.) `runtime.signal: AbortSignal` "Aborted when the run is signalled by `abortTask()`, the Harness closes, or the invocation ends." (d.ts `types.d.ts`.) Post: "Aborting a task aborts what it owns, bottom-up, so every task cleans up its own effects first" (POST).

**Sleeping and timers in 1.3.0.** There is no `sleepUntil`. `TaskRuntime.sleep(until: number, context): Promise<void>` "Resolve once the Harness clock reaches `until`; rejects when the invocation or `context` is cancelled." (d.ts `types.d.ts`; src https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/types.ts#L239.) It is implemented as a loop that re-checks `until - now()` after a real `delay(min(remaining, MAX_TIMER_DELAY))` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/scheduler.ts#L1812-L1823), so it holds the invocation; after a restart the phase reruns and the wait starts over (EX-24 keeps the wake time in the checkpoint: `initial: () => ({ phase: "charge", at: Date.now() + 100 })` then `runtime.sleep(task.state.checkpoint.at, ctx)`). `runtime.now()` reads the Harness clock. There is no `setTimer` anywhere in 1.3.0 (`HarnessOptions` has `now` only).

Unreleased on MAIN: "`TaskRuntime.sleep()` is removed ... A task now ends its phase asleep with `runtime.sleepUntil(until, checkpoint, context)` or by returning `{ status: "sleeping", until, checkpoint }` from `runtime.commit()` ... `TaskRuntime.setTimer()` paces work inside a phase"; a new `sleeping` status; `HarnessOptions.setTimer`; `Harness.wake()` / `onWake`; a crash-loop guard `settings.restartLimit` (default 5) with `Harness.retryTask(id)`; SQLite schema version 2 that 1.3.0 cannot open (MAIN CHANGELOG, Unreleased; types at https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/types.ts#L311-L329).

**Inspection.** `harness.inspect(context)` -> `{ scheduling: "paused" | "running" | "closing", tasks: TaskInspection[], submissions }`; `TaskInspection.state.kind` is `running`, `ready { migrates }`, `waiting { on }`, `completing`, or `blocked { reason: "missing_task" | "task_too_old" | "migration_failed" }`; "Writes nothing and runs no task code." `harness.waitForTask(id, context): SettledTask<R>`; `harness.getTask(id, context)` (d.ts `harness/types.d.ts`). Task records carry `startedAt` / `endedAt` stamped with the Harness clock (CHANGELOG 1.1.0; d.ts `types.d.ts`).

**Closest examples to "one task per ticket, one child per step".** EX-24 (`Checkout` owns four `Payment` children, waits `failFast`, decides in the next phase; shows abort, and a close mid-payments followed by reopen) is the closest in shape but fans out in parallel. EX-23's `Reporter` is the closest in behaviour to an agent Step: a two-phase task whose `deliver` phase submits to a conversation with `requestId: \`subagent:${reporter.id}\``, awaits `submission.wait()`, and records the answer in one commit "so a restart does not decide again", then `report` posts the result upstream. EX-13 (`Ticker`) shows a multi-phase task with `memo` guarding a side effect across a close. EX-12 shows the intent/effect/outcome pattern. **The sources do not show** a sequential chain with one child task per phase; every part of it exists, but no example composes them that way.

## 3. Subagents as runners

**Creating an owned conversation.** From a tool call (README, Abort and Subagents; EX-22; identical code in `test/spec-usage.test.ts` §7.3):

```ts
const child = await api.commit(async (tx) => {
	const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
	if (existing !== undefined) return existing.id;
	const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
	await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
	return created.id;
}, context);
```

The same `Tx` methods are available inside `runtime.commit()` of a task phase, and the task may own the conversation (`ownership: { kind: "task", taskId: task.id }`); a task created earlier in the same commit may already own one (EX-03). "A task-owned conversation, such as a subagent's, starts as a copy of its owner's conversation's agent." (README, Per-Conversation Agent; `createAgent` in d.ts `harness/agent.d.ts`: "a new task-owned conversation copies the stored agent of its owner task's conversation; a new ownerless one starts empty".) "Pi Durable has no built-in subagents, but they take a few lines of code to build" (POST).

**Configuring model, thinking, tools, cwd, extensions.** `configure(tx, conversationId, change: AgentChange)` is exported from the package root (d.ts `harness/agent.d.ts`); `Conversation.configure(change, context)` does it in its own commit; `createConversation({ ownership, agent, init })`, `fork()` and `root()` take the same `agent` change (d.ts `harness/types.d.ts`). `AgentChange` fields: `model: { provider, modelId } | null`, `thinkingLevel: ModelThinkingLevel | null` (pi-ai; examples use `"minimal"`, `"low"`, `"high"`), `extensions: Extension[] | { add?, remove? } | null`, `tools: ToolRegistration[] | { remove } | null`, `modelTools`, `instructions: string | null` ("Rendered after every extension section, as the section `instructions`"), `cwd: string | null`. Values are stored by name in the `pi.agent` document (`AgentDoc`, rewindable) and resolved against the registry at each use; `null` clears a field back to the host default. "The model, prompt, and offered tools of a request are fixed when it is prepared; a change applies from the next request ... the environment is built from the current `cwd` at each use" (README, Per-Conversation Agent). EX-28 builds a reviewer with `agent: { model: { provider: "faux", modelId: "small" }, extensions: [CodingTools, Reviewer], tools: [createReadTool()], cwd: worktree }` and notes the worktree is "in practice a `git worktree add`". The conversation's `cwd` reaches tools through `HarnessOptions.env`, for example `env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() })` (README, Environment; EX-26).

**Submitting with `requestId`.** `ConversationHandle.submit(submission: InputSubmissionDraft, context): Promise<Submission>` where the draft is `{ type: "input", content, requestId?, whenBusy?: "steer" | "followUp" | "reject", entry? }` (d.ts `harness/types.d.ts`). `requestId` is a "Host-provided deduplication key, scoped to the conversation" (d.ts `types.d.ts`, `SubmissionRecord`); "A retried submission with the same `requestId` returns the existing submission instead of submitting twice ... After a restart: the same request ID finds the same submission." (README, Persist and Resume.) A task gets the handle with `runtime.conversation(id, context)`, a tool with `api.conversation(id, context)`; both are "Invocation-bound ... admitted work stays durable" (d.ts `types.d.ts`). `harness.submission(id, context)` reacquires a submission after reopen.

**Waiting.** `submission.wait(context): Promise<SettledSubmissionRecord>` resolves `{ status: "done", entry, answer: EntryId }` or `{ status: "unanswered", reason, detail? }`; `submission.status(context)`; `submission.abort(context): "aborted" | "already_placed" | "settled"` (d.ts `harness/types.d.ts`). `handle.waitForIdle(context)` resolves when the conversation's ordinary ownership scope has no live non-background task. Busy check used by EX-23: `(await api.snapshot(LiveDoc, id, ctx))?.run !== undefined`.

**Reading the result.** The answer is an `AssistantEntry` whose `model[0]` is a pi-ai `AssistantMessage`: `const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx); const text = (entry?.model?.[0] as AssistantMessage).content.flatMap((c) => c.type === "text" ? [c.text] : []).join("")` (EX-22 `answerText`; README Quick Start; a task uses `runtime.entry(AssistantEntry, id, context)`). For structured output the examples have the subagent write a typed document through a tool: EX-27's `submit_plan` tool writes `PlanDoc` in `api.commit` and returns `control: { terminate: true }`, which ends the run without another model request (README, Tools). Tools can also return `structuredOutput` validated against `structuredOutputSchema`, but that reaches programs only through `api.executeTool()` (nested calls), not through a transcript entry (README, Tools).

**Steering and stopping.** `submit({ ..., whenBusy: "steer" })` "placed after the current tool round"; `"followUp"` (default) starts the next run; `"reject"` throws `ConversationBusy`; `await submission.abort(context)` withdraws a queued one (README, Busy Conversations; EX-20, EX-23). `handle.abort(context)` "withdraw queued inputs, abort the ordinary ownership scope, and wait until it is idle" (d.ts `harness/types.d.ts`); EX-23's `stop` action does exactly this and the conversation "stays usable". Aborting the owning task or tool call aborts the child; so does the call failing (README, Abort and Subagents). Per-request timeout is `settings.stream.timeoutMs`; provider retries `settings.retry` (README, Settings).

**Which model actually ran.** The committed `AssistantMessage` carries `api`, `provider`, `model`, `responseModel?` ("Concrete model reported by the provider when different from the requested `model`"), `providerThinkingLevel?`, `thinkingLevel?`, `usage`, `stopReason`, `timestamp`, `durationMs` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/types.ts#L570-L598). Spend per `provider/modelId` is in the conversation's `pi.usage` (`UsageDoc`, `UsageState.models` keyed `"provider/modelId"`, d.ts `harness/usage.d.ts`) and Session-wide in `harness.usage(context)`. `conversation.agent(context)` returns the resolved `Agent` (`model?`, `thinkingLevel`, `extensions`, `tools`, `callable`, `deferred`, `sections`, `instructions?`, `cwd?`) as the next request would use it, not what ran (d.ts `harness/types.d.ts`).

**The sources do not say:** any per-run deadline or token budget on a conversation (only per-request stream timeout and compaction thresholds); how to receive a subagent's final answer as typed data without a tool that writes a document.

## 4. Shell as a runner

**`env.exec`.** `ExecutionEnv extends FileSystem, Shell`; `Shell.exec(command: string | readonly string[], options: ShellExecOptions | undefined, context): Promise<Result<ShellExecResult, ExecutionError>>`: "A string runs through the environment's shell. An array runs `command[0]` directly with the rest as its arguments, without a shell ... Aborting the context or a timeout kills only this command's processes." `ShellExecOptions`: `cwd?`, `env?`, `inheritEnv?`, `timeout?`, `onOutput?(text, context, info: { stream: "stdout" | "stderr", skipped? })` ("raw, unbounded, and unthrottled"), `spill?: { afterBytes, afterLines }`, `window?`. `ShellExecResult`: `{ exitCode, spillPath? }`. `ExecutionError.code`: `aborted | timeout | shell_unavailable | spawn_error | callback_error | unknown`. `cleanup(context)` "Kill every command this environment still runs; for its owner's shutdown, never for one request." (d.ts `env/index.d.ts`.) README example: `await env.exec(["git", "status", "--porcelain=v2", "-z"], { onOutput: (text, _context, { stream }) => { status[stream] += text; } }, context)` (README, Environment). `NodeExecutionEnv({ cwd, shellPath?, shellEnv?, watch? })` from `@earendil-works/pi-durable/env/node`; its `id` is shared: "Every local environment sees the same files." (d.ts `env/node.d.ts`.) A task reaches the environment with `runtime.env(context)` ("Calls `HarnessOptions.env` for the task's conversation"), a tool with `api.env` (d.ts).

**The `bash` tool.** `createBashTool({ commandPrefix?, prepare? })` from `@earendil-works/pi-durable/tools`, schema `{ command: string, timeout?: number }` (seconds), `ShellStructuredOutput = { output, truncated, fullOutputPath?, exitCode }` (d.ts `tools/bash.d.ts`). It runs `commandPrefix + "\n" + command` in `requireEnv(api).cwd` with `inheritEnv: true`, and `prepare(execution: { command, cwd, env, inheritEnv }, api, context)` may change any of them (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/tools/bash.ts#L68-L76). No timeout is passed unless the model gives one (bash.ts L103). Output streams to `api.output()` with `outputLimits: { retain: "tail" }` (bash.ts L151); the defaults are `DEFAULT_MAX_LINES = 2000` and `DEFAULT_MAX_BYTES = 50 * 1024` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/truncate.ts#L12-L13, applied in https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/tool.ts#L278-L279); the full output spills to a file after the same thresholds and is reported as diagnostic `code: "full_output"` (bash.ts L105, L117). "A nonzero exit is an error result with the exit code; a timeout throws, which makes an error result that still carries the output and diagnostics." (d.ts `tools/bash.d.ts`; CHANGELOG 1.2.0: `exit_code` diagnostic.) `CodingTools` / `createCodingTools()` bundles `read`, `write`, `edit`, `bash`; `createPowerShellTool()` adds `powershell` (d.ts `tools/index.d.ts`). `createBashTool({ commandPrefix: "source .venv/bin/activate" })` as a same-name override for selected conversations, and `wrapTool()` to time whichever bash won: EX-30, README Tools.

**cwd.** The environment is built from the conversation's agent `cwd` at each tool call and section render, so `configure({ cwd })` moves later calls without a restart (README, Environment; EX-26 shows `bash ran in:` changing after `root.configure({ cwd: join(workspace, "app") })`). Per-conversation sandboxes come from a document the env builder reads (EX-29).

**Calling bash from code.** Only a tool can: `api.executeTool("bash", { command: "npm test" }, context, { progress: false })` returns `NestedToolExecutionResult` with `structuredOutput.exitCode` ("Absent when bash did not finish, for example on a timeout") (README, Calling tools from tools). `TaskRuntime` has no `executeTool`, so a Gate inside a task phase uses `runtime.env()` and `env.exec()` directly and bounds output itself (`OutputBuffer` in `@earendil-works/chord/output` provides head/tail windows, chord README, Entry points).

**The sources do not say:** what the `bash` tool's default shell is beyond "the environment's shell" (`NodeExecutionEnv.shellPath`); the fate of child processes after a hard crash of the owning process.

## 5. Crash semantics

**Tool calls.** "Each call runs as its own durable task. Its intent is committed before `execute()` runs. If the process dies mid-call, the tool reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result with the output committed so far." (README, Tools.) `ToolRegistration.replay?: "safe" | "unsafe"`, "Default `unsafe`" (d.ts `harness/types.d.ts`). The tool task's checkpoint is `{ phase: "call" }` then `{ phase: "execute", arguments, replay }`: "`execute` is reached only by recovery and applies the replay rule" (d.ts `harness/tool.d.ts`). The messages are "Tool <name> was interrupted and may have partially run" and "... interrupted by a restart and may have partially run", diagnostic code `interrupted` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/tool.ts#L188-L201). Post: "After a crash, a tool reruns only if it says that is safe." A replay-safe subagent tool finds its child by `scanConversations({ ownerTaskId })` and its submission by `requestId` (EX-22). A crash that interrupts a replay-unsafe call aborts the child conversation the call owned (README, Abort and Subagents) and abandons its nested calls (`abandonOnRestart`, README "Tasks a restart abandons").

**Model requests.** An interrupted request is resent and its partial answer "stays in the transcript marked as aborted" (POST; `settleSchedulerOutcome` comment in d.ts `harness/live.d.ts`). Partials and tool output are committed at most every 100 ms, "so a crash loses at most that window" (README, Watching a Conversation).

**Task phases.** On reopen, surviving `running` tasks become `pending` with their checkpoint (point 1); reservation reruns the phase named by the checkpoint. The effect sandwich: "commit intent phase / perform external effect / commit outcome or next phase. Reopening in an intent phase means the effect may have happened. The phase handler retries safely, polls an external handle, or records interruption." (SPEC §5.2, L1934-L1945.) EX-12's comment: "A crash between doing and saving reruns that step, so the step must be safe to repeat."

**`api.memo` / `runtime.memo` / `HookApi.memo`.** `memo(name, context)` reads; `memo(name, candidate, context)` "Store `candidate` unless a memo already exists; return the durable winner." Memos are "Small first-writer-wins values retained while the task can run" (`TaskRecord.memos`) and "disappear in the terminal replacement" (d.ts `types.d.ts`; SPEC §5.2). EX-13 guards a side effect: `if ((await runtime.memo(\`printed-${n}\`, ctx)) === undefined) { await runtime.memo(\`printed-${n}\`, true, ctx); console.log(...) }`, and the example closes the Harness between the effect and its checkpoint to show the memo preventing a repeat. Post: "a small value stored with the task, where the first write wins."

**A half-done implementor Step after a crash, by Runner shape.**

- Step as a task phase that submitted to an owned subagent conversation and is inside `submission.wait()`: the phase reruns; `submit` with the same `requestId` returns the existing submission; `wait` continues. The subagent's own `pi.generation` and `pi.tool` tasks are durable and resume on their own (README, Concepts and Persist and Resume). Inside the subagent, a `bash` call that was running is `unsafe` by default, so the model sees `interrupted` and decides what to do; `read`, `write`, `edit` follow their own policies (not checked here).
- Step as a shell command run with `env.exec` inside a phase: the phase reruns and runs the command again. Make the command idempotent, or commit intent (and a `memo`) before it and check external state on rerun.
- Step as a tool call: replay-safe tools reattach; replay-unsafe tools end with `interrupted` and their owned conversation is aborted.

**What a restart looks like in storage.** The step task is `pending` (shown as `ready` by `inspect()`), `startedAt` set, `endedAt` absent; the ticket task is `waiting` on it; the subagent conversation's `pi.live` may still carry `run` and a `generation.attempt`; "After a restart, tasks that were `running` show as `pending` until they run again." (README, Task Graph.) There is no "crashed" status or restart counter in 1.3.0; MAIN adds `TaskRecord.restarts` and parks a task after `settings.restartLimit` (default 5) crashes without a new state (MAIN CHANGELOG). A storage error is not a crash: it fails the Session, which closes itself; reopen (README, Errors).

**The sources do not say** (for 1.3.0): what happens when a phase crashes the process every time (the unreleased guard implies it reruns without limit); whether `abandonOnRestart` applies to anything other than tasks a replay-unsafe tool created (it is opt-in elsewhere).

## 6. Typed state

**Definition.** `defineDoc<T extends JsonObject>(definition)` with overloads per scope (d.ts `documents.d.ts`): `{ kind, version, initial(): T, migrate?(value, fromVersion): T, checkpointWhen?(value, ops, info) }` plus semantics `scope: "session"` (singleton per storage), `scope: "conversation"` with `history: "latest"` and `fork: "current" | "initial"`, or `history: "rewindable"` and `fork: "asOf" | "current" | "initial"`, or `scope: "task"` (d.ts `types.d.ts`, `DocumentSemantics`). `defineDocFamily<T, I>({ ..., family: true, initial(seed: I): T })` defines keyed members addressed as `tx.doc(Family, conversationId, key, seed)` (d.ts `documents.d.ts`, `Tx.doc` overloads). README example:

```ts
const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest", // or "rewindable" to read old values with snapshotAsOf()
	fork: "initial", // what a fork starts with: "initial", "current", or "asOf"
	initial: () => ({ items: [] }),
});
await root.commit(async (tx) => { (await tx.doc(Todos, root.id)).items.push("write docs"); }, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

**Access.** `tx.doc(token, ...)` returns a Chord `Draft<T>` created on first use; "Plain assignments to it are saved when the commit finishes" (EX-01); drafts are revoked after their commit (`test/spec-usage.test.ts`, `revokedDraft`). `tx.retireDoc(...)`. Reads: `harness.snapshot(token, ...)`, `harness.snapshotAsOf(token, conversationId, at: EntryId)` (rewindable only), `harness.documentState(...)` (Chord state), `harness.watchDoc(...)`; tasks read through `runtime.snapshot` / `runtime.watchDoc`, tools through `api.snapshot`, prompt sections through `input.read.snapshot`, the env builder through `read.snapshot` (d.ts `types.d.ts` `DocumentReader`/`DocumentObserver`; EX-11, EX-29). Documents change "in the same atomic commits" as entries and task state (POST; README, Concepts).

**History and fork.** `latest` keeps only the current value; `rewindable` keeps history for `snapshotAsOf` (EX-01 reads "notes at first entry"). `fork` says what a forked conversation starts with: the initial value, the parent's current value, or (`asOf`, rewindable only) the parent's value at the fork entry (EX-02; README, Your Own State). Session documents have no history or fork; task documents retire with their task ("Task documents also retire with their task", SPEC §4; `NestedCallDoc` is a task-scoped family, d.ts `harness/tool.d.ts`).

**Versions.** `version` is a "Positive integer version of the stored value shape"; `migrate(value, fromVersion)` converts older stored values; `checkpointWhen` stores a full base instead of a delta (d.ts `types.d.ts`, `CommonDocDefinition`). Appends to arrays are cheap since 1.2.0 ("32,000 one-item appends, one commit each, take 1.4 s", CHANGELOG 1.2.0).

**Seeding.** `HarnessOptions.conversationCreated(tx, conversation)` "runs in every commit that creates or forks a conversation ... so every conversation gets your documents"; `init` in `createConversation()`, `fork()` and `root()` writes per-call data in the creating commit (README, Your Own State; EX-06, EX-29).

**Built-in documents.** `pi.agent` (`AgentDoc`, rewindable), `pi.provider` (`ProviderDoc`), `pi.live` (`LiveDoc`), `pi.inbox` (`InboxDoc`), `pi.usage` (`UsageDoc`), all exported (d.ts `index.d.ts`).

**Per-ticket records in the examples.** EX-23's `Subagents` document maps names to `{ conversationId, reported: EntryId[] }` and keeps `reporters: Record<string, TaskId>`; EX-03's `AgentRegistry` stores a `requestId` next to each child conversation "so a retry after a crash cannot deliver it twice"; EX-27 keeps a plan; EX-29 keeps a sandbox path read by the env builder.

**The sources do not say:** that document values are validated against a schema at runtime (the definition has no schema field; `materializeDocument` checks scope and version); how to enumerate documents of a scope from a Harness (`Storage.scanDocuments` exists on the storage interface, but `Tx`, `Session` and `Harness` expose no scan).

## 7. Testing

**`MemoryStorage`.** Exported from the package root and `./storage/memory`: "Detached in-memory reference implementation of `Storage`." (d.ts `storage/memory.d.ts`.) `Storage.close()` requires that "all later operations must reject" (d.ts `types.d.ts`), so a closed `MemoryStorage` cannot be reopened as is. The repo's tests subclass it: `ControlledStorage extends MemoryStorage` with `reopen()` ("Reopen after `close()`, as a fresh process would reopen the same database, keeping every committed record", which resets the private `closed` flag), `crash()` ("Simulate a crash during the held commit: it never reaches storage"), `holdCommits()`, `failNextCommit(error)` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/session-support.ts). Crash tests abandon the first Harness without closing it ("the crashed Harness is abandoned without close", https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/harness-tasks-recovery.test.ts#L249) and open a second one over the same storage; other recovery tests use a temp SQLite file and `close()` then reopen.

**Fake clock.** `HarnessOptions.now?: () => number` (also `createSession(storage, { now, documentRetentionMs })`); `safeNow` falls back to `Date.now` if `now` throws (d.ts `harness/harness.d.ts`). Tests pass a mutable number: `openRoot([Waiter, Held], { now: () => clock })`, then `clock = 2_000; harness.resume();` and assert `startedAt` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/harness-tasks.test.ts#L328-L348). For `sleep`: "The clock stands still, so real timers keep firing without waking the task." then `clock = 1_005; await harness.waitForTask(id, context)` (same file, L694-L709). Because `sleep` re-checks the clock only when its real timer fires (point 2), a fake-clock sleep wakes no earlier than `until - now` real milliseconds after it started. There is no `setTimer` injection in 1.3.0; MAIN adds `HarnessOptions.setTimer` ("Tests can pass fake timers", https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/types.ts#L629-L636).

**Conformance suite.** From `@earendil-works/pi-durable/testing`: `registerStorageConformance(runner: { describe, expect, it }, name, withStorage: (use) => Promise<void>)`, `createStorageConformance({ assertions, withStorage }): StorageConformanceCase[]`, `registerEnvConformance(runner, name, withEnv, { shell?, symlinks?, listFiles? })`, `createEnvConformance(...)`, `createExpectAssertions(expect)`, plus storage benchmarks (`seedStorageBenchmark`, `STORAGE_READ_BENCHMARKS`, `STORAGE_WRITE_BENCHMARKS`) (d.ts `testing/index.d.ts`, `testing/runner.d.ts`, `testing/types.d.ts`; README, Storage). It matters only for a custom `Storage` or `ExecutionEnv`.

**How the examples are tested.** The examples are standalone scripts: `node --conditions=source --experimental-strip-types test/examples/14-chat.ts` (README, Examples). Most use pi-ai's faux provider so no network is needed: `const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("...")])])` from `@earendil-works/pi-ai/providers/faux` (EX-18, EX-19); responses may be functions (`FauxResponseStep`) that route on the request (EX-23), and `fauxProvider({ tokensPerSecond, models: [{ id, contextWindow, maxTokens }] })` shapes streaming and context windows (EX-21, EX-25). `test/spec-usage.test.ts` compile-checks the spec's snippets and says "`test/examples/` runs the same patterns end to end", but no vitest file imports or runs the examples (grep of `packages/durable/test`); the package test script is `vitest --run && PI_DURABLE_DOCUMENT_RETENTION_MS=0 vitest --run` (pkg.json). Task tests use small helpers: `openTasks(storage, tasks, { now?, settings? })` collecting `onReport` errors into an array, `completed(result)`, `abortedWith(reason)`, `eventually(check)` (flushes up to 200 macrotasks), `settled(promise)`, `deferred()` (https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/task-support.ts) and `flush()` (one `setTimeout(0)`, `test/session-support.ts`).

**The sources do not say:** whether CI runs the example scripts (the repo's workflow files were not read); any public helper for reopening a `MemoryStorage` (the test subclass pokes a private field).

## 8. Watching

**`viewState()`.** `conversation.viewState(context): Promise<AttachedReplicatedState<ConversationView>>`; `ConversationView = { conversation: ConversationRecord, entries: EntryRecord[] (the active transcript), docs: Record<kind, JsonObject> }` (d.ts `harness/view.d.ts`). `view.value`, `view.subscribe((value) => ...)`, `view.dispose()`; `value.docs["pi.live"]` holds the running generation ("streamed partial, retry, deferred") and tool calls (output, details), plus `pi.inbox`, `pi.usage`, `pi.agent`, `pi.provider` (README, Watching a Conversation; EX-21 reads `live.tools?.[0]?.output` mid-run).

**`watch()`.** `conversation.watch(context): Promise<ConversationWatch>` (`WatchHandle<ConversationView>`): `watch.value` ("the state at attachment"), `watch.start(async (value, ops, context) => ...)` ("Install the sole asynchronous listener. Never invokes it inline."), `await watch.stop(): WatchEnd`, `watch.closed`. "A slow watch keeps at most 100 undelivered frames. After that, the pending frames are replaced by one frame holding the whole newest view. A client that joins late or reconnects starts from the current view; nothing is replayed." (README; d.ts `types.d.ts` `WatchHandle`.) `WatchEnd.reason`: `stopped | cancelled | session_closed | retired | listener_error | session_failed`. The post: "For a remote client, `thread.watch()` delivers the exact operations of every commit" (POST). EX-19 `--ops` prints `{ view }` then one `{ ops }` line per commit.

**`watchEvents()`.** `watchEvents(harness, conversationId, context): Promise<AgentEventStream>` with `stream.snapshot: SnapshotEvent` and `stream.start(async (events: AgentEvent[]) => ...)`, one batch per commit; marked "Experimental" (d.ts `harness/events.d.ts`; README, Agent Events). `SnapshotEvent` carries `entries`, `run?`, `generation?`, `tools`, `nestedTools`, `compactions`, `compactionFailure?`, `inbox`, `agent`, `usage`. Event types: `run_start`, `run_end`, `turn_start`, `turn_end`, `message_start`, `message_update { usage, changes: MessageChange[] }`, `message_end { entry }`, `tool_execution_start { args, toolCallId, toolName, taskId?, parentToolCallId?, parentTaskId? }`, `tool_execution_update { output?: { trimStart?, append? } | { set }, details?, diagnostics? }`, `tool_execution_end { entry? | result? }`, `inbox_update`, `submission { record }`, `auto_retry_start/end`, `deferred_poll`, `entry_appended`, `agent_changed`, `usage_changed`, `task_failed { taskId, kind, message }`, `compaction_start`, `compaction_end { error? }`. "When a consumer falls more than 100 batches behind, it receives a fresh `snapshot` event instead." (README.) EX-22 attaches to a child conversation when a parent tool's `details.conversationId` appears; EX-23 prints a transcript from `message_end`.

**Other handles.** `harness.watchDoc(token, ...)` and `harness.documentState(token, ...)` per document (EX-16 streams partials from `LiveDoc`); `harness.taskGraph(context)` / `harness.watchTaskGraph(context)` give `TaskGraph { tasks: Record<id, TaskGraphNode> }` with `kind`, `conversationId`, `owner?`, `background`, `abortRequested`, `state` (`pending | running` with `phase`, `waiting { on, policy }`, `completing { outcome }`), `conversations[]` (d.ts `harness/task-graph.d.ts`; EX-24 prints the tree); `harness.inspect(context)` for blocked reasons; `session.subscribeCommits(listener)` for every publication, synchronous on the Session line, "must not block or call Session APIs" (d.ts `types.d.ts`). Attach before submitting "so the stream covers the whole run" (EX-19).

**What a CLI `show` / `tail` needs.** In the owning process: `watchEvents` or `watch` on the conversation of interest, `watchTaskGraph` for the Step tree, `watchDoc` for per-ticket documents, `inspect` once for blocked work. From another terminal: a connection to the owning process (point 1), because opening the storage is a write. EX-18 (print mode) and EX-19 (JSON lines) are the single-process shapes. **The sources do not say** how a second process should attach; nothing in the package or examples does it.

## 9. Versioning

**Current.** 1.3.0 is the npm `latest` (dist-tags), published 2026-10-15T19:13:35Z (`npm view ... time`); tag `v1.3.0` is commit `71023aec1546d6d677a65669c5665c0927ce0dd0`, "Release v1.3.0" (REPO). The monorepo releases in lockstep: `pi-ai`, `chord`, `pi-codemode`, `pi-coding-agent` are all 1.3.0 at the tag and `pi-durable` pins them exactly (pkg.json).

**Cadence** (npm publish times): 0.0.1 2026-09-19; 0.86.0 09-19; 0.86.1 09-20; 0.87.0 09-21; 0.87.1 09-22; 0.99.0 and 0.99.1 09-29; 0.99.2 09-30; 1.0.0 10-01; 1.0.1 10-03; 1.0.2 10-04; 1.0.3 10-05; 1.0.4 10-05; 1.1.0 10-07; 1.2.0 10-12; 1.3.0 10-15. Eight releases in the 15 days since 1.0.0; a minor every three to five days.

**Stability notes.** README banner: "Experimental. The API changes without notice between releases." Post: "Pi Durable is experimental, and the API might still change." Agent events carry a second "Experimental" label (README, Agent Events). Breaking changes shipped in patch releases (1.0.3, 1.0.4) and minors (1.1.0, 1.2.0), so the version number does not signal compatibility.

**Breaking changes 1.0.0 to 1.3.0** (CHANGELOG, "Breaking Changes" sections):

- 1.0.3: `FileSystem` requires `openBinaryReader()`, `openDirReader()`, `watch()`; `BinaryReader` requires `scanLines()`; `Shell.exec()` accepts an argv array and `onOutput` gains a third `info` argument.
- 1.0.4: `NodeExecutionEnv.watch()` fails with `permission_denied` where it used to watch as missing; the env conformance suite checks three more `watch()` behaviours.
- 1.1.0: `Storage` must honour `order` on `ConversationQuery`, `EntryQuery`, `TaskQuery`, `SubmissionQuery`; `TaskRuntime.context(conversationId, context, { at })` replaces the positional `at`.
- 1.2.0: `ToolTaskInput` / `ToolTaskResult` are tagged unions (`kind: "model" | "nested"`; `pi.tool` is version 2 and migrates live tasks); `ToolExecutionResult.content` renamed `output`; `bash` / `powershell` answer a nonzero exit with an error result instead of throwing; any `Storage` error fails the Session (`StorageRejected` removed, `StorageRequestError` added); throwing `subscribeCommits()` / `subscribeClose()` listeners are reported instead of failing the operation; display-only write submissions are appended at once.
- 1.3.0: none (additions: `SqliteStorage.open(database, { prefix })`; fixes to the compaction baseline and image encoding).

**Already on MAIN, unreleased:** `TaskRuntime.sleep()` removed in favour of `sleepUntil()` / `{ status: "sleeping" }`; a `sleeping` task status; SQLite schema version 2 ("A migrated database cannot be opened by 1.3.0 or earlier"); `TaskRuntime.setTimer()` and `ToolExecutionApi.now()` required on hand-built fakes; crash-loop guard `settings.restartLimit`; `ToolControl.terminate` typed `boolean`; `onReport(error, info)`; `HarnessOptions.models` and `settings` may be functions; `Harness.wake()` / `onWake`; SQLite drivers moved to `@earendil-works/chord/sqlite` (MAIN CHANGELOG, Unreleased).

**The sources do not say:** anything about a deprecation policy, support window, or when the API will be called stable; the CHANGELOG has no "Deprecated" entries.

## What this means for the v2 engine

**Process and ownership model for a terminal CLI.**

1. The storage file is the unit of ownership and exactly one process opens it at a time. `Harness.open` writes (running to pending) and nothing locks, so the CLI needs its own single-owner guard outside Pi Durable: a lock file with the PID next to the SQLite file, or Chord's `processLock` once its semantics are checked. This is the one piece of liveness ADR 0001 did not list; it is small and should live in the thin seam.
2. Phase 1 shape: `orch run <ticket>` is the owning process for the life of the run. It builds the registry (`createRegistry()`, then `registry.install(...)` for the engine's tasks and the runners' tools), opens `openNodeSqliteStorage(path)`, calls `Harness.open(storage, { models, registry, env, settings, now, onReport }, BACKGROUND_CONTEXT)`, `harness.root(ctx)`, creates or finds the ticket task, calls `harness.resume()`, awaits `harness.waitForTask(ticketTaskId, ctx)`, and `harness.close(ctx)`. It subscribes `harness.closed` and reopens on `{ reason: "failed" }`. On SIGINT it calls `close()`: running Steps stay `running` in storage and resume on the next `orch run`, which is also the resume command (no separate resume path; `requestId`s make resubmission idempotent).
3. `orch show` / `orch tail` with a live owner connect to that process over a local socket (Chord `ipcLink` / `webSocketLink`, or a JSON-lines stream the engine writes from `watchEvents()` and `watchTaskGraph()`); without a live owner they open the file, read `inspect()`, `snapshot(Ledger)` and the task graph, and close. Read-only viewers never start scheduling, so an open without `resume()` runs nothing.
4. One storage file per project (all tickets of a project in one file) keeps `harness.waitForIdle()` and the task graph meaningful per project; one file per ticket makes ownership trivially per run. Either works with the APIs above; the choice is a v2 decision, not a Pi Durable constraint.

**One task per Ticket, one child task per Step.** One ownerless conversation per ticket (`harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: worktree }, init })`) holds the ticket's documents and lets `conversation.abort()` cancel the whole ticket. The ticket task is conversation-owned; each Step is a child task it owns; the Workflow (ordered list of `{ name, kind, config }`) is task input, so a project override is different input, not different code. Step kinds map to task definitions by `name` in the registry.

```ts
type StepRef = { name: string; kind: string; config: JsonObject };
type TicketState =
	| { phase: "next"; index: number }
	| { phase: "gate"; index: number; child: TaskId<StepResult> };

const Ticket = defineTask<{ ticket: number; workflow: StepRef[] }, TicketState, { merged: boolean }>({
	name: "orch.ticket",
	version: 1,
	initial: () => ({ phase: "next", index: 0 }),
	phases: {
		next: async (task, runtime, ctx) => {
			const { index } = task.state.checkpoint;
			const step = task.input.workflow[index];
			if (step === undefined) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { merged: true } } }), ctx);
				return;
			}
			await runtime.commit(async (tx) => {
				const child = await tx.createTask(stepTask(step.kind), { ticket: task.input.ticket, step }, {
					ownership: { kind: "task", taskId: task.id },
				});
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				ledger.steps.push({ name: step.name, kind: step.kind, task: child, status: "running", startedAt: runtime.now() });
				// The ticket runs no code while the step runs; a crash leaves it waiting.
				return { status: "waiting", checkpoint: { phase: "gate", index, child }, on: [child], policy: "allSettled" };
			}, ctx);
		},
		gate: async (task, runtime, ctx) => {
			const { index, child } = task.state.checkpoint;
			const [outcome] = await runtime.outcomes([child], ctx);
			const passed = outcome.status === "completed" && gateFor(task.input.workflow[index]!)(outcome.result);
			await runtime.commit(async (tx) => {
				const ledger = await tx.doc(Ledger, runtime.conversationId);
				ledger.steps[index]!.status = passed ? "passed" : "failed";
				ledger.steps[index]!.endedAt = runtime.now();
				return passed
					? { status: "running", checkpoint: { phase: "next", index: index + 1 } }
					: { status: "terminal", outcome: { status: "failed", error: { message: `${task.input.workflow[index]!.name} failed` } } };
			}, ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

`stepTask(kind)` returns the registered task for the Step kind; with one child, `allSettled` and `failFast` behave the same. The Gate is plain code in `gate`; a retry or re-run Step is just another entry in the Workflow input or a `next` that points back. Aborting the ticket (`harness.abortTask` or `conversation.abort`) cascades to the running Step and to the conversation it owns, bottom-up, before the ticket's own `abort` handler commits.

**An agent Step as an owned subagent conversation.**

```ts
type AgentStepState = { phase: "start" } | { phase: "await"; conversation: ConversationId };

const AgentStep = defineTask<StepInput, AgentStepState, StepResult>({
	name: "orch.step.agent",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				// Starts as a copy of the ticket conversation's agent; set everything the step needs explicitly.
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
				await configure(tx, created.id, {
					model: task.input.step.config.model as ModelRef,
					thinkingLevel: "high",
					extensions: [CodingTools, StepTools],
					instructions: task.input.step.config.instructions as string,
					cwd: task.input.worktree,
				});
				return { status: "running", checkpoint: { phase: "await", conversation: created.id } };
			}, ctx);
		},
		await: async (task, runtime, ctx) => {
			const { conversation } = task.state.checkpoint;
			const handle = (await runtime.conversation(conversation, ctx))!;
			// Same requestId on every rerun: a crash mid-wait finds the same submission.
			const submission = await handle.submit({ type: "input", content: task.input.prompt, requestId: `step:${task.id}` }, ctx);
			const settled = await submission.wait(ctx);
			const result = await runtime.snapshot(StepOutput, conversation, ctx); // written by a submit_result tool in StepTools
			const answer = settled.status === "done" ? await runtime.entry(AssistantEntry, settled.answer, ctx) : undefined;
			const model = (answer?.model?.[0] as AssistantMessage | undefined);
			await runtime.commit(() =>
				settled.status === "done" && result !== undefined
					? { status: "terminal", outcome: { status: "completed", result: { ...result, ranOn: `${model?.provider}/${model?.responseModel ?? model?.model}` } } }
					: { status: "terminal", outcome: { status: "failed", error: { message: settled.status === "unanswered" ? settled.reason : "no result" } } },
			ctx);
		},
	},
	abort: async (task, runtime, ctx) => {
		if (task.state.checkpoint.phase === "await") await (await runtime.conversation(task.state.checkpoint.conversation, ctx))?.abort(ctx);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});
```

`StepTools` carries a `submit_result` tool with a TypeBox schema that writes `StepOutput` in `api.commit` and returns `control: { terminate: true }` (the EX-27 pattern), so the Step's typed result never depends on parsing prose. The `await` phase holds an in-memory wait, as EX-23's `Reporter` does; after a crash it reruns, reattaches by `requestId`, and the subagent's own tasks resume on their own. A per-Step deadline in 1.3.0 is `Promise.race([submission.wait(ctx), runtime.sleep(deadline, ctx)])` followed by `handle.abort(ctx)`; record the deadline in the checkpoint, as EX-24 does, and expect the seam to swap this for `sleepUntil` when the next release lands. Steering a running Step (for example, "tests are green now, finish up") is `handle.submit({ ..., whenBusy: "steer" })`.

**A shell Step as a shell command.**

```ts
const ShellStep = defineTask<StepInput, { phase: "run" }, { exitCode: number; tail: string }>({
	name: "orch.step.shell",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			// Guard the effect: a rerun after a crash sees the memo and can check external state instead of repeating.
			await runtime.memo("started", runtime.now(), ctx);
			const env = (await runtime.env(ctx)) ?? new NodeExecutionEnv({ cwd: task.input.worktree }); // ticket conversation cwd, or explicit
			const tail = new OutputBuffer({ maxBytes: 50 * 1024, maxLines: 2000, retain: "tail" }); // @earendil-works/chord/output
			const result = await env.exec(task.input.step.config.argv as string[], {
				cwd: task.input.worktree,
				timeout: task.input.step.config.timeoutMs as number | undefined,
				onOutput: (text) => tail.push(text),
			}, ctx);
			await runtime.commit(() =>
				result.ok
					? { status: "terminal", outcome: { status: "completed", result: { exitCode: result.value.exitCode, tail: tail.text } } }
					: { status: "terminal", outcome: { status: "failed", error: { message: result.error.message, detail: { code: result.error.code } } } },
			ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

The exact `OutputBuffer` constructor was not read; the README names it and `OutputLimits` in `@earendil-works/chord/output`. The argv form avoids a shell; a string form runs through the environment's shell. Commands that are not idempotent (push, MR creation, merge) belong behind an intent phase: commit `{ phase: "pushed", key }` first, then check the remote on rerun. A Gate that only needs an exit code (every test green, CI green on the exact commit) is this task plus a check in the ticket's `gate` phase.

**How crashes mid-Step surface.** After `orch run` reopens: the Step task is `pending` with `startedAt` set (`inspect()` says `ready`), the ticket is `waiting` on it, the Step's conversation may show `pi.live.run` and a partial `generation`, and interrupted `bash` calls appear as `pi.tool-result` entries with the `interrupted` diagnostic. The CLI can print "resuming step N (interrupted at <startedAt>)" from `inspect()` plus the ledger; there is no restart counter in 1.3.0, so a crash loop is the engine's to notice (count resumptions of the same `child` in the ledger) until `settings.restartLimit` ships. A `faulted` Step (phase threw, or returned without committing) ends the ticket through the `gate` phase like any failure; the error message is in `outcome.error`.

**Typed per-ticket state in a document.**

```ts
const Ledger = defineDoc<{
	ticket: number;
	steps: { name: string; kind: string; task: TaskId; status: "running" | "passed" | "failed"; startedAt: number; endedAt?: number; findings: string[] }[];
	budget: { usdLimit: number; usdSpent: number };
}>({ kind: "orch.ledger", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ ticket: 0, steps: [], budget: { usdLimit: 0, usdSpent: 0 } }) });
```

It lives on the ticket conversation, is seeded in `init` at creation, and is only written inside the ticket task's `runtime.commit` callbacks, so every ledger change is atomic with the state change it describes. Budget spend is summed in `gate` from each Step conversation's `pi.usage` (`UsageState.models["provider/modelId"].cost.total`, or `harness.usage()` for the whole file). `harness.watchDoc(Ledger, conversationId, ctx)` drives `tail`; `history: "rewindable"` would allow `snapshotAsOf` per entry but the ticket conversation has no transcript worth rewinding. Bump `version` and add `migrate` when the shape changes; use `checkpointWhen` if `steps` grows long.

**Testing with `MemoryStorage` and a fake clock.** Engine tests open `Harness.open(new MemoryStorage(), { models, registry, env, now: () => clock, onReport: (e) => reports.push(e) }, BACKGROUND_CONTEXT)` with `fauxProvider()` scripted responses for agent Steps (`faux.setResponses([...])`, function steps for routing) and a fake or temp-dir `NodeExecutionEnv` for shell Steps; `harness.resume()` then `await harness.waitForTask(ticketId, ctx)` and assert the outcome, `harness.snapshot(Ledger, ...)` and `taskGraph` shape. Crash tests copy the repo's `ControlledStorage` idea (subclass `MemoryStorage` with `reopen()`), abandon the first Harness without closing, open a second over the same storage, and assert the Step resumes with the same `requestId`; a temp SQLite file with `close()` and reopen covers the close path. Keep engine time on `runtime.now()` and `HarnessOptions.now`, never `Date.now()`, and keep fake-clock sleeps short (the 1.3.0 `sleep` re-checks the clock only when its real timer fires). The conformance suite is not needed unless v2 writes its own storage.

## Risks and unknowns

- **API churn.** Experimental by its own banner; breaking changes in patch and minor releases; the next release already removes `runtime.sleep`, adds a `sleeping` status that every exhaustive state switch must handle, and migrates SQLite to a schema 1.3.0 cannot reopen. Pin `1.3.0` exactly (the package already pins `pi-ai`, `chord` and `pi-codemode` exactly, so upgrading one means upgrading all four), and keep sleep/deadline, open/close, task helpers, env/exec and watch adapters behind the seam ADR 0001 asks for.
- **No multi-process story.** No lock, no daemon, no attach protocol; `Harness.open` writes. The second-process hazard is inferred from the open-time commit plus "no cross-process locking"; the sources never spell it out. v2 needs a small owner guard of its own.
- **In-memory waits inside phases.** `submission.wait()` and `runtime.sleep()` hold an invocation; a crash restarts them. That is fine for idempotent waits with `requestId`, but every Step phase must be written to rerun.
- **Crash loops are unbounded in 1.3.0.** A Step whose phase crashes the process reruns forever until `settings.restartLimit` ships; the engine should count resumptions in its ledger meanwhile.
- **Child processes after a hard crash.** `NodeExecutionEnv.cleanup()` kills commands on orderly shutdown; the sources say nothing about SIGKILL of the owner.
- **No `executeTool` from tasks.** Shell Gates in task phases use `env.exec` and must bound output themselves; the `bash` tool's limits and spill are available only to tool calls.
- **Documents are JSON, typed at compile time only.** No runtime schema validation appears in the sources; `version` and `migrate` are the only shape controls.
- **Agent events are doubly experimental.** `tail` built on `watchEvents()` may need rework; `watch()` on the structural view is the more stable base.
- **Inferred, not stated:** that `inspect()` showing a `ready` task with `startedAt` set means a crash; that a one-child `allSettled` wait is equivalent to `failFast`; the `OutputBuffer` constructor shape; `processLock` semantics.
- **Not read:** most of the 295 KB spec (only §4, §5.1, §5.2, §5.4 fragments, §13 were read); `read`/`write`/`edit` replay policies; the pi coding agent's own hosting of Pi Durable; the repo's CI workflows; MemoryStorage internals beyond its declaration. Nothing here was executed.
