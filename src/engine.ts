import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  Harness,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type Exec, exec } from "./command.ts";
import { testGate } from "./gates.ts";
import { type Ask, askHuman } from "./human.ts";
import { preflight } from "./preflight.ts";
import { createRegistrations, type Registrations } from "./registration.ts";
import { piModel } from "./runners/model.ts";
import { createPiRunner, PiResults, piResultExtension } from "./runners/pi.ts";
import { createShellRunner } from "./runners/shell.ts";
import {
  type AgentResult,
  type Runner,
  type RunnerEvent,
  roleResultSchema,
  validateResult,
} from "./runners/types.ts";
import type { Identity, Ticket, Tracker } from "./tracker/types.ts";
import { matchesWhen, type Workflow } from "./workflow.ts";

export type Project = {
  root: string;
  repo: string;
  forge?: "github" | "gitlab";
  main: string;
  base: string;
  worktree: string;
  runs: string;
  ticket: string;
  pickup(): Promise<void>;
  publish(title: string): Promise<string>;
  retire(): Promise<void>;
};
export type RunState = {
  status: "running" | "paused" | "blocked" | "merged" | "completed";
  reason: string;
  index: number;
  handoffs: Record<string, string>;
  lane: string;
  implementationTier: string;
  results: Record<string, AgentResult>;
  sessions: Record<string, string>;
  outcomes: Record<string, string>;
  workflow: Workflow | null;
  ticket: Ticket | null;
  pr: Identity | null;
  head: string;
  ciHead: string;
  deadline: number;
  runId: string;
  task: TaskId | null;
};
const Run = defineDoc<RunState>({
  kind: "orch.run",
  version: 1,
  scope: "session",
  initial: () => ({
    status: "running",
    reason: "",
    index: 0,
    handoffs: {},
    lane: "standard",
    implementationTier: "standard",
    results: {},
    sessions: {},
    outcomes: {},
    workflow: null,
    ticket: null,
    pr: null,
    head: "",
    ciHead: "",
    deadline: 0,
    runId: "",
    task: null,
  }),
});
export type RunOptions = {
  workflow: Workflow;
  storage: Storage;
  models: Models;
  tracker: Tracker;
  project: Project;
  role: (name: string) => Promise<string>;
  signal?: AbortSignal;
  ask?: Ask;
  onEvent?: (event: RunnerEvent) => void;
  runner?: (name: string) => Runner;
  execute?: Exec;
  registrations?: Registrations;
  clock?: {
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  };
};

// Pi Durable documents and tasks are the only authoritative run state.
export async function runWorkflow(options: RunOptions): Promise<RunState> {
  const { tracker, project } = options;
  const registrations = options.registrations ?? createRegistrations();
  await preflight(options);
  let checkedWorkflow = JSON.stringify(options.workflow);
  let harness: Harness;
  let observed: RunState | undefined;
  const notify = (data: unknown) => options.onEvent?.({ type: "status", data });
  const Task = defineTask<
    Record<string, never>,
    { phase: "execute"; revision: number },
    null
  >({
    name: "orch.workflow",
    version: 1,
    initial: () => ({ phase: "execute", revision: 0 }),
    phases: {
      execute: async (task, runtime, context) => {
        const state = await runtime.snapshot(Run, context);
        if (!state?.workflow) throw new Error("Missing durable workflow");
        observed = state;
        const workflow = state.workflow;
        const stages = [
          "ticket",
          "assign",
          "pickup",
          ...workflow.steps.map((s) => s.id),
          ...(workflow.steps.some((s) => s.kind === "merge") ? ["retire"] : []),
        ];
        const name = stages[state.index];
        notify({ step: name, status: "running" });
        const advance = async (
          change: Partial<RunState> = {},
          outcome?: string,
        ) => {
          const gated = workflow.steps[state.index - 3];
          if (outcome !== "skipped" && gated?.gate?.startsWith("tests-"))
            await testGate(
              gated.gate,
              String(workflow.settings.tests),
              project.worktree,
              options.execute ?? exec,
              runtime.signal,
              change.results?.[gated.id],
            );
          if (outcome !== "skipped" && gated?.gate === "ci-green-on-head") {
            const head = change.ciHead ?? state.ciHead;
            if (
              !state.pr ||
              !head ||
              head !== state.head ||
              (await tracker.readPullRequest(state.pr.id)).head !== head
            )
              throw new Error(
                "ci-green-on-head: no CI evidence for current PR head",
              );
          }
          return runtime.commit(async (tx, current) => {
            const doc = await tx.doc(Run);
            Object.assign(doc, change);
            doc.index++;
            const kind = workflow.steps[state.index - 3]?.kind;
            doc.outcomes[name] =
              outcome ??
              (kind === "merge" ? "merged" : kind === "ci" ? "passed" : "pass");
            if (doc.index === stages.length) {
              doc.status = workflow.steps.some(
                (s) => s.kind === "merge" && doc.outcomes[s.id] === "merged",
              )
                ? "merged"
                : "completed";
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }
            return {
              status: "running",
              checkpoint: {
                phase: "execute",
                revision: current.state.checkpoint.revision + 1,
              },
            };
          }, context);
        };
        let failureOutcome = "failed";
        try {
          const savedWorkflow = JSON.stringify(workflow);
          if (savedWorkflow !== checkedWorkflow) {
            await preflight({ ...options, workflow });
            checkedWorkflow = savedWorkflow;
          }
          if (name === "ticket") {
            const ticket = await tracker.readTicket(project.ticket);
            const forced = [
              ...new Set(
                (ticket.labels ?? [])
                  .filter((l) => l.startsWith("lane:"))
                  .map((l) => l.slice(5)),
              ),
            ];
            if (
              forced.length > 1 ||
              forced.some(
                (l) => !["standard", "trivial", "no-code"].includes(l),
              )
            )
              throw new Error("Conflicting or invalid lane labels");
            await advance({
              ticket,
              ...(forced[0] ? { lane: forced[0] } : {}),
            });
            return;
          }
          if (name === "assign") {
            await tracker.assign(project.ticket);
            await advance();
            return;
          }
          if (name === "pickup") {
            await project.pickup();
            await advance();
            return;
          }
          if (name === "retire") {
            if (
              workflow.steps.some(
                (s) => s.kind === "merge" && state.outcomes[s.id] === "merged",
              )
            )
              await project.retire();
            await advance();
            return;
          }
          const step = workflow.steps[state.index - 3];
          if (!state.ticket) throw new Error("Missing ticket");
          if (!matchesWhen(step.when, workflow.settings, state.lane)) {
            await advance({}, "skipped");
            return;
          }
          if (step.kind === "human") {
            const choices = step.options?.choices as string[];
            const answer = await (options.ask ?? askHuman)(
              String(step.options?.ask),
              choices,
              runtime.signal,
            );
            if (runtime.signal.aborted) return;
            if (!choices.includes(answer))
              throw new Error(`${step.id}: invalid human choice`);
            if (answer !== choices[0]) failureOutcome = answer;
            if (answer !== choices[0]) throw new Error(`${step.id}: ${answer}`);
            await advance();
            return;
          }
          if (step.kind === "shell") {
            const result = await (options.execute ?? exec)({
              cwd: project.worktree,
              argv: ["bash", "-c", String(step.options?.command)],
              signal: runtime.signal,
            });
            if (result.code !== 0 || result.status !== "done")
              throw new Error(`${step.id}: shell failed: ${result.stderr}`);
            await advance();
            return;
          }
          const getRunner = (name: string): Runner => {
            const injected = options.runner?.(name);
            if (injected) return injected;
            if (name === "pi")
              return createPiRunner(harness, task.id, step.id, (tier) =>
                piModel(workflow.runners.pi, tier),
              );
            if (name === "shell")
              return createShellRunner(
                String(workflow.runners.shell.command),
                options.execute ?? exec,
                workflow.runners.shell.models as
                  | Record<string, string>
                  | undefined,
              );
            const definition = registrations.runners.get(name);
            if (!definition) throw new Error(`Unknown runner ${name}`);
            return definition.create(workflow.runners[name] ?? {});
          };
          const custom = registrations.kinds.get(step.kind);
          if (custom) {
            const result = await custom.run(step, {
              cwd: project.worktree,
              signal: runtime.signal,
              exec: options.execute ?? exec,
              onEvent: (event) => options.onEvent?.(event),
              runAgent: (name, request) => {
                if (!custom.runners?.includes(name))
                  throw new Error(`${step.id}: undeclared runner ${name}`);
                return getRunner(name).run(request);
              },
            });
            if (!custom.outcomes.includes(result.outcome))
              throw new Error(
                `${step.id}: undeclared outcome ${result.outcome}`,
              );
            if (result.outcome !== custom.outcomes[0])
              throw new Error(`${step.id}: ${result.outcome}`);
            await advance(
              result.handoff === undefined
                ? {}
                : {
                    handoffs: { ...state.handoffs, [step.id]: result.handoff },
                  },
              result.outcome,
            );
            return;
          }
          if (step.kind === "agent") {
            const role = step.role ?? String(step.options?.role);
            const schema = roleResultSchema(role);
            const runner = getRunner(step.runner ?? "");
            const session = step.session
              ? state.sessions?.[step.session]
              : undefined;
            if (step.session && (!session || !runner.resumable))
              throw new Error(`${step.id}: missing session ${step.session}`);
            const result = await runner.run({
              ...(session ? { session } : {}),
              prompt: `${state.ticket.title}\n${state.ticket.body}\n\nResolved options:\n${JSON.stringify(step.options ?? {})}\nLane: ${state.lane}\nPrevious results:\n${JSON.stringify(state.results)}\nPrevious handoffs:\n${JSON.stringify(state.handoffs)}`,
              role: `${await options.role(role)}\n\nThe engine owns order, state and tracker writes. Return this JSON schema through submit_result on Pi or ORCH_RESULT_FILE on shell:\n${JSON.stringify(schema)}`,
              cwd: project.worktree,
              model: {
                tier:
                  role === "implementor"
                    ? state.implementationTier
                    : (step.model?.tier ?? "standard"),
                effort: step.model?.effort ?? "medium",
              },
              tools:
                step.tools ??
                (step.runner === "shell"
                  ? ["read", "edit", "shell"]
                  : ["read"]),
              timeoutMs: step.timeoutMs ?? 60 * 60 * 1000,
              resultSchema: schema,
              signal: runtime.signal,
              onEvent: (event) => options.onEvent?.(event),
            });
            if (runtime.signal.aborted) return;
            if (result.status === "done") validateResult(schema, result.result);
            failureOutcome =
              result.result?.outcome === "findings" ? "findings" : "failed";
            options.onEvent?.({
              type: "status",
              data: { step: step.id, runnerResult: result },
            });
            await runtime.commit(async (tx) => {
              const doc = await tx.doc(Run);
              if (result.result)
                doc.results = { ...doc.results, [step.id]: result.result };
              doc.handoffs[step.id] = result.handoff;
              if (result.session)
                doc.sessions = { ...doc.sessions, [step.id]: result.session };
              return undefined;
            }, context);
            if (
              result.result?.outcome === "pass" &&
              result.result.findings?.some(
                (f) => f.classification === "must-fix",
              )
            )
              throw new Error(`${step.id}: must-fix findings cannot pass`);
            if (result.status !== "done" || result.result?.outcome !== "pass")
              throw new Error(
                `${step.id}: agent ${result.status}: ${result.result?.summary ?? "missing passing result"}`,
              );
            options.onEvent?.({ type: "text", data: result.handoff });
            await advance({
              handoffs: { ...state.handoffs, [step.id]: result.handoff },
              results: { ...state.results, [step.id]: result.result },
              sessions: {
                ...state.sessions,
                ...(result.session ? { [step.id]: result.session } : {}),
              },
              ...(role === "spec-writer"
                ? {
                    lane: state.ticket.labels?.some((l) =>
                      l.startsWith("lane:"),
                    )
                      ? state.lane
                      : result.result.lane,
                    implementationTier: result.result.implementationTier,
                  }
                : {}),
            });
            return;
          }
          if (step.kind === "mr") {
            // runId was committed before any effect. Every retry reconciles this same marker.
            await tracker.comment(
              project.ticket,
              Object.values(state.handoffs).join("\n\n"),
              `<!-- orch:${state.runId}:handoff -->`,
            );
            const head = await project.publish(
              `#${project.ticket}: ${state.ticket.title}`,
            );
            const pr = await tracker.pullRequest(
              `#${project.ticket}: ${state.ticket.title}`,
              `Closes #${project.ticket}\n\n${Object.values(state.handoffs).join("\n\n")}`,
              project.ticket,
              project.base,
              `<!-- orch:${state.runId}:pr -->`,
            );
            await advance({ head, pr, ciHead: "" });
            return;
          }
          if (step.kind !== "ci" && step.kind !== "merge")
            throw new Error(`${step.id}: unknown kind ${step.kind}`);
          if (!state.pr) throw new Error("Missing PR");
          if (step.kind === "ci") {
            const now = () => options.clock?.now() ?? runtime.now();
            const deadline = state.deadline || now() + 90 * 60 * 1000;
            if (!state.deadline)
              await runtime.commit(async (tx) => {
                (await tx.doc(Run)).deadline = deadline;
                return undefined;
              }, context);
            while (now() < deadline) {
              const result = await tracker.ci(state.pr.id, state.head);
              if (result === "passed") {
                await advance({ ciHead: state.head });
                return;
              }
              if (result === "failed") throw new Error("Required CI failed");
              if (options.clock)
                await options.clock.sleep(60_000, runtime.signal);
              else await runtime.sleep(runtime.now() + 60_000, context);
            }
            failureOutcome = "timeout";
            failureOutcome = "timeout";
            throw new Error("Required CI timed out");
          }
          if (!state.ciHead || state.ciHead !== state.head)
            throw new Error("No CI evidence for this head");
          const pr = await tracker.readPullRequest(state.pr.id);
          if (pr.head !== state.ciHead)
            throw new Error("PR head differs from CI-passed SHA");
          if (!pr.merged) await tracker.merge(pr.id, state.ciHead);
          const confirmed = await tracker.readPullRequest(pr.id);
          if (!confirmed.merged || confirmed.head !== state.ciHead)
            throw new Error("Merge not confirmed on CI-passed head");
          await advance();
        } catch (error) {
          if (runtime.signal.aborted) return;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(Run);
            doc.status = "blocked";
            doc.reason = String(error);
            doc.outcomes[name] = failureOutcome;
            return {
              status: "terminal",
              outcome: { status: "failed", error: { message: String(error) } },
            };
          }, context);
        }
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const registry = createRegistry();
  registry.install(PiResults);
  for (const role of [
    "spec-writer",
    "test-writer",
    "implementor",
    "reviewer",
    "verifier",
    "reporter",
  ])
    registry.install(piResultExtension(roleResultSchema(role)));
  registry.install(defineExtension({ name: "orch.engine", tasks: [Task] }));
  harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      now: options.clock?.now,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? project.worktree }),
    },
    ctx,
  );
  let paused = false;
  const pause = () => {
    paused = true;
    void harness.close(ctx);
  };
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(async (tx) => {
      const doc = await tx.doc(Run);
      if (doc.status === "merged" || doc.status === "completed") return null;
      if (!doc.workflow) {
        doc.workflow = options.workflow;
        doc.runId = randomUUID();
      }
      doc.status = "running";
      doc.reason = "";
      if (doc.task) {
        const old = await tx.task(doc.task);
        if (old && old.state.status !== "terminal") return doc.task;
      }
      doc.task = await tx.createTask(
        Task,
        {},
        { ownership: { kind: "conversation" } },
      );
      return doc.task;
    }, ctx);
    observed = await harness.snapshot(Run, ctx);
    if (id) {
      options.signal?.addEventListener("abort", pause, { once: true });
      if (options.signal?.aborted) pause();
      try {
        const settled = await harness.waitForTask(id, ctx);
        if (
          settled.state.outcome.status === "faulted" ||
          settled.state.outcome.status === "orphaned"
        )
          throw new Error(
            `Durable task ${settled.state.outcome.status}: ${JSON.stringify(settled.state.outcome)}`,
          );
      } catch (error) {
        if (!paused) throw error;
      }
    }
    if (paused) {
      if (!observed) throw new Error("Paused before the run started");
      return { ...observed, status: "paused" };
    }
    const state = await harness.snapshot(Run, ctx);
    if (!state) throw new Error("Missing run state");
    return state;
  } finally {
    options.signal?.removeEventListener("abort", pause);
    await harness.close(ctx);
  }
}
