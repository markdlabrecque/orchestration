import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ControlDeps } from "./control.ts";
import { packageRoot } from "./project.ts";
import { ownerPid, snapshotResponse } from "./snapshot.ts";

// Default launch reuses `orch run`, the single run owner entry point; no second harness is opened.
export const launchRun: ControlDeps["launch"] = async (project) => {
  const child = spawn(join(packageRoot, "bin/orch"), ["run", project.ticket], {
    cwd: project.root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await snapshotResponse(project);
    const snap = r.snapshot as { runId?: string; owner?: string } | undefined;
    if (snap?.runId && snap.owner === "live") return { runId: snap.runId };
    if (child.exitCode !== null)
      throw new Error(`orch run exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Run owner did not become live");
};

// SIGTERM is the existing pause signal for a foreground owner.
export const pauseRun: ControlDeps["pause"] = async (project) => {
  const pid = await ownerPid(project);
  if (pid === undefined) throw new Error("No owner pid to signal");
  process.kill(pid, "SIGTERM");
};
