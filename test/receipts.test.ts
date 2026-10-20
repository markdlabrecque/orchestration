import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { openReceipts } from "../src/receipts.ts";

let runs: string;
beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), "orch-receipts-"));
});
afterEach(() => rm(runs, { recursive: true, force: true }));

const storage = () => ({ runs, ticket: "7" });
const pause = { requestId: "r1", op: "pause", runId: "run-1", params: {} };

test("a new request is accepted with an accepted receipt", async () => {
  const r = await openReceipts(storage()).record(pause);
  expect(r).toMatchObject({
    outcome: "accepted",
    receipt: {
      requestId: "r1",
      op: "pause",
      runId: "run-1",
      state: "accepted",
    },
  });
});

test("same id and same params returns the recorded receipt as already-recorded", async () => {
  const first = await openReceipts(storage()).record(pause);
  // A fresh store instance models a process restart.
  const again = await openReceipts(storage()).record({ ...pause });
  expect(again).toMatchObject({ outcome: "already-recorded" });
  expect((again as { receipt: unknown }).receipt).toEqual(
    (first as { receipt: unknown }).receipt,
  );
});

test("param key order and client metadata do not change identity", async () => {
  const store = openReceipts(storage());
  await store.record({
    requestId: "r2",
    op: "answer",
    runId: "run-1",
    params: { a: 1, b: { x: 1, y: 2 } },
    metadata: { client: "one" },
  });
  const again = await store.record({
    requestId: "r2",
    op: "answer",
    runId: "run-1",
    params: { b: { y: 2, x: 1 }, a: 1 },
    metadata: { client: "two" },
  });
  expect(again.outcome).toBe("already-recorded");
});

test("same id with different op, runId or params is a request-id-conflict and records nothing", async () => {
  const store = openReceipts(storage());
  await store.record(pause);
  for (const change of [
    { op: "resume" },
    { runId: "run-2" },
    { params: { force: true } },
  ]) {
    expect(await store.record({ ...pause, ...change })).toMatchObject({
      outcome: "rejected",
      code: "request-id-conflict",
    });
  }
  expect(await store.get("r1")).toMatchObject({
    op: "pause",
    state: "accepted",
  });
});

test("receipt state progresses accepted -> in-progress -> completed", async () => {
  const store = openReceipts(storage());
  await store.record(pause);
  await store.transition("r1", "in-progress");
  expect((await openReceipts(storage()).get("r1"))?.state).toBe("in-progress");
  await store.transition("r1", "completed", { paused: true });
  expect(await openReceipts(storage()).get("r1")).toMatchObject({
    state: "completed",
    result: { paused: true },
  });
  await expect(store.transition("r1", "in-progress")).rejects.toThrow();
});

test("get returns null for an unknown id; ids are scoped per run storage", async () => {
  expect(await openReceipts(storage()).get("nope")).toBeNull();
  await openReceipts(storage()).record(pause);
  expect(await openReceipts({ runs, ticket: "8" }).get("r1")).toBeNull();
});

test("orch request <requestId> --run <ticket> --json prints the receipt", async () => {
  await openReceipts(storage()).record(pause);
  const out: string[] = [];
  const execute = async () => {
    throw new Error("no exec");
  };
  const code = await runCli(["request", "r1", "--run", "7", "--json"], {
    output: (t: string) => out.push(t),
    runsDir: runs,
    execute,
  });
  expect(code).toBe(0);
  expect(JSON.parse(out.join(""))).toMatchObject({
    contract: "orch.control/1",
    outcome: "answered",
    receipt: { requestId: "r1", state: "accepted" },
  });
});

test("orch request for an unknown id answers rejected request-not-found", async () => {
  const out: string[] = [];
  await runCli(["request", "zzz", "--run", "7", "--json"], {
    output: (t: string) => out.push(t),
    runsDir: runs,
  });
  expect(JSON.parse(out.join(""))).toMatchObject({
    outcome: "rejected",
    code: "request-not-found",
    receipt: null,
  });
});
