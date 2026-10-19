import { readFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { runWorkflow } from "../src/engine.ts";
import type { Tracker } from "../src/tracker/types.ts";
import { resolveWorkflow } from "../src/workflow.ts";

async function fixture() {
  const workflow = resolveWorkflow(
    await readFile(
      new URL("../workflow.default.yaml", import.meta.url),
      "utf8",
    ),
  );
  workflow.runners.pi = { provider: "faux", model: "fixture" };
  workflow.runners.shell.command = `printf '{"outcome":"pass","summary":"implemented"}' > "$ORCH_RESULT_FILE"; printf implemented`;
  const models = createModels(),
    faux = fauxProvider({ models: [{ id: "fixture" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_result", { outcome: "pass", summary: "plan" }),
      { stopReason: "toolUse" },
    ),
  ]);
  const trace: string[] = [];
  let merged = false,
    head = "abc";
  const tracker: Tracker = {
    readTicket: async () => ({
      id: "139",
      url: "ticket",
      title: "A change",
      body: "Implement it",
    }),
    assign: async () => {
      trace.push("assigned");
    },
    comment: async () => {
      trace.push("comment");
      return { id: "1", url: "comment" };
    },
    followUp: async () => ({ id: "2", url: "followup" }),
    pullRequest: async () => {
      trace.push("pr");
      return { id: "3", url: "pr" };
    },
    readPullRequest: async () => ({ id: "3", url: "pr", head, merged }),
    ci: async () => {
      trace.push("ci");
      return "passed";
    },
    merge: async (_id, sha) => {
      expect(sha).toBe(head);
      trace.push("merge");
      merged = true;
    },
  };
  const project = {
    root: "/fixture",
    repo: "a/b",
    main: process.cwd(),
    base: "main",
    worktree: process.cwd(),
    runs: "/fixture/runs",
    ticket: "139",
    pickup: async () => {
      trace.push("pickup");
    },
    publish: async () => {
      trace.push("publish");
      return head;
    },
    retire: async () => {
      trace.push("retire");
    },
  };
  return {
    workflow,
    models,
    tracker,
    project,
    trace,
    faux,
    storage: new MemoryStorage(),
    role: async () => "Do the work",
    setHead: (s: string) => {
      head = s;
    },
  };
}
test("fixed workflow crosses both real runners and only retires after a confirmed pinned merge", async () => {
  const f = await fixture();
  expect(await runWorkflow(f)).toMatchObject({
    status: "merged",
    handoffs: { plan: "plan", implement: "implemented" },
  });
  expect(f.trace).toEqual([
    "assigned",
    "pickup",
    "comment",
    "publish",
    "pr",
    "ci",
    "merge",
    "retire",
  ]);
});
test("a head changed after CI blocks merge and retirement", async () => {
  const f = await fixture();
  f.tracker.ci = async () => {
    f.setHead("changed");
    return "passed";
  };
  expect(await runWorkflow(f)).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/head/),
  });
  expect(f.trace).not.toContain("merge");
  expect(f.trace).not.toContain("retire");
});

test("SQLite pause/resume skips completed Pi work and restarts shell on the dirty worktree", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-resume-"));
  const controller = new AbortController();
  try {
    const f = await fixture();
    f.project.worktree = dir;
    f.workflow.runners.shell.command = `if [ ! -f dirty ]; then printf saved > dirty; printf ready; sleep 20; else test "$(cat dirty)" = saved; printf '{"outcome":"pass","summary":"resumed"}' > "$ORCH_RESULT_FILE"; printf resumed; fi`;
    const path = join(dir, "run.sqlite");
    const paused = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text" && event.data === "ready") controller.abort();
      },
    });
    expect(paused.status).toBe("paused");
    expect(await readFile(join(dir, "dirty"), "utf8")).toBe("saved");
    const resumed = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
    });
    expect(resumed).toMatchObject({
      status: "merged",
      handoffs: { plan: "plan", implement: "resumed" },
    });
    expect(f.faux.state.callCount).toBe(1);
    expect(f.trace.filter((s) => s === "pickup")).toHaveLength(1);
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(path) }),
    ).toMatchObject({ status: "merged" });
    expect(f.trace.filter((s) => s === "merge")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted tracker write is retried with the same durable marker", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-write-"));
  try {
    const f = await fixture();
    let marker = "";
    let first = true;
    f.tracker.comment = async (_id, _body, m) => {
      if (first) {
        marker = m;
        first = false;
        throw new Error("lost response after remote write");
      }
      expect(m).toBe(marker);
      return { id: "existing", url: "comment" };
    };
    const file = join(dir, "run.sqlite");
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(file) }),
    ).toMatchObject({ status: "blocked" });
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(file) }),
    ).toMatchObject({ status: "merged" });
    expect(f.faux.state.callCount).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CI uses the injected clock and blocks after ninety minutes without merging", async () => {
  const f = await fixture();
  let now = 1_000;
  let polls = 0;
  f.tracker.ci = async () => {
    polls++;
    return "pending";
  };
  const state = await runWorkflow({
    ...f,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    runner: () => ({
      resumable: false,
      run: async () => ({
        status: "done",
        handoff: "checked",
        result: { outcome: "pass", summary: "checked" },
        artifacts: [],
        ranOn: { provider: "fixture", model: "fixture", effort: "medium" },
        usage: null,
      }),
    }),
  });
  expect(state).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/timed out/),
  });
  expect(polls).toBe(90);
  expect(f.trace).not.toContain("merge");
  expect(f.trace).not.toContain("retire");
});

test("a lost merge response resumes by confirming the existing merge before retirement", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-merge-"));
  try {
    const f = await fixture();
    const merge = f.tracker.merge;
    let writes = 0;
    f.tracker.merge = async (id, sha) => {
      writes++;
      await merge(id, sha);
      throw new Error("lost merge response");
    };
    const path = join(dir, "run.sqlite");
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(path) }),
    ).toMatchObject({ status: "blocked" });
    expect(f.trace).not.toContain("retire");
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(path) }),
    ).toMatchObject({
      status: "merged",
      outcomes: { merge: "merged", ci: "passed" },
    });
    expect(writes).toBe(1);
    expect(f.trace.filter((s) => s === "retire")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project patches resolve settings and execute a shell step in the ticket worktree", async () => {
  const f = await fixture();
  f.workflow = resolveWorkflow(
    `version: 1
settings: { command: 'printf global' }
steps:
  - { id: check, kind: shell, options: { command: '$settings.command' } }
`,
    `version: 1
settings: { command: 'printf project' }
patch:
  - set: check
    with: { when: 'settings.command != disabled' }
`,
  );
  const commands: unknown[] = [];
  const result = await runWorkflow({
    ...f,
    execute: async (request) => {
      commands.push({ cwd: request.cwd, argv: request.argv });
      return { code: 0, status: "done", stdout: "project", stderr: "" };
    },
  });
  expect(result).toMatchObject({
    status: "completed",
    outcomes: { check: "pass" },
  });
  expect(commands).toEqual([
    { cwd: f.project.worktree, argv: ["bash", "-c", "printf project"] },
  ]);
  expect(f.trace).toEqual(["assigned", "pickup"]);
});

test("registered kinds call a custom runner through execution helpers and preserve declared success", async () => {
  const { createRegistrations, defineRunner, defineStepKind } = await import(
    "../src/registration.ts"
  );
  const f = await fixture();
  const registrations = createRegistrations([
    defineRunner({
      name: "fixture",
      resumable: true,
      tools: ["read"],
      create: (config) => ({
        resumable: true,
        run: async (request) => ({
          status: "done",
          handoff: `${config.prefix}:${request.prompt}`,
          artifacts: [],
          ranOn: { provider: "fixture", model: "fixture", effort: "medium" },
          usage: null,
        }),
      }),
    }),
    defineStepKind({
      name: "check",
      runners: ["fixture"],
      outcomes: ["checked", "broken"],
      run: async (step, helpers) => {
        const result = await helpers.runAgent("fixture", {
          prompt: String(step.options?.prompt),
          role: "check",
          cwd: helpers.cwd,
          model: { tier: "standard", effort: "medium" },
          tools: ["read"],
          timeoutMs: 1000,
          resultSchema: (await import("../src/runners/types.ts")).resultSchema,
          signal: helpers.signal,
          onEvent: helpers.onEvent,
        });
        return { outcome: "checked", handoff: result.handoff };
      },
    }),
  ]);
  const workflow = resolveWorkflow(
    `version: 1
settings: { message: resolved }
runners: { fixture: { prefix: custom } }
steps:
  - { id: check, kind: check, options: { prompt: '$settings.message' } }
`,
    undefined,
    { registrations },
  );
  expect(await runWorkflow({ ...f, workflow, registrations })).toMatchObject({
    status: "completed",
    outcomes: { check: "checked" },
    handoffs: { check: "custom:resolved" },
  });
});

test("a custom kind's declared runner is preflighted before pickup", async () => {
  const { createRegistrations, defineRunner, defineStepKind } = await import(
    "../src/registration.ts"
  );
  const f = await fixture();
  const registrations = createRegistrations([
    defineRunner({
      name: "unavailable",
      resumable: false,
      tools: ["read"],
      preflight: async () => {
        throw new Error("fixture runner unavailable");
      },
      create: () => {
        throw new Error("must not construct");
      },
    }),
    defineStepKind({
      name: "uses-agent",
      runners: ["unavailable"],
      outcomes: ["pass"],
      run: async () => ({ outcome: "pass" }),
    }),
  ]);
  const workflow = resolveWorkflow(
    `version: 1\nsteps: [{id: check, kind: uses-agent}]\n`,
    undefined,
    { registrations },
  );
  await expect(runWorkflow({ ...f, workflow, registrations })).rejects.toThrow(
    /fixture runner unavailable/,
  );
  expect(f.trace).toEqual([]);
});

test("skipping merge never retires a worktree or reports a merge", async () => {
  const f = await fixture();
  f.workflow.steps[f.workflow.steps.length - 1].when = "lane == no-code";
  expect(await runWorkflow(f)).toMatchObject({
    status: "completed",
    outcomes: { merge: "skipped" },
  });
  expect(f.trace).not.toContain("retire");
});

test.each([
  [
    "human",
    {
      id: "approval",
      kind: "human",
      options: { ask: "Approve?", choices: ["yes", "no"] },
    },
  ],
  [
    "test gate",
    {
      id: "check",
      kind: "shell",
      options: { command: "echo" },
      gate: "tests-green",
    },
  ],
])("deferred %s behavior blocks explicitly instead of advancing or merging", async (_label, step) => {
  const f = await fixture();
  f.workflow.settings.tests = "echo";
  f.workflow.steps.splice(-1, 0, step);
  expect(await runWorkflow(f)).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/not implemented/),
  });
  expect(f.trace).not.toContain("merge");
  expect(f.trace).not.toContain("retire");
});

test("resume preflights the durable workflow before a removed custom kind can execute", async () => {
  const { createRegistrations, defineStepKind } = await import(
    "../src/registration.ts"
  );
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-preflight-resume-"));
  try {
    const f = await fixture();
    const registrations = createRegistrations([
      defineStepKind({
        name: "custom",
        outcomes: ["pass", "failed"],
        run: async () => ({ outcome: "failed" }),
      }),
    ]);
    const workflow = resolveWorkflow(
      `version: 1\nsteps: [{id: check, kind: custom}]\n`,
      undefined,
      { registrations },
    );
    const file = join(dir, "run.sqlite");
    expect(
      await runWorkflow({
        ...f,
        workflow,
        registrations,
        storage: await openNodeSqliteStorage(file),
      }),
    ).toMatchObject({ status: "blocked" });
    f.trace.length = 0;
    expect(
      await runWorkflow({ ...f, storage: await openNodeSqliteStorage(file) }),
    ).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/unknown kind custom/),
    });
    expect(f.trace).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
