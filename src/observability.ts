import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Project, RunState } from "./engine.ts";
import type { RunnerEvent } from "./runners/types.ts";

export type RunStatus = Pick<
  RunState,
  | "status"
  | "reason"
  | "currentStep"
  | "outcomes"
  | "startedAt"
  | "updatedAt"
  | "resumptions"
  | "crashes"
  | "budgets"
  | "repair"
  | "retirement"
  | "runId"
> & { version: 1; ticket: string };
export type RunEvent = RunnerEvent & {
  version: 1;
  ticket: string;
  runId: string;
  timestamp: string;
  step: string | null;
};

// These are disposable read projections. Only Pi Durable owns run state.
export function observeRun(
  project: Project,
  output: (text: string) => void,
  onEvent?: (event: RunnerEvent) => void,
) {
  const statusFile = join(project.runs, `${project.ticket}.status.json`);
  const eventsFile = join(project.runs, `${project.ticket}.events.jsonl`);
  if (existsSync(eventsFile)) {
    const bytes = readFileSync(eventsFile);
    // A killed append may leave a partial record. Preserve every complete record.
    if (bytes.length && bytes.at(-1) !== 10)
      truncateSync(eventsFile, bytes.lastIndexOf(10) + 1);
  }
  let state: RunState | undefined;
  let lastStep: string | null = null;
  const event = (event: RunnerEvent) => {
    const record: RunEvent = {
      ...event,
      version: 1,
      ticket: project.ticket,
      runId: state?.runId ?? "",
      timestamp: new Date().toISOString(),
      step: state?.currentStep ?? null,
    };
    appendFileSync(eventsFile, `${JSON.stringify(record)}\n`);
    onEvent?.(event);
    if (event.type === "tool") {
      const data = event.data as { type?: string; toolName?: string } | null;
      if (!data?.type || data.type === "tool_execution_start")
        output(`Tool ${data?.toolName ?? "call"}`);
    }
    if (
      event.type === "status" &&
      event.data &&
      typeof event.data === "object"
    ) {
      if ("handoff" in event.data && typeof event.data.handoff === "string")
        output(event.data.handoff);
      if ("outcome" in event.data && "step" in event.data)
        output(`Step ${event.data.step}: ${event.data.outcome}`);
    }
  };
  return {
    event,
    state(next: RunState) {
      state = next;
      const {
        status,
        reason,
        currentStep,
        outcomes,
        startedAt,
        updatedAt,
        resumptions,
        crashes,
        budgets,
        repair,
        retirement,
        runId,
      } = next;
      const projection: RunStatus = {
        version: 1,
        ticket: project.ticket,
        status,
        reason,
        currentStep,
        outcomes,
        startedAt,
        updatedAt,
        resumptions,
        crashes,
        budgets,
        repair,
        retirement,
        runId,
      };
      const temporary = `${statusFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(projection)}\n`);
      renameSync(temporary, statusFile);
      event({ type: "status", data: projection });
      if (status === "running" && currentStep && currentStep !== lastStep)
        output(`Step ${currentStep}`);
      lastStep = currentStep;
    },
  };
}

function versioned(text: string) {
  const value = JSON.parse(text);
  if (value?.version !== 1)
    throw new Error(`Unsupported observability version: ${value?.version}`);
  return value;
}
export async function showRun(
  project: Project,
  output: (text: string) => void,
) {
  output(
    JSON.stringify(
      versioned(
        await readFile(
          join(project.runs, `${project.ticket}.status.json`),
          "utf8",
        ),
      ),
      null,
      2,
    ),
  );
}
export async function tailRun(
  project: Project,
  output: (text: string) => void,
  signal: AbortSignal,
) {
  let offset = 0;
  const file = join(project.runs, `${project.ticket}.events.jsonl`);
  while (!signal.aborted) {
    const bytes = await readFile(file);
    let end = bytes.indexOf(10, offset);
    while (end !== -1) {
      output(
        JSON.stringify(versioned(bytes.subarray(offset, end).toString("utf8"))),
      );
      offset = end + 1;
      end = bytes.indexOf(10, offset);
    }
    try {
      await setTimeout(100, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
