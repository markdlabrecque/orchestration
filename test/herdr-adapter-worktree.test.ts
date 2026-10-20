// Herdr adapter (#173): worktree lifecycle and command delivery against the fake Herdr CLI.
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAdapter } from "../src/adapters/herdr/adapter.ts";
import { createHerdr } from "../src/adapters/herdr/herdr.ts";
import type { Orch } from "../src/adapters/herdr/orch.ts";
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

const make = () =>
  createAdapter({
    herdr: createHerdr({ bin: fake.bin, env: fake.env }),
    orch: orch(),
    ticket: "7",
    branch: "ticket-7",
    onReceiptQuery: (id) => fake.note("receipt-query", id),
  });

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

test("start runs `orch run <ticket>` in the pane", async () => {
  const { paneId } = await make().start();
  expect(fake.ran(paneId)).toEqual(["orch run 7"]);
});

test("re-send queries the receipt first and does not resend when it is recorded", async () => {
  const adapter = make();
  const { paneId, requestId } = await adapter.start();
  receipts[requestId] = { requestId, state: "completed" };
  await adapter.resend();
  expect(fake.ran(paneId)).toEqual(["orch run 7"]);
  assertReceiptsQueriedBeforeResend(fake.log());
  expect(fake.log().some((e) => e.note && e.args[1] === requestId)).toBe(true);
});

test("re-send with no receipt sends again, after a receipt query", async () => {
  const adapter = make();
  const { paneId } = await adapter.start();
  await adapter.resend();
  expect(fake.ran(paneId)).toEqual(["orch run 7", "orch run 7"]);
  assertReceiptsQueriedBeforeResend(fake.log());
});

test("release removes a clean worktree without --force", async () => {
  const adapter = make();
  await adapter.start();
  await adapter.release();
  expect(fake.exec(["worktree", "list"]).json.worktrees).toEqual([]);
  assertNoForce(fake.log());
});

test("release of a dirty worktree is refused with dirty_worktree_requires_force, never forced", async () => {
  const adapter = make();
  await adapter.start();
  fake.markDirty("ticket-7");
  await expect(adapter.release()).rejects.toMatchObject({
    code: "dirty_worktree_requires_force",
  });
  expect(fake.exec(["worktree", "list"]).json.worktrees).toHaveLength(1);
  assertNoForce(fake.log());
});
