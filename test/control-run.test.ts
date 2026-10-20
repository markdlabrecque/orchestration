import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

let runs: string;
let launched: number;
let paused: number;
let foregrounded: number;
let duringReceipt: unknown;
let endWith: "completed" | "failed" | "superseded" | "throw";
beforeEach(async () => {
  foregrounded = 0;
  duringReceipt = undefined;
  endWith = "completed";
  runs = await mkdtemp(join(tmpdir(), "orch-control-run-"));
  launched = 0;
  paused = 0;
});
afterEach(() => rm(runs, { recursive: true, force: true }));

const deps = () => ({
  project: async () => ({ runs, ticket: "7" }) as never,
  launch: async () => {
    launched++;
    await writeStatus("running");
    return { runId: "run-1" };
  },
  pause: async () => {
    paused++;
  },
  foreground: async () => {
    foregrounded++;
    duringReceipt = JSON.parse(
      await readFile(join(runs, "7.requests", "fg.json"), "utf8"),
    ).state;
    if (endWith === "throw") throw new Error("boom");
    return { runId: "run-1", outcome: endWith };
  },
});

async function writeStatus(status: string, runId = "run-1") {
  await writeFile(
    join(runs, "7.status.json"),
    JSON.stringify({ version: 1, status, runId, updatedAt: "t" }),
  );
}
const owner = (pid: number) =>
  writeFile(join(runs, "7.owner.json"), JSON.stringify({ pid }));

async function control(request: Record<string, unknown>) {
  const out: string[] = [];
  await runCli(["control", "--json"], {
    stdin: JSON.stringify({ contract: "orch.control/1", ...request }),
    output: (t) => out.push(t),
    controlDeps: deps(),
  });
  return JSON.parse(out.join(""));
}
const params = { ticket: "7" };

test("start launches once and returns the runId with a completed receipt", async () => {
  const r = await control({ requestId: "a", op: "start", params });
  expect(r).toMatchObject({
    outcome: "accepted",
    code: null,
    runId: "run-1",
    receipt: { requestId: "a", op: "start", state: "completed" },
  });
  expect(launched).toBe(1);
});

const fg = { ticket: "7", foreground: true };

test("foreground start records the receipt, runs the owner in-process, then completes", async () => {
  const r = await control({ requestId: "fg", op: "start", params: fg });
  expect(duringReceipt).toBe("in-progress");
  expect(foregrounded).toBe(1);
  expect(launched).toBe(0);
  expect(r).toMatchObject({
    outcome: "accepted",
    runId: "run-1",
    receipt: { requestId: "fg", state: "completed" },
  });
});

test("foreground start replay is already-recorded and does not run a second owner", async () => {
  await control({ requestId: "fg", op: "start", params: fg });
  const r = await control({ requestId: "fg", op: "start", params: fg });
  expect(r.outcome).toBe("already-recorded");
  expect(foregrounded).toBe(1);
  expect(launched).toBe(0);
});

test("foreground start ending failed or superseded is recorded as such", async () => {
  endWith = "failed";
  const f = await control({ requestId: "fg", op: "start", params: fg });
  expect(f).toMatchObject({
    outcome: "rejected",
    receipt: { state: "failed" },
  });
  endWith = "superseded";
  const s = await control({ requestId: "fg", op: "start", params: { ...fg } });
  expect(s.outcome).toBe("already-recorded");
});

test("foreground start superseded outcome is recorded", async () => {
  endWith = "superseded";
  const s = await control({ requestId: "fg", op: "start", params: fg });
  expect(s.receipt.state).toBe("superseded");
});

test("foreground owner throwing fails the receipt", async () => {
  endWith = "throw";
  const r = await control({ requestId: "fg", op: "start", params: fg });
  expect(r).toMatchObject({
    outcome: "rejected",
    code: "internal-error",
    receipt: { state: "failed" },
  });
});

test("foreground start with a live owner is already-running and runs nothing", async () => {
  await writeStatus("running");
  await owner(process.pid);
  const r = await control({ requestId: "fg", op: "start", params: fg });
  expect(r).toMatchObject({ outcome: "rejected", code: "already-running" });
  expect(foregrounded).toBe(0);
});

test("start replay is already-recorded and does not launch again", async () => {
  await control({ requestId: "a", op: "start", params });
  const r = await control({ requestId: "a", op: "start", params });
  expect(r.outcome).toBe("already-recorded");
  expect(r.receipt.state).toBe("completed");
  expect(launched).toBe(1);
});

test("same requestId with different params is request-id-conflict", async () => {
  await control({ requestId: "a", op: "start", params });
  const r = await control({
    requestId: "a",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({ outcome: "rejected", code: "request-id-conflict" });
});

test("start with a live owner is already-running with a snapshot", async () => {
  await writeStatus("running");
  await owner(process.pid);
  const r = await control({ requestId: "b", op: "start", params });
  expect(r).toMatchObject({
    outcome: "rejected",
    code: "already-running",
    snapshot: { runId: "run-1", owner: "live" },
  });
  expect(launched).toBe(0);
});

test("pause with a mismatched runId is run-mismatch", async () => {
  await writeStatus("running");
  await owner(process.pid);
  const r = await control({
    requestId: "c",
    op: "pause",
    runId: "other",
    params,
  });
  expect(r).toMatchObject({ outcome: "rejected", code: "run-mismatch" });
  expect(paused).toBe(0);
});

test("pause without runId is invalid-request", async () => {
  const r = await control({ requestId: "c", op: "pause", params });
  expect(r).toMatchObject({ outcome: "rejected", code: "invalid-request" });
});

test("pause with no live owner is not-running", async () => {
  await writeStatus("paused");
  const r = await control({
    requestId: "d",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({ outcome: "rejected", code: "not-running" });
  expect(paused).toBe(0);
});

test("pause with a live owner signals it and completes", async () => {
  await writeStatus("running");
  await owner(process.pid);
  const r = await control({
    requestId: "e",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({
    outcome: "accepted",
    receipt: { state: "completed" },
  });
  expect(paused).toBe(1);
});

test("resume with a live owner is already-running with a snapshot", async () => {
  await writeStatus("running");
  await owner(process.pid);
  const r = await control({
    requestId: "f",
    op: "resume",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({
    outcome: "rejected",
    code: "already-running",
    snapshot: { state: "running" },
  });
});

test("resume of a paused run launches; wrong runId is run-mismatch", async () => {
  await writeStatus("paused");
  const bad = await control({
    requestId: "g",
    op: "resume",
    runId: "x",
    params,
  });
  expect(bad.code).toBe("run-mismatch");
  const r = await control({
    requestId: "h",
    op: "resume",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({ outcome: "accepted", runId: "run-1" });
  expect(launched).toBe(1);
});

test("snapshot answers without writing a receipt; fences on runId", async () => {
  await writeStatus("paused");
  const r = await control({ requestId: "i", op: "snapshot", params });
  expect(r).toMatchObject({
    outcome: "answered",
    code: null,
    receipt: null,
    snapshot: { runId: "run-1", state: "paused" },
  });
  const bad = await control({
    requestId: "j",
    op: "snapshot",
    runId: "z",
    params,
  });
  expect(bad).toMatchObject({ outcome: "rejected", code: "run-mismatch" });
  expect(await readdir(runs)).not.toContain("7.requests");
});

test("snapshot with no run is run-not-found", async () => {
  const r = await control({ requestId: "k", op: "snapshot", params });
  expect(r).toMatchObject({ outcome: "rejected", code: "run-not-found" });
});
