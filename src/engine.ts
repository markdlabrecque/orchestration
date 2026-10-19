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
import { checked, type Exec, exec } from "./command.ts";
import {
  ContractError,
  FilingError,
  type Finding,
  Findings,
  openFindings,
  recordResult,
} from "./findings.ts";
import { testGate } from "./gates.ts";
import { type Ask, askHuman } from "./human.ts";
import { preflight } from "./preflight.ts";
import { createRegistrations, type Registrations } from "./registration.ts";
import { worktreeTree } from "./repair-diff.ts";
import { piModel } from "./runners/model.ts";
import { createPiRunner, PiResults, piResultExtension } from "./runners/pi.ts";
import { createShellRunner } from "./runners/shell.ts";
import {
  type AgentResult,
  type Runner,
  type RunnerEvent,
  type RunnerResult,
  roleResultSchema,
  validateResult,
} from "./runners/types.ts";
import type { Identity, Ticket, Tracker } from "./tracker/types.ts";
import { matchesWhen, type Workflow } from "./workflow.ts";

export type Project = {
  root: string;
  repo: string;
  host?: string;
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
type Repair = {
  name: string;
  budget: string;
  phase: "ready" | "body" | "recheck";
  cursor: number;
  attempt: number;
  outcome: string;
  publishedTree: string;
  baseline: string;
  diff: string;
};
export type RunState = {
  findings?: Finding[];
  control: "park" | "abort" | null;
  cached: Pick<
    RunnerResult,
    "status" | "result" | "handoff" | "session"
  > | null;
  budgets: Record<string, { spent: number; grants: number }>;
  repair: Repair | null;
  status:
    | "running"
    | "paused"
    | "blocked"
    | "merged"
    | "completed"
    | "parked"
    | "aborted";
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
    control: null,
    cached: null,
    budgets: {},
    repair: null,
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
        const ledger = (await runtime.snapshot(Findings, context)) ?? {
          items: [],
        };
        observed = { ...state, findings: ledger.items };
        const workflow = state.workflow;
        const stages = [
          "ticket",
          "assign",
          "pickup",
          ...workflow.steps.map((s) => s.id),
          ...(workflow.steps.some((s) => s.kind === "merge") ? ["retire"] : []),
        ];
        const detector = workflow.steps[state.index - 3];
        const repairBody = state.repair
          ? [workflow.repairs[state.repair.name]].flat()
          : [];
        const step =
          state.repair?.phase === "body"
            ? repairBody[state.repair.cursor]
            : detector;
        const name = step?.id ?? stages[state.index];
        const checkpoint = (current: typeof task) => ({
          status: "running" as const,
          checkpoint: {
            phase: "execute" as const,
            revision: current.state.checkpoint.revision + 1,
          },
        });
        notify({ step: name, status: "running" });
        const advance = async (
          change: Partial<RunState> = {},
          outcome?: string,
        ) => {
          const gated = step;
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
          let diff = state.repair?.diff ?? "";
          let publishedTree = state.repair?.publishedTree ?? "";
          if (
            state.repair?.phase === "body" &&
            (state.repair.cursor === repairBody.length - 1 ||
              step.kind === "mr")
          ) {
            const after = await worktreeTree(
              project.worktree,
              options.execute ?? exec,
              runtime.signal,
            );
            if (step.kind === "mr" && outcome !== "skipped")
              publishedTree = after;
            if (
              state.repair.cursor === repairBody.length - 1 &&
              detector.kind === "ci" &&
              (!publishedTree || publishedTree !== after)
            )
              throw new ContractError(
                "CI repair must publish its final worktree before rechecking CI",
              );
            diff = await checked(options.execute ?? exec, {
              cwd: project.worktree,
              argv: ["git", "diff", state.repair.baseline, after],
              signal: runtime.signal,
            });
          }
          return runtime.commit(async (tx, current) => {
            const doc = await tx.doc(Run);
            Object.assign(doc, change);
            doc.cached = null;
            if (doc.repair?.phase === "body") {
              doc.repair.publishedTree = publishedTree;
              doc.repair.cursor++;
              if (doc.repair.cursor === repairBody.length) {
                doc.repair.phase = "recheck";
                doc.repair.diff = diff;
              }
            } else {
              doc.index++;
              doc.repair = null;
            }
            const kind = step?.kind;
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
          for (const finding of ledger.items.filter(
            (f) => f.filing === "pending",
          )) {
            try {
              const link = await tracker.followUp(
                finding.summary,
                `${finding.evidence}\n\nSource: ${state.ticket?.url}\nFinding: ${finding.id}\n${finding.deferralReason ?? ""}`,
                finding.marker ?? "",
              );
              if (!link.id || !link.url)
                throw new Error("Follow-up returned no identity");
              await runtime.commit(async (tx) => {
                const item = (await tx.doc(Findings)).items.find(
                  (f) => f.id === finding.id,
                );
                if (!item) throw new Error("Missing finding");
                item.filing = "linked";
                item.link = link;
                if (item.deferralReason) item.status = "deferred";
                return undefined;
              }, context);
              Object.assign(finding, {
                filing: "linked",
                link,
                ...(finding.deferralReason ? { status: "deferred" } : {}),
              });
            } catch (error) {
              throw new FilingError(String(error));
            }
          }
          if (state.control === "park") {
            try {
              const head = await project.publish(
                `#${project.ticket}: ${state.ticket?.title}`,
              );
              const pr = await tracker.pullRequest(
                `#${project.ticket}: ${state.ticket?.title}`,
                `Parked orchestration run.\n\nOpen findings:\n${openFindings(
                  ledger.items,
                )
                  .map((f) => `- ${f.id}: ${f.summary}\n  ${f.evidence}`)
                  .join("\n")}`,
                project.ticket,
                project.base,
                `<!-- orch:${state.runId}:pr -->`,
                { draft: true },
              );
              await runtime.commit(async (tx) => {
                Object.assign(await tx.doc(Run), {
                  status: "parked",
                  pr,
                  head,
                  ciHead: "",
                });
                return {
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                };
              }, context);
            } catch (error) {
              throw new FilingError(String(error));
            }
            return;
          }
          if (state.control === "abort") {
            try {
              await tracker.abort(
                project.ticket,
                `<!-- orch:${state.runId}:abort -->`,
              );
            } catch (error) {
              throw new FilingError(String(error));
            }
            await runtime.commit(async (tx) => {
              (await tx.doc(Run)).status = "aborted";
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }, context);
            return;
          }
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

          if (!state.ticket) throw new Error("Missing ticket");
          if (state.repair?.phase === "ready") {
            const repair = state.repair;
            if (
              repair.outcome === "findings" &&
              ledger.items.some(
                (f) => f.detector === detector.id && f.status === "deferred",
              ) &&
              !openFindings(ledger.items, detector.id).length
            ) {
              await runtime.commit(async (tx, current) => {
                const doc = await tx.doc(Run);
                if (doc.repair) {
                  doc.repair.phase = "recheck";
                  doc.repair.attempt++;
                }
                return checkpoint(current);
              }, context);
              return;
            }
            const budget = state.budgets[repair.budget] ?? {
              spent: 0,
              grants: 0,
            };
            if (
              budget.spent >=
              workflow.budgets[repair.budget].max + budget.grants
            ) {
              const answer = await (options.ask ?? askHuman)(
                `Repair budget ${repair.budget} exhausted. Open findings: ${JSON.stringify(openFindings(ledger.items))}`,
                ["grant", "defer", "park", "abort"],
                runtime.signal,
              );
              if (runtime.signal.aborted) return;
              if (answer === "defer") {
                const ids = (
                  await (options.ask ?? askHuman)(
                    "Finding IDs to defer, separated by commas",
                    [],
                    runtime.signal,
                  )
                )
                  .split(",")
                  .map((id) => id.trim());
                const reason = (
                  await (options.ask ?? askHuman)(
                    "Reason for deferral",
                    [],
                    runtime.signal,
                  )
                ).trim();
                if (runtime.signal.aborted) return;
                const open = openFindings(ledger.items);
                if (
                  !reason ||
                  !ids.length ||
                  new Set(ids).size !== ids.length ||
                  ids.some((id) => !open.some((f) => f.id === id))
                )
                  throw new ContractError(
                    "Deferral requires open finding IDs and a nonempty reason",
                  );
                await runtime.commit(async (tx, current) => {
                  for (const finding of (await tx.doc(Findings)).items.filter(
                    (f) => ids.includes(f.id),
                  )) {
                    finding.deferralReason = reason;
                    finding.filing = "pending";
                    finding.marker = `<!-- orch:${state.runId}:finding:${finding.id} -->`;
                  }
                  return checkpoint(current);
                }, context);
                return;
              }
              if (answer === "abort" || answer === "park") {
                await runtime.commit(async (tx, current) => {
                  (await tx.doc(Run)).control = answer;
                  return checkpoint(current);
                }, context);
                return;
              }
              if (answer !== "grant")
                throw new ContractError(`Invalid cap choice: ${answer}`);
              await runtime.commit(async (tx, current) => {
                (await tx.doc(Run)).budgets[repair.budget] = {
                  ...budget,
                  grants: budget.grants + 1,
                };
                return checkpoint(current);
              }, context);
              notify({ budget: repair.budget, grant: budget.grants + 1 });
              return;
            }
            const baseline =
              repair.baseline ||
              (await worktreeTree(
                project.worktree,
                options.execute ?? exec,
                runtime.signal,
              ));
            await runtime.commit(async (tx, current) => {
              const doc = await tx.doc(Run);
              doc.budgets[repair.budget] = {
                ...budget,
                spent: budget.spent + 1,
              };
              doc.repair = {
                ...repair,
                phase: "body",
                publishedTree: "",
                baseline,
                cursor: 0,
                attempt: repair.attempt + 1,
              };
              return checkpoint(current);
            }, context);
            return;
          }
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
              return createPiRunner(
                harness,
                task.id,
                `${step.id}:${state.index}:${state.repair?.attempt ?? 0}`,
                (tier) => piModel(workflow.runners.pi, tier),
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
              failureOutcome = result.outcome;
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
            const mode =
              state.repair?.phase === "body"
                ? "repair"
                : state.repair?.phase === "recheck" &&
                    ["reviewer", "verifier"].includes(role)
                  ? "recheck"
                  : "normal";
            const schema = roleResultSchema(role, mode);
            const runner = getRunner(step.runner ?? "");
            const session =
              step.session && mode !== "repair"
                ? state.sessions?.[step.session]
                : undefined;
            if (
              step.session &&
              mode !== "repair" &&
              (!session || !runner.resumable)
            )
              throw new Error(`${step.id}: missing session ${step.session}`);
            const result =
              state.cached ??
              (await runner.run({
                ...(session ? { session } : {}),
                prompt: `Execution mode: ${mode}. ${mode === "recheck" ? "Confirm only the supplied IDs and repair diff. New discoveries are follow-ups." : mode === "repair" ? "Respond to every supplied ID with changed or disagreed and a reason." : ""}\nOpen findings:\n${JSON.stringify(openFindings(ledger.items, mode === "normal" ? step.id : detector.id))}\nRepair diff:\n${state.repair?.diff ?? ""}\nRepair responses:\n${JSON.stringify(ledger.items.filter((f) => f.detector === detector.id).map((f) => ({ id: f.id, responses: f.responses })))}\n\n${state.ticket.title}\n${state.ticket.body}\n\nResolved options:\n${JSON.stringify(step.options ?? {})}\nLane: ${state.lane}\nPrevious results:\n${JSON.stringify(state.results)}\nPrevious handoffs:\n${JSON.stringify(state.handoffs)}`,
                role: `${await options.role(role)}\n\nThe engine owns order, state and tracker writes. Return this JSON schema through submit_result on Pi or ORCH_RESULT_FILE on shell:\n${JSON.stringify(schema)}`,
                cwd: project.worktree,
                model: {
                  tier:
                    role === "implementor" && mode !== "repair"
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
              }));
            if (runtime.signal.aborted) return;
            if (result.status === "done") {
              try {
                validateResult(schema, result.result);
              } catch (error) {
                throw new ContractError(String(error));
              }
            }
            failureOutcome =
              result.result?.outcome === "findings" ? "findings" : "failed";
            if (!state.cached) {
              options.onEvent?.({
                type: "status",
                data: { step: step.id, runnerResult: result },
              });
              await runtime.commit(async (tx, current) => {
                const doc = await tx.doc(Run);
                if (result.status === "done" && result.result)
                  recordResult(
                    (await tx.doc(Findings)).items,
                    result.result,
                    detector.id,
                    mode,
                    state.runId,
                    step.id,
                  );
                doc.cached = {
                  status: result.status,
                  handoff: result.handoff,
                  ...(result.result ? { result: result.result } : {}),
                  ...(result.session ? { session: result.session } : {}),
                };
                if (result.result)
                  doc.results = { ...doc.results, [step.id]: result.result };
                doc.handoffs[step.id] = result.handoff;
                if (result.session)
                  doc.sessions = { ...doc.sessions, [step.id]: result.session };
                return checkpoint(current);
              }, context);
              return;
            }
            if (
              ["reviewer", "verifier"].includes(role) &&
              mode !== "repair" &&
              openFindings(ledger.items, step.id).length
            ) {
              failureOutcome = "findings";
              throw new Error(`${step.id}: open must-fix findings`);
            }
            if (
              mode !== "recheck" &&
              result.result?.outcome === "pass" &&
              result.result.findings?.some(
                (f) => f.classification === "must-fix",
              )
            )
              throw new Error(`${step.id}: must-fix findings cannot pass`);
            if (
              result.status !== "done" ||
              (result.result?.outcome !== "pass" &&
                !(
                  result.result?.outcome === "findings" &&
                  ["reviewer", "verifier"].includes(role) &&
                  mode !== "repair"
                ))
            )
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
              ...(role === "spec-writer" && mode !== "repair"
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
            await tracker
              .comment(
                project.ticket,
                Object.values(state.handoffs).join("\n\n"),
                `<!-- orch:${state.runId}:handoff -->`,
              )
              .catch((error) => {
                throw new FilingError(String(error));
              });
            const head = await project.publish(
              `#${project.ticket}: ${state.ticket.title}`,
            );
            const pr = await tracker
              .pullRequest(
                `#${project.ticket}: ${state.ticket.title}`,
                `Closes #${project.ticket}\n\n${Object.values(state.handoffs).join("\n\n")}`,
                project.ticket,
                project.base,
                `<!-- orch:${state.runId}:pr -->`,
              )
              .catch((error) => {
                throw new FilingError(String(error));
              });
            await advance({ head, pr, ciHead: "", deadline: 0 });
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
            throw new Error("Required CI timed out");
          }
          if (openFindings(ledger.items).length)
            throw new ContractError("Open must-fix findings block merge");
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
          const edge =
            error instanceof ContractError || error instanceof FilingError
              ? undefined
              : state.repair?.phase === "ready"
                ? undefined
                : state.repair?.phase === "body"
                  ? { repair: state.repair.name, budget: state.repair.budget }
                  : step?.on?.[failureOutcome];
          if (edge) {
            await runtime.commit(async (tx, current) => {
              const doc = await tx.doc(Run);
              doc.cached = null;
              doc.repair = {
                name: edge.repair,
                budget: edge.budget,
                phase: "ready",
                publishedTree: "",
                outcome:
                  state.repair?.phase === "body"
                    ? state.repair.outcome
                    : failureOutcome,
                cursor: 0,
                attempt: doc.repair?.attempt ?? 0,
                baseline:
                  state.repair?.phase === "body" ? state.repair.baseline : "",
                diff: state.repair?.diff ?? "",
              };
              doc.outcomes[name] = failureOutcome;
              return checkpoint(current);
            }, context);
            return;
          }
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(Run);
            doc.status = error instanceof FilingError ? "paused" : "blocked";
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
    for (const mode of ["normal", "repair", "recheck"] as const) {
      const schema = roleResultSchema(role, mode);
      // Normal/recheck share schemas for non-detecting roles.
      if (mode === "recheck" && !["reviewer", "verifier"].includes(role))
        continue;
      if (mode === "repair" && role !== "implementor") continue;
      registry.install(piResultExtension(schema));
    }
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
      if (["merged", "completed", "parked", "aborted"].includes(doc.status))
        return null;
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
    return {
      ...state,
      findings: (await harness.snapshot(Findings, ctx))?.items ?? [],
    };
  } finally {
    options.signal?.removeEventListener("abort", pause);
    await harness.close(ctx);
  }
}
