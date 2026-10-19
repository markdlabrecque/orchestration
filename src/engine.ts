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
import { createPiRunner, PiResults } from "./runners/pi.ts";
import { createShellRunner } from "./runners/shell.ts";
import {
  type Runner,
  type RunnerEvent,
  resultSchema,
} from "./runners/types.ts";
import type { Identity, Ticket, Tracker } from "./tracker/types.ts";
import type { Workflow } from "./workflow.ts";

export type Project = {
  root: string;
  repo: string;
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
  status: "running" | "paused" | "blocked" | "merged";
  reason: string;
  index: number;
  handoffs: Record<string, string>;
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
  onEvent?: (event: RunnerEvent) => void;
  runner?: (name: "pi" | "shell") => Runner;
  clock?: {
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  };
};

// Pi Durable documents and tasks are the only authoritative run state.
export async function runWorkflow(options: RunOptions): Promise<RunState> {
  const { tracker, project } = options;
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
          "retire",
        ];
        const name = stages[state.index];
        notify({ step: name, status: "running" });
        const advance = async (change: Partial<RunState> = {}) =>
          runtime.commit(async (tx, current) => {
            const doc = await tx.doc(Run);
            Object.assign(doc, change);
            doc.index++;
            const kind = workflow.steps[state.index - 3]?.kind;
            doc.outcomes[name] =
              kind === "merge" ? "merged" : kind === "ci" ? "passed" : "pass";
            if (doc.index === stages.length) {
              doc.status = "merged";
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
        try {
          if (name === "ticket") {
            await advance({ ticket: await tracker.readTicket(project.ticket) });
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
            await project.retire();
            await advance();
            return;
          }
          const step = workflow.steps[state.index - 3];
          if (!state.ticket) throw new Error("Missing ticket");
          if (step.kind === "agent") {
            const runner =
              options.runner?.(step.runner) ??
              (step.runner === "pi"
                ? createPiRunner(harness, task.id, step.id, workflow.runners.pi)
                : createShellRunner(workflow.runners.shell.command));
            const result = await runner.run({
              prompt: `${state.ticket.title}\n${state.ticket.body}\n\nPrevious handoffs:\n${JSON.stringify(state.handoffs)}`,
              role: await options.role(step.role),
              cwd: project.worktree,
              model: { tier: "standard", effort: "medium" },
              tools:
                step.runner === "pi" ? ["read"] : ["read", "edit", "shell"],
              timeoutMs: 60 * 60 * 1000,
              resultSchema,
              signal: runtime.signal,
              onEvent: (event) => options.onEvent?.(event),
            });
            if (runtime.signal.aborted) return;
            if (result.status !== "done" || result.result?.outcome !== "pass")
              throw new Error(
                `${step.id}: agent ${result.status}: ${result.result?.summary ?? "missing passing result"}`,
              );
            options.onEvent?.({ type: "text", data: result.handoff });
            await advance({
              handoffs: { ...state.handoffs, [step.id]: result.handoff },
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
      if (doc.status === "merged") return null;
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
