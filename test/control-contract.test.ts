// Contract tests (fake platform only) for orch's side of orch.control/1 as built so far.
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { openReceipts } from "../src/receipts.ts";

let runs: string;
let launched: number;
let paused: number;
beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), "orch-contract-"));
  launched = 0;
  paused = 0;
});
afterEach(() => rm(runs, { recursive: true, force: true }));

const deps = () => ({
  project: async () => ({ runs, ticket: "7" }) as never,
  launch: async () => {
    launched++;
    await writeStatus("running");
    await owner(process.pid);
    return { runId: "run-1" };
  },
  pause: async () => {
    paused++;
  },
});
const writeStatus = (status: string, runId = "run-1") =>
  writeFile(
    join(runs, "7.status.json"),
    JSON.stringify({ version: 1, status, runId, updatedAt: "t" }),
  );
const owner = (pid: number) =>
  writeFile(join(runs, "7.owner.json"), JSON.stringify({ pid }));
const receipts = () => openReceipts({ runs, ticket: "7" });
const params = { ticket: "7" };
const deadPid = () => spawnSync("true").pid as number;

async function control(request: Record<string, unknown>) {
  const out: string[] = [];
  await runCli(["control", "--json"], {
    stdin: JSON.stringify({ contract: "orch.control/1", ...request }),
    output: (t) => out.push(t),
    controlDeps: deps(),
  });
  return JSON.parse(out.join(""));
}

test("start records a completed receipt carrying op, params and runId", async () => {
  await control({ requestId: "a", op: "start", params });
  expect(await receipts().get("a")).toMatchObject({
    requestId: "a",
    op: "start",
    params,
    state: "completed",
    result: { runId: "run-1" },
  });
});

test("same requestId with different params is request-id-conflict and leaves the receipt unchanged", async () => {
  await control({ requestId: "a", op: "start", params });
  const r = await control({
    requestId: "a",
    op: "start",
    params: { ticket: "7", extra: "different" },
  });
  expect(r).toMatchObject({ outcome: "rejected", code: "request-id-conflict" });
  expect(r.receipt).toBeNull();
  expect((await receipts().get("a"))?.params).toEqual(params);
});

test("a refusal fails its receipt; replay is already-recorded with the recorded code", async () => {
  await writeStatus("paused");
  const req = { requestId: "p", op: "pause", runId: "run-1", params };
  const first = await control(req);
  expect(first).toMatchObject({
    code: "not-running",
    receipt: { state: "failed" },
  });
  const replay = await control(req);
  expect(replay).toMatchObject({
    outcome: "already-recorded",
    recordedCode: "not-running",
    receipt: { state: "failed" },
  });
  expect(paused).toBe(0);
});

test("run-mismatch fails the receipt; a corrected retry under a new id is accepted", async () => {
  await writeStatus("paused");
  const bad = await control({
    requestId: "m1",
    op: "resume",
    runId: "old",
    params,
  });
  expect(bad).toMatchObject({ outcome: "rejected", code: "run-mismatch" });
  expect((await receipts().get("m1"))?.state).toBe("failed");
  expect(launched).toBe(0);
  const ok = await control({
    requestId: "m2",
    op: "resume",
    runId: "run-1",
    params,
  });
  expect(ok.outcome).toBe("accepted");
  expect(launched).toBe(1);
});

test("a delayed retry cannot act on a later run of the same ticket", async () => {
  await writeStatus("running", "run-2");
  await owner(process.pid);
  const r = await control({
    requestId: "late",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({ code: "run-mismatch" });
  expect(paused).toBe(0);
});

test("pause or resume with no run is run-not-found", async () => {
  for (const op of ["pause", "resume"]) {
    const r = await control({ requestId: op, op, runId: "run-1", params });
    expect(r).toMatchObject({ outcome: "rejected", code: "run-not-found" });
  }
});

test("not-running and already-running attach a snapshot", async () => {
  await writeStatus("paused");
  const notRunning = await control({
    requestId: "n",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(notRunning.snapshot).toMatchObject({
    runId: "run-1",
    state: "paused",
    owner: "absent",
  });
  await writeStatus("running");
  await owner(process.pid);
  const already = await control({ requestId: "s", op: "start", params });
  expect(already).toMatchObject({
    code: "already-running",
    snapshot: { state: "running", owner: "live" },
  });
  expect(launched).toBe(0);
});

test("snapshot owner probe: live, absent, unknown, and recovery-needed", async () => {
  const snap = async (id: string) =>
    (await control({ requestId: id, op: "snapshot", params })).snapshot;

  await writeStatus("running");
  await owner(process.pid);
  expect(await snap("1")).toMatchObject({ state: "running", owner: "live" });

  await owner(deadPid());
  expect(await snap("2")).toMatchObject({
    state: "recovery-needed",
    recordedState: "running",
    owner: "absent",
  });

  await rm(join(runs, "7.owner.json"));
  expect(await snap("3")).toMatchObject({
    state: "recovery-needed",
    owner: "absent",
  });

  await writeFile(join(runs, "7.owner.json"), "{ not json");
  expect(await snap("4")).toMatchObject({
    state: "recovery-needed",
    owner: "unknown",
  });

  await writeStatus("paused");
  const paused5 = await snap("5");
  expect(paused5).toMatchObject({ state: "paused", owner: "unknown" });
  expect(paused5.publishedAt).toBe("t");
});

test("resume of a recovery-needed run launches a new owner", async () => {
  await writeStatus("running");
  await owner(deadPid());
  const r = await control({
    requestId: "rec",
    op: "resume",
    runId: "run-1",
    params,
  });
  expect(r).toMatchObject({ outcome: "accepted", runId: "run-1" });
  expect(launched).toBe(1);
});

test("pause then resume: each request has its own receipt", async () => {
  await control({ requestId: "s", op: "start", params });
  const p = await control({
    requestId: "p",
    op: "pause",
    runId: "run-1",
    params,
  });
  expect(p.outcome).toBe("accepted");
  await rm(join(runs, "7.owner.json"));
  await writeStatus("paused");
  const r = await control({
    requestId: "r",
    op: "resume",
    runId: "run-1",
    params,
  });
  expect(r.outcome).toBe("accepted");
  expect(paused).toBe(1);
  expect(launched).toBe(2);
  expect((await readdir(join(runs, "7.requests"))).sort()).toEqual([
    "p.json",
    "r.json",
    "s.json",
  ]);
});

test("snapshot never writes a receipt", async () => {
  await writeStatus("paused");
  await control({ requestId: "q", op: "snapshot", params });
  expect(await readdir(runs)).not.toContain("7.requests");
});

test("undeclared owner-lifetime is unsupported-capability naming it; host-bound is fine", async () => {
  const call = async (...args: string[]) => {
    const out: string[] = [];
    await runCli(["capabilities", "--json", ...args], {
      stdin: "",
      output: (t) => out.push(t),
    });
    return JSON.parse(out.join(""));
  };
  const detached = await call("--owner-lifetime", "detached");
  expect(detached).toMatchObject({
    outcome: "rejected",
    code: "unsupported-capability",
  });
  expect(detached.detail).toContain("detached");
  expect((await call("--owner-lifetime", "host-bound")).outcome).toBe(
    "answered",
  );
});

for (const op of ["abort", "retire", "answer", "events"]) {
  test(`deferred op ${op} is unsupported-op even with run deps, and records nothing`, async () => {
    await writeStatus("running");
    const r = await control({ requestId: op, op, runId: "run-1", params });
    expect(r).toMatchObject({ outcome: "rejected", code: "unsupported-op" });
    expect(r.receipt).toBeNull();
    expect(await readdir(runs)).not.toContain("7.requests");
    expect(launched + paused).toBe(0);
  });
}
