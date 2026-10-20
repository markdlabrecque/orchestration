// Herdr adapter (#173): worktree lifecycle and command delivery against the fake Herdr CLI.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAdapter } from "../src/adapters/herdr/adapter.ts";
import { AdapterError } from "../src/adapters/herdr/errors.ts";
import { createHerdr, type Herdr } from "../src/adapters/herdr/herdr.ts";
import type { Orch } from "../src/adapters/herdr/orch.ts";
import { controlResponse } from "../src/control.ts";
import { openReceipts } from "../src/receipts.ts";
import {
  assertListBeforeCreate,
  assertNoForce,
  assertReceiptsQueriedBeforeResend,
  createFakeHerdr,
  type FakeHerdr,
} from "./fixtures/fake-herdr.ts";

let fake: FakeHerdr;
let receipts: Record<string, unknown>;
beforeEach(() => {
  fake = createFakeHerdr();
  receipts = {};
});
afterEach(() => fake.cleanup());

const orch = (): Orch =>
  ({
    capabilities: async () => ({ supportedMajors: [1] }),
    snapshot: async () => null,
    receipt: async (id: string) => receipts[id] ?? null,
  }) as unknown as Orch;

const make = (herdr?: Herdr, orchClient: Orch = orch()) =>
  createAdapter({
    herdr: herdr ?? createHerdr({ bin: fake.bin, env: fake.env }),
    orch: orchClient,
    ticket: "7",
    branch: "ticket-7",
    requestDir: fake.dir,
    settleMs: 0,
    onReceiptQuery: (id) => fake.note("receipt-query", id),
  });
const command = (id: string) =>
  `orch control --json < ${join(fake.dir, `${id}.json`)}`;

// A herdr whose first pane run times out, optionally after the command was delivered.
const flaky = (delivered: boolean): Herdr => {
  const real = createHerdr({ bin: fake.bin, env: fake.env });
  let first = true;
  return {
    ...real,
    paneRun: async (pane: string, cmd: string[]) => {
      if (!first) return real.paneRun(pane, cmd);
      first = false;
      if (delivered) await real.paneRun(pane, cmd);
      throw new AdapterError("timeout", "herdr pane run timed out");
    },
  };
};

test("start creates the worktree once; a second start opens it (list before create)", async () => {
  const a = await make().start();
  const b = await make().start();
  expect(b.paneId).toBe(a.paneId);
  const creates = fake
    .log()
    .filter((e) => e.args.join(" ").startsWith("worktree create"));
  expect(creates).toHaveLength(1);
  assertListBeforeCreate(fake.log());
  expect(fake.violations()).toEqual([]);
});

test("start sends a foreground orch.control/1 start request through the pane", async () => {
  const { paneId, requestId } = await make().start();
  expect(fake.ran(paneId)).toEqual([command(requestId)]);
  expect(
    JSON.parse(readFileSync(join(fake.dir, `${requestId}.json`), "utf8")),
  ).toEqual({
    contract: "orch.control/1",
    requestId,
    op: "start",
    params: { ticket: "7", foreground: true },
  });
});

test("re-send queries the receipt first and does not resend when it is recorded", async () => {
  const adapter = make();
  const { paneId, requestId } = await adapter.start();
  receipts[requestId] = { requestId, state: "in-progress" };
  expect(await adapter.resend()).toEqual({ sent: false });
  expect(fake.ran(paneId)).toEqual([command(requestId)]);
  assertReceiptsQueriedBeforeResend(fake.log());
  expect(fake.log().some((e) => e.note && e.args[1] === requestId)).toBe(true);
});

test("re-send with no receipt sends the same request again, after a receipt query", async () => {
  const adapter = make();
  const { paneId, requestId } = await adapter.start();
  expect(await adapter.resend()).toEqual({ sent: true });
  expect(fake.ran(paneId)).toEqual([command(requestId), command(requestId)]);
  assertReceiptsQueriedBeforeResend(fake.log());
});

test("a pane run timeout that was delivered is not re-sent because the receipt exists", async () => {
  const withReceipt: Orch = {
    ...orch(),
    receipt: async (id: string) => ({ requestId: id, state: "in-progress" }),
  } as Orch;
  const { paneId, requestId } = await make(flaky(true), withReceipt).start();
  expect(fake.ran(paneId)).toEqual([command(requestId)]);
  const log = fake.log();
  const sends = log.filter((e) => !e.note && e.args[1] === "run");
  expect(sends).toHaveLength(1);
  expect(log.some((e) => e.note && e.args[1] === requestId)).toBe(true);
  assertReceiptsQueriedBeforeResend(log);
});

test("a pane run timeout that was not delivered is re-sent after a receipt query", async () => {
  const { paneId, requestId } = await make(flaky(false)).start();
  expect(fake.ran(paneId)).toEqual([command(requestId)]);
  const log = fake.log();
  const query = log.findIndex((e) => e.note && e.args[1] === requestId);
  const send = log.findIndex((e) => !e.note && e.args[1] === "run");
  expect(query).toBeGreaterThanOrEqual(0);
  expect(send).toBeGreaterThan(query);
});

test("real chain: the delivered request leaves a receipt in orch, so resend() is skipped", async () => {
  const runs = mkdtempSync(join(tmpdir(), "herdr-chain-"));
  try {
    const real: Orch = {
      ...orch(),
      receipt: async (id: string) =>
        openReceipts({ runs, ticket: "7" }).get(id),
    } as Orch;
    const adapter = make(undefined, real);
    const { paneId, requestId } = await adapter.start();
    // What the pane does with the command: feed the request file to `orch control`.
    const sent = readFileSync(join(fake.dir, `${requestId}.json`), "utf8");
    const response = await controlResponse(sent, {
      project: async () => ({ runs, ticket: "7" }) as never,
      launch: async () => ({ runId: "x" }),
      pause: async () => {},
      foreground: async () => ({ runId: "run-1", outcome: "completed" }),
    });
    expect(response.outcome).toBe("accepted");
    expect(await adapter.resend()).toEqual({ sent: false });
    expect(fake.ran(paneId)).toEqual([command(requestId)]);
    assertReceiptsQueriedBeforeResend(fake.log());
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

test("release removes a clean worktree without --force", async () => {
  const adapter = make();
  await adapter.start();
  await adapter.release();
  expect(fake.exec(["worktree", "list"]).json.result.worktrees).toEqual([]);
  assertNoForce(fake.log());
});

test("release of a worktree that is not open opens it first, then removes by workspace", async () => {
  const adapter = make();
  await adapter.start();
  fake.close("ticket-7");
  await adapter.release();
  expect(fake.exec(["worktree", "list"]).json.result.worktrees).toEqual([]);
  const verbs = fake.log().map((e) => e.args.slice(0, 2).join(" "));
  expect(verbs.slice(-4, -1)).toEqual([
    "worktree list",
    "worktree open",
    "worktree remove",
  ]);
  assertNoForce(fake.log());
});

test("session, base and worktree path reach Herdr", async () => {
  const herdr = createHerdr({
    bin: fake.bin,
    env: fake.env,
    session: "s1",
    repo: "/repo",
  });
  await createAdapter({
    herdr,
    orch: orch(),
    ticket: "7",
    branch: "ticket-7",
    base: "trunk",
    worktreePath: "/wt/seven",
    requestDir: fake.dir,
  }).start();
  const log = fake.log();
  expect(log.every((e) => e.session === "s1")).toBe(true);
  const create = log.find((e) => e.args[1] === "create");
  expect(create?.args).toEqual(
    expect.arrayContaining(["--base", "trunk", "--path", "/wt/seven"]),
  );
  expect(create?.args).toEqual(expect.arrayContaining(["--cwd", "/repo"]));
});

test("release of a dirty worktree is refused with dirty_worktree_requires_force, never forced", async () => {
  const adapter = make();
  await adapter.start();
  fake.markDirty("ticket-7");
  await expect(adapter.release()).rejects.toMatchObject({
    code: "dirty_worktree_requires_force",
  });
  expect(fake.exec(["worktree", "list"]).json.result.worktrees).toHaveLength(1);
  assertNoForce(fake.log());
});
