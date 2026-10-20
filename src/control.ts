import { CONTRACT, capabilitiesResponse } from "./capabilities.ts";
import type { Project } from "./engine.ts";
import { openReceipts, type Receipt } from "./receipts.ts";
import { snapshotResponse } from "./snapshot.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Seams over project discovery, run launch and pause so tests never start a real run.
export type ControlDeps = {
  project(ticket: string): Promise<Project>;
  // Starts or resumes the single run owner; resolves once it is live.
  launch(
    project: Project,
    mode: "start" | "resume",
  ): Promise<{ runId: string }>;
  // Asks the live owner to pause.
  pause(project: Project): Promise<void>;
  // Runs the owner in the calling process until it ends (host-bound, no detach).
  foreground?(project: Project): Promise<{
    runId?: string;
    outcome: "completed" | "failed" | "superseded";
  }>;
};

type Snapshot = Record<string, unknown> & { runId?: string; owner?: string };

const RUN_OPS = new Set(["start", "pause", "resume", "snapshot"]);

export async function controlResponse(stdin: string, deps?: ControlDeps) {
  const base = { contract: CONTRACT, receipt: null, snapshot: null };
  const reject = (code: string, message: string) => ({
    ...base,
    outcome: "rejected" as const,
    code,
    message,
  });
  let request: unknown;
  try {
    request = JSON.parse(stdin);
  } catch {
    return reject("invalid-request", "Expected one JSON request object");
  }
  if (!isObject(request))
    return reject("invalid-request", "Expected a request object");
  const match =
    typeof request.contract === "string"
      ? /^orch\.control\/(\d+)$/.exec(request.contract)
      : null;
  if (!match)
    return reject("invalid-request", "Expected contract orch.control/<major>");
  if (Number(match[1]) !== 1)
    return {
      ...reject(
        "unsupported-version",
        `Unsupported contract ${request.contract}`,
      ),
      supportedMajors: [1],
    };
  if (typeof request.requestId !== "string" || !request.requestId.trim())
    return reject("invalid-request", "Expected a non-empty requestId string");
  if (typeof request.op !== "string" || !request.op.trim())
    return reject("invalid-request", "Expected a non-empty op string");
  if ("params" in request && !isObject(request.params))
    return reject("invalid-request", "Expected params to be an object");
  const { requestId, op } = request;
  if (op === "capabilities") {
    const { capabilities, supportedMajors } = capabilitiesResponse();
    return {
      ...base,
      outcome: "accepted" as const,
      code: null,
      supportedMajors,
      capabilities,
    };
  }
  if (!RUN_OPS.has(op) || !deps)
    return reject("unsupported-op", `Unsupported op: ${op}`);

  const params = isObject(request.params) ? request.params : {};
  const ticket = params.ticket;
  if (typeof ticket !== "string" || !/^[1-9][0-9]*$/.test(ticket))
    return reject("invalid-request", "Expected params.ticket, a ticket number");
  const runId = request.runId;
  if (runId !== undefined && typeof runId !== "string")
    return reject("invalid-request", "Expected runId to be a string");
  if ((op === "pause" || op === "resume") && !runId)
    return reject("invalid-request", `${op} requires the expected runId`);

  const project = await deps.project(ticket);
  const current = await snapshotResponse(project);
  const snapshot = (
    current.outcome === "answered" ? (current.snapshot ?? null) : null
  ) as Snapshot | null;

  // Fencing and liveness checks shared by every run op. Returns a rejection code or null.
  const fence = (): [string, string] | null => {
    if (!snapshot) return ["run-not-found", `No run for ticket ${ticket}`];
    if (runId && snapshot.runId !== runId)
      return [
        "run-mismatch",
        `Expected run ${runId} but ticket ${ticket} is run ${snapshot.runId}`,
      ];
    return null;
  };

  if (op === "snapshot") {
    const failed = fence();
    if (failed) return { ...reject(...failed), snapshot };
    return { ...base, outcome: "answered" as const, code: null, snapshot };
  }

  const receipts = openReceipts({ runs: project.runs, ticket });
  const recorded = await receipts.record({
    requestId,
    op,
    runId: runId ?? null,
    params,
  });
  if (recorded.outcome === "rejected")
    return reject(recorded.code, recorded.message);
  const fromReceipt = (receipt: Receipt) => {
    const result = (receipt.result ?? {}) as { code?: string; runId?: string };
    return {
      ...base,
      outcome: "already-recorded" as const,
      code: null,
      receipt,
      runId: result.runId ?? receipt.runId,
      ...(result.code ? { recordedCode: result.code } : {}),
    };
  };
  if (recorded.outcome === "already-recorded")
    return fromReceipt(recorded.receipt);

  const refuse = async (code: string, message: string) => {
    const receipt = await receipts.transition(requestId, "failed", {
      code,
      message,
    });
    return { ...reject(code, message), receipt, snapshot };
  };
  const finish = async (id: string | undefined) => {
    const receipt = await receipts.transition(requestId, "completed", {
      runId: id,
    });
    return {
      ...base,
      outcome: "accepted" as const,
      code: null,
      receipt,
      runId: id,
    };
  };

  const failed = op === "start" ? null : fence();
  if (failed) return refuse(...failed);
  const live = snapshot?.owner === "live";
  try {
    if (op === "pause") {
      if (!live)
        return refuse("not-running", `Ticket ${ticket} has no live owner`);
      await deps.pause(project);
      return finish(snapshot?.runId);
    }
    if (live)
      return refuse("already-running", `Ticket ${ticket} already has an owner`);
    if (op === "start" && params.foreground === true) {
      if (!deps.foreground)
        return refuse("unsupported-op", "Foreground start is not available");
      await receipts.transition(requestId, "in-progress");
      const ended = await deps.foreground(project);
      if (ended.outcome === "completed") return finish(ended.runId);
      const receipt = await receipts.transition(requestId, ended.outcome, {
        runId: ended.runId,
        ...(ended.outcome === "failed" ? { code: "run-failed" } : {}),
      });
      if (ended.outcome === "failed")
        return {
          ...reject("run-failed", `Owner for ticket ${ticket} failed`),
          receipt,
          snapshot,
        };
      return {
        ...base,
        outcome: "accepted" as const,
        code: null,
        receipt,
        runId: ended.runId,
      };
    }
    const launched = await deps.launch(project, op as "start" | "resume");
    return finish(launched.runId);
  } catch (error) {
    const receipt = await receipts.transition(requestId, "failed", {
      code: "internal-error",
      message: String(error),
    });
    return {
      ...reject("internal-error", String(error)),
      receipt,
      snapshot,
    };
  }
}
