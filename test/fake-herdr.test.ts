import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assertListBeforeCreate,
  assertNoForce,
  assertReceiptsQueriedBeforeResend,
  createFakeHerdr,
  type FakeHerdr,
} from "./fixtures/fake-herdr.ts";

let fake: FakeHerdr;
beforeEach(() => {
  fake = createFakeHerdr();
});
afterEach(() => fake.cleanup());

const create = (branch = "172") =>
  fake.exec([
    "worktree",
    "create",
    "--branch",
    branch,
    "--base",
    "main",
    "--path",
    `/wt/${branch}`,
  ]);

test("worktree list is empty, create returns workspace id and path, list shows it", () => {
  expect(fake.exec(["worktree", "list"]).json).toMatchObject({
    ok: true,
    worktrees: [],
  });
  const made = create();
  expect(made.code).toBe(0);
  expect(made.json).toMatchObject({
    ok: true,
    path: "/wt/172",
    workspace_id: expect.any(String),
    pane_id: expect.any(String),
  });
  expect(fake.exec(["worktree", "list"]).json.worktrees).toHaveLength(1);
});

test("a second create is not idempotent: worktree_create_failed", () => {
  create();
  const again = create();
  expect(again.code).not.toBe(0);
  expect(again.error).toMatchObject({ code: "worktree_create_failed" });
});

test("open returns the existing workspace; unknown branch fails", () => {
  const made = create();
  const opened = fake.exec(["worktree", "open", "--branch", "172"]);
  expect(opened.json).toMatchObject({
    ok: true,
    workspace_id: made.json.workspace_id,
    path: "/wt/172",
  });
  const missing = fake.exec(["worktree", "open", "--branch", "nope"]);
  expect(missing.code).not.toBe(0);
  expect(missing.error.code).toBe("worktree_not_found");
});

test("remove refuses a dirty tree without --force, and flags --force as a violation", () => {
  create();
  fake.markDirty("172");
  const refused = fake.exec(["worktree", "remove", "--branch", "172"]);
  expect(refused.code).not.toBe(0);
  expect(refused.error.code).toBe("dirty_worktree_requires_force");
  expect(fake.exec(["worktree", "list"]).json.worktrees).toHaveLength(1);
  const forced = fake.exec([
    "worktree",
    "remove",
    "--branch",
    "172",
    "--force",
  ]);
  expect(forced.code).toBe(0);
  expect(fake.violations().join("\n")).toMatch(/--force/);
});

test("remove of a clean tree succeeds", () => {
  create();
  expect(fake.exec(["worktree", "remove", "--branch", "172"]).code).toBe(0);
  expect(fake.exec(["worktree", "list"]).json.worktrees).toEqual([]);
});

test("pane run records the command; pane read answers from the script", () => {
  const pane = create().json.pane_id;
  expect(fake.exec(["pane", "run", pane, "orch", "run", "172"]).code).toBe(0);
  expect(fake.ran(pane)).toEqual(["orch run 172"]);
  fake.setOutput(pane, "hello\n");
  expect(fake.exec(["pane", "read", pane]).json).toMatchObject({
    ok: true,
    text: "hello\n",
  });
  expect(fake.exec(["pane", "run", "p-missing", "x"]).error.code).toBe(
    "pane_not_found",
  );
});

const report = (pane: string, state: string, seq: number) =>
  fake.exec([
    "pane",
    "report-agent",
    pane,
    "--source",
    "orch",
    "--agent",
    "orch",
    "--state",
    state,
    "--seq",
    String(seq),
  ]);
const status = (pane: string) =>
  fake.exec(["pane", "get", pane]).json.agent_status;

test("report-agent ignores stale seq", () => {
  const pane = create().json.pane_id;
  expect(status(pane)).toBe("unknown");
  report(pane, "blocked", 3);
  const stale = report(pane, "working", 2);
  expect(stale.code).toBe(0);
  expect(stale.json.ignored).toBe(true);
  expect(status(pane)).toBe("blocked");
  report(pane, "working", 4);
  expect(status(pane)).toBe("working");
});

test("release-agent and server restart reset state to unknown", () => {
  const pane = create().json.pane_id;
  report(pane, "working", 5);
  fake.exec(["pane", "release-agent", pane]);
  expect(status(pane)).toBe("unknown");
  report(pane, "idle", 6);
  fake.restart();
  expect(status(pane)).toBe("unknown");
  // Workspaces survive the restart; the seq counter does not.
  expect(fake.exec(["worktree", "list"]).json.worktrees).toHaveLength(1);
  report(pane, "working", 1);
  expect(status(pane)).toBe("working");
});

test("every invocation is logged, including failures", () => {
  create();
  create();
  fake.exec(["worktree", "list"]);
  expect(fake.log().map((e) => e.args.slice(0, 2).join(" "))).toEqual([
    "worktree create",
    "worktree create",
    "worktree list",
  ]);
  expect(fake.log().map((e) => e.code)).toEqual([0, 1, 0]);
});

test("the fake flags create without a prior list or open", () => {
  create();
  expect(fake.violations().join("\n")).toMatch(/list-before-create/);
  expect(() => assertListBeforeCreate(fake.log())).toThrow(/list/);
});

test("list then create satisfies list-before-create", () => {
  fake.exec(["worktree", "list"]);
  create();
  expect(fake.violations()).toEqual([]);
  assertListBeforeCreate(fake.log());
  assertNoForce(fake.log());
});

test("assertNoForce throws when --force was passed", () => {
  fake.exec(["worktree", "remove", "--branch", "x", "--force"]);
  expect(() => assertNoForce(fake.log())).toThrow(/--force/);
});

test("a repeated pane run needs a receipt query in between", () => {
  const pane = create().json.pane_id;
  fake.exec(["pane", "run", pane, "orch", "run", "172"]);
  fake.exec(["pane", "run", pane, "orch", "run", "172"]);
  expect(() => assertReceiptsQueriedBeforeResend(fake.log())).toThrow(
    /receipt/,
  );

  fake.reset();
  const p2 = create().json.pane_id;
  fake.exec(["pane", "run", p2, "orch", "run", "172"]);
  fake.note("receipt-query", "req-1");
  fake.exec(["pane", "run", p2, "orch", "run", "172"]);
  assertReceiptsQueriedBeforeResend(fake.log());
  // A different command is not a re-send.
  fake.exec(["pane", "run", p2, "orch", "snapshot", "172"]);
  assertReceiptsQueriedBeforeResend(fake.log());
});

test("the executable shares state and log with the helper", () => {
  const run = (...args: string[]) =>
    spawnSync(fake.bin, args, {
      env: { ...process.env, ...fake.env },
      encoding: "utf8",
    });
  const made = run("worktree", "create", "--branch", "9", "--base", "main");
  expect(made.status).toBe(0);
  const again = run("worktree", "create", "--branch", "9", "--base", "main");
  expect(again.status).toBe(1);
  expect(JSON.parse(again.stderr).error.code).toBe("worktree_create_failed");
  expect(fake.exec(["worktree", "list"]).json.worktrees).toHaveLength(1);
  expect(fake.log().length).toBe(3);
});
