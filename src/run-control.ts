import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ControlDeps } from "./control.ts";
import { packageRoot } from "./project.ts";
import { ownerPid, snapshotResponse } from "./snapshot.ts";

// The owner is host-bound (#164): it stays in the host's process group so it dies with the host.
// A detached owner (setsid) would outlive its host and contradict the declared capability.
export const ownerSpawnOptions = (cwd: string) => ({
  cwd,
  stdio: "ignore" as const,
});

// Default launch reuses `orch run`, the single run owner entry point; no second harness is opened.
export const launchRun: ControlDeps["launch"] = async (project) => {
  const child = spawn(
    join(packageRoot, "bin/orch"),
    ["run", project.ticket],
    ownerSpawnOptions(project.root),
  );
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

// Foreground start: `orch run` runs in the calling pane with inherited stdio, not detached and
// not unref'd, so it stays host-bound (#164). Pause signals reach the owner, not this wrapper.
export const foregroundRun: NonNullable<ControlDeps["foreground"]> = async (
  project,
) => {
  const child = spawn(join(packageRoot, "bin/orch"), ["run", project.ticket], {
    cwd: project.root,
    stdio: "inherit",
  });
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
  const forward = (signal: NodeJS.Signals) => () => {
    if (signal !== "SIGINT") child.kill(signal);
  };
  const handlers = signals.map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? -1));
    });
    const snap = (await snapshotResponse(project)).snapshot as
      | { runId?: string }
      | undefined;
    return {
      runId: snap?.runId,
      outcome: code === 0 ? ("completed" as const) : ("failed" as const),
    };
  } finally {
    for (const [s, h] of handlers) process.removeListener(s, h);
  }
};

// SIGTERM is the existing pause signal for a foreground owner.
export const pauseRun: ControlDeps["pause"] = async (project) => {
  const pid = await ownerPid(project);
  if (pid === undefined) throw new Error("No owner pid to signal");
  process.kill(pid, "SIGTERM");
};
