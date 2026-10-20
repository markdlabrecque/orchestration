import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACT } from "./capabilities.ts";
import type { Project } from "./engine.ts";

export type OwnerState = "live" | "absent" | "unknown";

const ownerFile = (project: Project) =>
  join(project.runs, `${project.ticket}.owner.json`);

// Published by the execution owner so observers can probe liveness without opening storage.
export async function publishOwner(project: Project) {
  await writeFile(
    ownerFile(project),
    `${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  return () => rm(ownerFile(project), { force: true });
}

export async function probeOwner(project: Project): Promise<OwnerState> {
  let pid: unknown;
  try {
    pid = JSON.parse(await readFile(ownerFile(project), "utf8")).pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "unknown";
  }
  if (typeof pid !== "number") return "unknown";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "absent"
      : "unknown";
  }
}

const ACTIVE = new Set(["running", "pausing"]);

export async function snapshotResponse(project: Project) {
  let status: { status: string; runId?: string; updatedAt?: string };
  try {
    status = JSON.parse(
      await readFile(
        join(project.runs, `${project.ticket}.status.json`),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        contract: CONTRACT,
        outcome: "rejected",
        code: "run-not-found",
      };
    throw error;
  }
  const owner = await probeOwner(project);
  const state =
    ACTIVE.has(status.status) && owner !== "live"
      ? "recovery-needed"
      : status.status;
  return {
    contract: CONTRACT,
    outcome: "answered",
    snapshot: {
      runId: status.runId,
      state,
      recordedState: status.status,
      owner,
      publishedAt: status.updatedAt,
      status,
    },
  };
}
