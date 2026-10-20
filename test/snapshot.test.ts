import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Project } from "../src/engine.ts";
import { snapshotResponse as rawSnapshot } from "../src/snapshot.ts";

type Snap = {
  snapshot: { state: string; owner?: string; recordedState?: string };
};
const snapshotResponse = async (p: Project) =>
  (await rawSnapshot(p)) as unknown as Snap;

async function setup(status: string, pid?: number) {
  const dir = await mkdtemp(join(tmpdir(), "orch-snap-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "7.status.json"),
    JSON.stringify({ version: 1, status, runId: "r1", updatedAt: "t" }),
  );
  if (pid !== undefined)
    await writeFile(join(dir, "7.owner.json"), JSON.stringify({ pid }));
  return { dir, project: { runs: dir, ticket: "7" } as unknown as Project };
}
test("running with no owner is recovery-needed", async () => {
  const { dir, project } = await setup("running");
  try {
    const r = await snapshotResponse(project);
    expect(r.snapshot).toMatchObject({
      state: "recovery-needed",
      recordedState: "running",
      owner: "absent",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("running with a live owner stays running; paused is unchanged", async () => {
  const a = await setup("running", process.pid);
  const b = await setup("paused");
  try {
    expect((await snapshotResponse(a.project)).snapshot).toMatchObject({
      state: "running",
      owner: "live",
    });
    expect((await snapshotResponse(b.project)).snapshot.state).toBe("paused");
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});
