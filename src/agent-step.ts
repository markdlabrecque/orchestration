import { ContractError, type Finding, openFindings } from "./findings.ts";
import {
  type AgentResult,
  type RunnerRequest,
  type RunnerResult,
  roleResultSchema,
  validateResult,
} from "./runners/types.ts";
import type { Ticket } from "./tracker/types.ts";
import type { Step } from "./workflow.ts";

type AgentContext = {
  resumable: boolean;
  ticket: Ticket;
  lane: string;
  implementationTier: string;
  handoffs: Record<string, string>;
  results: Record<string, AgentResult>;
  sessions: Record<string, string>;
  repair: { phase: "ready" | "body" | "recheck"; diff: string } | null;
  detector: string;
  findings: Finding[];
};
type AgentCompletion = Pick<
  RunnerResult,
  "status" | "result" | "handoff" | "session"
>;

// Role policy and result interpretation live here; execution owns persistence.
export function agentStep(step: Step, context: AgentContext) {
  const role = step.role ?? String(step.options?.role);
  const mode: "normal" | "repair" | "recheck" =
    context.repair?.phase === "body"
      ? "repair"
      : context.repair?.phase === "recheck" &&
          ["reviewer", "verifier"].includes(role)
        ? "recheck"
        : "normal";
  const schema = roleResultSchema(role, mode);

  const detecting =
    ["reviewer", "verifier"].includes(role) && mode !== "repair";
  const session =
    step.session && mode !== "repair"
      ? context.sessions[step.session]
      : undefined;
  if (step.session && mode !== "repair" && (!session || !context.resumable))
    throw new Error(`${step.id}: missing session ${step.session}`);
  return {
    mode,
    async request(
      host: Pick<RunnerRequest, "cwd" | "signal" | "onEvent"> & {
        role(name: string): Promise<string>;
      },
    ): Promise<RunnerRequest> {
      return {
        ...(session ? { session } : {}),
        prompt: `Execution mode: ${mode}. ${mode === "recheck" ? "Confirm only the supplied IDs and repair diff. New discoveries are follow-ups." : mode === "repair" ? "Respond to every supplied ID with changed or disagreed and a reason." : ""}\nOpen findings:\n${JSON.stringify(openFindings(context.findings, mode === "normal" ? step.id : context.detector))}\nRepair diff:\n${context.repair?.diff ?? ""}\nRepair responses:\n${JSON.stringify(context.findings.filter((f) => f.detector === context.detector).map((f) => ({ id: f.id, responses: f.responses })))}\n\n${context.ticket.title}\n${context.ticket.body}\n\nResolved options:\n${JSON.stringify(step.options ?? {})}\nLane: ${context.lane}\nPrevious results:\n${JSON.stringify(context.results)}\nPrevious handoffs:\n${JSON.stringify(context.handoffs)}`,
        role: `${await host.role(role)}\n\nThe engine owns order, state and tracker writes. Return this JSON schema through submit_result on Pi or ORCH_RESULT_FILE on shell:\n${JSON.stringify(schema)}`,
        cwd: host.cwd,
        model: {
          tier:
            role === "implementor" && mode !== "repair"
              ? context.implementationTier
              : (step.model?.tier ?? "standard"),
          effort: step.model?.effort ?? "medium",
        },
        tools:
          step.tools ??
          (step.runner === "shell" ? ["read", "edit", "shell"] : ["read"]),
        timeoutMs: step.timeoutMs ?? 60 * 60 * 1000,
        resultSchema: schema,
        signal: host.signal,
        onEvent: host.onEvent,
      };
    },
    validate(result: AgentCompletion) {
      if (result.status === "done") {
        try {
          validateResult(schema, result.result);
        } catch (error) {
          throw new ContractError(String(error));
        }
      }
      return result.result?.outcome === "findings" ? "findings" : "failed";
    },
    interpret(result: AgentCompletion) {
      const outcome =
        result.result?.outcome === "findings" ? "findings" : "failed";
      if (detecting && openFindings(context.findings, step.id).length)
        return {
          outcome: "findings",
          reason: `${step.id}: open must-fix findings`,
        };
      if (
        mode !== "recheck" &&
        result.result?.outcome === "pass" &&
        result.result.findings?.some((f) => f.classification === "must-fix")
      )
        return { outcome, reason: `${step.id}: must-fix findings cannot pass` };
      if (
        result.status !== "done" ||
        (result.result?.outcome !== "pass" &&
          !(result.result?.outcome === "findings" && detecting))
      )
        return {
          outcome,
          reason: `${step.id}: agent ${result.status}: ${result.result?.summary ?? "missing passing result"}`,
        };
      return {
        outcome: "pass",
        selection:
          role === "spec-writer" && mode !== "repair"
            ? {
                lane: context.ticket.labels?.some((l) => l.startsWith("lane:"))
                  ? context.lane
                  : result.result.lane,
                implementationTier: result.result.implementationTier,
              }
            : {},
      };
    },
  };
}
