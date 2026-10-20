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
const list = () => fake.exec(["worktree", "list"]).json.result.worktrees;
const paneOf = (made: ReturnType<typeof create>) =>
  made.json.result.root_pane.pane_id as string;

test("worktree list is empty, create returns the real shape, list shows it without dirty", () => {
  expect(fake.exec(["worktree", "list"]).json.result).toMatchObject({
    type: "worktree_list",
    worktrees: [],
  });
  const made = create();
  expect(made.code).toBe(0);
  expect(made.json.id).toEqual(expect.any(String));
  expect(made.json.result).toMatchObject({
    type: "worktree_created",
    root_pane: { pane_id: expect.any(String) },
    workspace: { workspace_id: expect.any(String) },
    worktree: { path: "/wt/172" },
  });
  expect(list()).toHaveLength(1);
  expect(list()[0]).toMatchObject({
    branch: "172",
    path: "/wt/172",
    open_workspace_id: made.json.result.workspace.workspace_id,
  });
  expect(list()[0]).not.toHaveProperty("dirty");
  expect(list()[0]).not.toHaveProperty("workspace_id");
});

test("a second create is not idempotent: worktree_create_failed", () => {
  create();
  const again = create();
  expect(again.code).not.toBe(0);
  expect(again.error).toMatchObject({ code: "worktree_create_failed" });
});

test("create requires --branch, --base and --path", () => {
  const r = fake.exec(["worktree", "create", "--branch", "x"]);
  expect(r.code).not.toBe(0);
  expect(r.error.message).toMatch(/missing required option/);
});

test("open returns the existing workspace; a closed one is reopened; unknown branch fails", () => {
  const made = create();
  const opened = fake.exec(["worktree", "open", "--branch", "172"]);
  expect(opened.json.result.workspace.workspace_id).toBe(
    made.json.result.workspace.workspace_id,
  );
  fake.close("172");
  expect(list()[0]).not.toHaveProperty("open_workspace_id");
  const reopened = fake.exec(["worktree", "open", "--branch", "172"]);
  expect(reopened.json.result.workspace.workspace_id).toEqual(
    expect.any(String),
  );
  expect(list()[0].open_workspace_id).toBe(
    reopened.json.result.workspace.workspace_id,
  );
  const missing = fake.exec(["worktree", "open", "--branch", "nope"]);
  expect(missing.code).not.toBe(0);
  expect(missing.error.code).toBe("worktree_not_found");
});

test("unknown options are rejected: --cwd and --branch on remove", () => {
  const made = create();
  const ws = made.json.result.workspace.workspace_id;
  for (const extra of [
    ["--cwd", "/repo"],
    ["--branch", "172"],
  ]) {
    const r = fake.exec(["worktree", "remove", "--workspace", ws, ...extra]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/);
  }
  expect(list()).toHaveLength(1);
});

test("remove refuses a dirty tree without --force, and flags --force as a violation", () => {
  const ws = create().json.result.workspace.workspace_id;
  fake.markDirty("172");
  const refused = fake.exec(["worktree", "remove", "--workspace", ws]);
  expect(refused.code).not.toBe(0);
  expect(refused.error.code).toBe("dirty_worktree_requires_force");
  expect(list()).toHaveLength(1);
  const forced = fake.exec([
    "worktree",
    "remove",
    "--workspace",
    ws,
    "--force",
  ]);
  expect(forced.code).toBe(0);
  expect(fake.violations().join("\n")).toMatch(/--force/);
});

test("remove of a clean tree succeeds", () => {
  const ws = create().json.result.workspace.workspace_id;
  expect(fake.exec(["worktree", "remove", "--workspace", ws]).code).toBe(0);
  expect(list()).toEqual([]);
});

test("--session is accepted before the command and logged", () => {
  const r = fake.exec(["--session", "s1", "worktree", "list"]);
  expect(r.code).toBe(0);
  expect(fake.log()[0]).toMatchObject({
    args: ["worktree", "list"],
    session: "s1",
  });
});

test("pane run records the command; pane read answers from the script", () => {
  const pane = paneOf(create());
  expect(fake.exec(["pane", "run", pane, "orch", "run", "172"]).code).toBe(0);
  expect(fake.ran(pane)).toEqual(["orch run 172"]);
  fake.setOutput(pane, "hello\n");
  expect(fake.exec(["pane", "read", pane]).json.result.text).toBe("hello\n");
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
  fake.exec(["pane", "get", pane]).json.result.pane.agent_status;

test("report-agent ignores stale seq", () => {
  const pane = paneOf(create());
  expect(status(pane)).toBe("unknown");
  report(pane, "blocked", 3);
  const stale = report(pane, "working", 2);
  expect(stale.code).toBe(0);
  expect(stale.json.result.ignored).toBe(true);
  expect(status(pane)).toBe("blocked");
  report(pane, "working", 4);
  expect(status(pane)).toBe("working");
});

test("release-agent and server restart reset state to unknown", () => {
  const pane = paneOf(create());
  report(pane, "working", 5);
  fake.exec(["pane", "release-agent", pane]);
  expect(status(pane)).toBe("unknown");
  report(pane, "idle", 6);
  fake.restart();
  expect(status(pane)).toBe("unknown");
  expect(list()).toHaveLength(1);
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
  fake.exec(["worktree", "remove", "--workspace", "w-1", "--force"]);
  expect(() => assertNoForce(fake.log())).toThrow(/--force/);
});

test("a repeated pane run needs a receipt query in between", () => {
  const pane = paneOf(create());
  fake.exec(["pane", "run", pane, "orch", "run", "172"]);
  fake.exec(["pane", "run", pane, "orch", "run", "172"]);
  expect(() => assertReceiptsQueriedBeforeResend(fake.log())).toThrow(
    /receipt/,
  );

  fake.reset();
  const p2 = paneOf(create());
  fake.exec(["pane", "run", p2, "orch", "run", "172"]);
  fake.note("receipt-query", "req-1");
  fake.exec(["pane", "run", p2, "orch", "run", "172"]);
  assertReceiptsQueriedBeforeResend(fake.log());
  fake.exec(["pane", "run", p2, "orch", "snapshot", "172"]);
  assertReceiptsQueriedBeforeResend(fake.log());
});

test("the executable shares state and log with the helper", () => {
  const run = (...args: string[]) =>
    spawnSync(fake.bin, args, {
      env: { ...process.env, ...fake.env },
      encoding: "utf8",
    });
  const a = ["worktree", "create", "--branch", "9", "--base", "main"];
  const made = run(...a, "--path", "/wt/9");
  expect(made.status).toBe(0);
  const again = run(...a, "--path", "/wt/9");
  expect(again.status).toBe(1);
  expect(JSON.parse(again.stderr).error.code).toBe("worktree_create_failed");
  expect(list()).toHaveLength(1);
  expect(fake.log().length).toBe(3);
});
