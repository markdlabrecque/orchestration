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
      new URL("./fixtures/slice-workflow.yaml", import.meta.url),
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
    abort: async () => {},
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
    ).toMatchObject({ status: "paused" });
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

test("spec selects a lane and routes only implementation to its selected tier", async () => {
  const f = await fixture();
  f.workflow = resolveWorkflow(`version: 1
runners: { shell: { command: cat } }
steps:
  - { id: spec, kind: agent, runner: shell, options: { role: spec-writer } }
  - { id: tests, kind: agent, runner: shell, options: { role: test-writer }, when: 'lane == standard' }
  - { id: implement, kind: agent, runner: shell, options: { role: implementor }, model: { tier: standard, effort: high } }
  - { id: review, kind: agent, runner: shell, options: { role: reviewer }, when: 'lane != trivial', model: { tier: frontier, effort: low } }
`);
  const requests: { tier: string; effort: string }[] = [];
  const state = await runWorkflow({
    ...f,
    runner: () => ({
      resumable: false,
      run: async (request) => {
        requests.push(request.model);
        return {
          status: "done",
          handoff: "done",
          result:
            requests.length === 1
              ? {
                  outcome: "pass",
                  summary: "spec",
                  lane: "trivial",
                  implementationTier: "heavy",
                }
              : { outcome: "pass", summary: "implemented" },
          artifacts: [],
          ranOn: { provider: "fake", model: "fake", effort: "high" },
          usage: null,
        };
      },
    }),
  });
  expect(state).toMatchObject({
    status: "completed",
    lane: "trivial",
    implementationTier: "heavy",
    outcomes: { tests: "skipped", review: "skipped" },
  });
  expect(requests).toEqual([
    { tier: "standard", effort: "medium" },
    { tier: "heavy", effort: "high" },
  ]);
});

test.each([
  "lane:trivial",
  "lane:no-code",
])("ticket label %s overrides a valid spec lane", async (label) => {
  const f = await fixture();
  f.tracker.readTicket = async () => ({
    id: "141",
    url: "ticket",
    title: "Forced",
    body: "",
    labels: [label],
  });
  f.workflow.steps = [
    {
      id: "spec",
      kind: "agent",
      runner: "shell",
      options: { role: "spec-writer" },
    },
  ];
  f.workflow.runners.shell.command = `printf '%s' '{"outcome":"pass","summary":"spec","lane":"standard","implementationTier":"light"}' > "$ORCH_RESULT_FILE"`;
  expect(await runWorkflow(f)).toMatchObject({
    status: "completed",
    lane: label.slice(5),
  });
});

test.each([
  ["spec-writer", { lane: "invented", implementationTier: "light" }],
  ["spec-writer", { lane: "standard", implementationTier: "invented" }],
  ["implementor", { lane: "trivial", implementationTier: "light" }],
])("invalid or unauthorized selection from %s blocks", async (role, fields) => {
  const f = await fixture();
  f.workflow.steps = [
    { id: "select", kind: "agent", runner: "shell", options: { role } },
  ];
  f.workflow.runners.shell.command = `printf '%s' '${JSON.stringify({ outcome: "pass", summary: "bad selection", ...fields })}' > "$ORCH_RESULT_FILE"`;
  expect(await runWorkflow(f)).toMatchObject({ status: "blocked" });
});

test("red accepts only the declared assertion failures, then green reruns the suite", async () => {
  const f = await fixture();
  f.workflow.settings.tests = "fixture-tests";
  f.workflow.steps = [
    {
      id: "tests",
      kind: "agent",
      runner: "shell",
      role: "test-writer",
      gate: "tests-red",
    },
    {
      id: "implement",
      kind: "agent",
      runner: "shell",
      role: "implementor",
      gate: "tests-green",
    },
  ];
  let runs = 0;
  const { writeFile } = await import("node:fs/promises");
  const state = await runWorkflow({
    ...f,
    runner: () => ({
      resumable: false,
      run: async (request) => ({
        status: "done",
        handoff: "done",
        result:
          request.role.split("\n")[0] === "test-writer"
            ? {
                outcome: "pass",
                summary: "red",
                expectedFailures: [
                  { test: "saves an item", message: "expected saved" },
                ],
              }
            : { outcome: "pass", summary: "implemented" },
        artifacts: [],
        ranOn: { provider: "fake", model: "fake", effort: "high" },
        usage: null,
      }),
    }),
    role: async (name) => name,
    execute: async (request) => {
      if (request.argv[2] !== "fixture-tests")
        return { status: "done", code: 0, stdout: "", stderr: "" };
      runs++;
      if (request.env?.ORCH_TEST_REPORT_FILE)
        await writeFile(
          request.env.ORCH_TEST_REPORT_FILE,
          JSON.stringify({
            passed: 3,
            failures: [
              {
                test: "saves an item",
                message: "expected saved",
                kind: "assertion",
              },
            ],
            errors: [],
          }),
        );
      return {
        status: "done",
        code: runs === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    },
  });
  expect(state.status).toBe("completed");
  expect(runs).toBe(2);
});

test.each([
  "setup",
  "wrong assertion",
  "missing report",
  "green failure",
])("%s cannot pass a test gate", async (failure) => {
  const f = await fixture();
  f.workflow.settings.tests = "fixture-tests";
  f.workflow.steps = [
    {
      id: "tests",
      kind: "agent",
      runner: "shell",
      role: "test-writer",
      gate: failure === "green failure" ? "tests-green" : "tests-red",
    },
  ];
  const { writeFile } = await import("node:fs/promises");
  const state = await runWorkflow({
    ...f,
    runner: () => ({
      resumable: false,
      run: async () => ({
        status: "done",
        handoff: "done",
        result: {
          outcome: "pass",
          summary: "red",
          expectedFailures: [
            { test: "saves an item", message: "expected saved" },
          ],
        },
        artifacts: [],
        ranOn: { provider: "fake", model: "fake", effort: "high" },
        usage: null,
      }),
    }),
    execute: async (request) => {
      if (request.argv[2] !== "fixture-tests")
        return { status: "done", code: 0, stdout: "", stderr: "" };
      if (failure !== "missing report" && request.env?.ORCH_TEST_REPORT_FILE)
        await writeFile(
          request.env.ORCH_TEST_REPORT_FILE,
          JSON.stringify({
            passed: 0,
            failures: [
              {
                test: "saves an item",
                message:
                  failure === "wrong assertion"
                    ? "unrelated failure"
                    : "expected saved",
                kind: failure === "setup" ? "setup" : "assertion",
              },
            ],
            errors: [],
          }),
        );
      return { status: "done", code: 1, stdout: "", stderr: "failure" };
    },
  });
  expect(state).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/tests-(red|green)/),
  });
});

test("human pause asks again on resume and only the first choice advances", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-human-"));
  try {
    const f = await fixture();
    f.workflow.steps = [
      {
        id: "approval",
        kind: "human",
        options: { ask: "Merge?", choices: ["yes", "no"] },
      },
    ];
    const controller = new AbortController();
    let questions = 0;
    expect(
      await runWorkflow({
        ...f,
        storage: await openNodeSqliteStorage(join(dir, "run.sqlite")),
        signal: controller.signal,
        ask: async (_ask, _choices, signal) => {
          questions++;
          controller.abort();
          return new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("paused")),
              { once: true },
            ),
          );
        },
      }),
    ).toMatchObject({ status: "paused", index: 3 });
    expect(
      await runWorkflow({
        ...f,
        storage: await openNodeSqliteStorage(join(dir, "run.sqlite")),
        ask: async (ask, choices) => {
          questions++;
          expect(ask).toBe("Merge?");
          expect(choices).toEqual(["yes", "no"]);
          return "yes";
        },
      }),
    ).toMatchObject({ status: "completed", outcomes: { approval: "pass" } });
    expect(questions).toBe(2);
    expect(await runWorkflow({ ...f, ask: async () => "no" })).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/no/),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi and shell preserve the spec contract and Pi continues the same session with a fresh result", async () => {
  for (const runner of ["pi", "shell"]) {
    const f = await fixture();
    f.workflow.steps = [
      { id: "spec", kind: "agent", runner, role: "spec-writer" },
    ];
    const spec = {
      outcome: "pass",
      summary: "spec",
      lane: "no-code",
      implementationTier: "light",
    };
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_result", spec), {
        stopReason: "toolUse",
      }),
    ]);
    f.workflow.runners.shell.command = `printf '%s' '${JSON.stringify(spec)}' > "$ORCH_RESULT_FILE"`;
    if (runner === "pi") {
      f.workflow.steps.push({
        id: "report",
        kind: "agent",
        runner,
        role: "reporter",
        session: "spec",
      });
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("submit_result", spec), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          fauxToolCall("submit_result", { outcome: "pass", summary: "report" }),
          { stopReason: "toolUse" },
        ),
      ]);
    }
    const state = await runWorkflow(f);
    expect(state).toMatchObject({
      status: "completed",
      lane: "no-code",
      implementationTier: "light",
    });
    if (runner === "pi") {
      expect(state.handoffs.report).toBe("report");
      expect(state.sessions.report).toBe(state.sessions.spec);
    }
  }
});

test("a skipped source has no session and must not start a fresh agent", async () => {
  const f = await fixture();
  f.workflow.steps = [
    {
      id: "source",
      kind: "agent",
      runner: "pi",
      role: "slice-planner",
      when: "lane == no-code",
    },
    {
      id: "continue",
      kind: "agent",
      runner: "pi",
      role: "slice-planner",
      session: "source",
    },
  ];
  expect(await runWorkflow(f)).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/missing session/i),
  });
  expect(f.faux.state.callCount).toBe(0);
});

test("Pi maps spec-selected implementation tier while other roles keep their configured models", async () => {
  const f = await fixture();
  const provider = fauxProvider({ models: [{ id: "small" }, { id: "large" }] });
  f.models.setProvider(provider.provider);
  f.workflow.runners.pi = {
    models: {
      light: { provider: "faux", model: "small" },
      heavy: { provider: "faux", model: "large" },
      standard: { provider: "faux", model: "small" },
      frontier: { provider: "faux", model: "large" },
    },
  };
  f.workflow.steps = [
    {
      id: "spec",
      kind: "agent",
      runner: "pi",
      role: "spec-writer",
      model: { tier: "light", effort: "low" },
    },
    {
      id: "implement",
      kind: "agent",
      runner: "pi",
      role: "implementor",
      model: { tier: "standard", effort: "high" },
    },
  ];
  const models: string[] = [];
  provider.setResponses([
    (_context, _options, _state, model) => {
      models.push(model.id);
      return fauxAssistantMessage(
        fauxToolCall("submit_result", {
          outcome: "pass",
          summary: "spec",
          lane: "standard",
          implementationTier: "heavy",
        }),
        { stopReason: "toolUse" },
      );
    },
    (_context, _options, _state, model) => {
      models.push(model.id);
      return fauxAssistantMessage(
        fauxToolCall("submit_result", { outcome: "pass", summary: "done" }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  expect(await runWorkflow(f)).toMatchObject({ status: "completed" });
  expect(models).toEqual(["small", "large"]);
});

test.each<"standard" | "trivial" | "no-code">([
  "standard",
  "trivial",
  "no-code",
])("shipped %s lane executes its roles and gates through merge", async (lane) => {
  const f = await fixture();
  f.workflow = resolveWorkflow(
    await readFile(
      new URL("../workflow.default.yaml", import.meta.url),
      "utf8",
    ),
  );
  f.workflow.runners.pi = { provider: "faux", model: "fixture" };
  f.workflow.runners.shell = { command: "cat" };
  f.workflow.settings.tests = "fixture-tests";
  f.workflow.settings["merge-approval"] = false;
  const roles: string[] = [];
  let gates = 0;
  const { writeFile } = await import("node:fs/promises");
  const state = await runWorkflow({
    ...f,
    role: async (name) => name,
    runner: () => ({
      resumable: false,
      run: async (request) => {
        const role = request.role.split("\n")[0];
        roles.push(role);
        return {
          status: "done",
          handoff: request.role,
          result: {
            outcome: "pass",
            summary: request.role,
            ...(role === "spec-writer"
              ? { lane, implementationTier: "heavy" }
              : {}),
            ...(request.role.split("\n")[0] === "test-writer"
              ? {
                  expectedFailures: [
                    { test: "behavior", message: "expected behavior" },
                  ],
                }
              : {}),
            ...(["reviewer", "verifier"].includes(role)
              ? { findings: [] }
              : {}),
          },
          artifacts: [],
          ranOn: { provider: "fake", model: "fake", effort: "high" },
          usage: null,
        };
      },
    }),
    execute: async (request) => {
      if (request.argv[2] !== "fixture-tests")
        return { status: "done", code: 0, stdout: "", stderr: "" };
      gates++;
      if (gates === 1)
        await writeFile(
          request.env?.ORCH_TEST_REPORT_FILE ?? "",
          JSON.stringify({
            passed: 1,
            failures: [
              {
                test: "behavior",
                message: "expected behavior",
                kind: "assertion",
              },
            ],
            errors: [],
          }),
        );
      return {
        status: "done",
        code: gates === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    },
  });
  expect(state.status, state.reason).toBe("merged");
  expect(roles).toEqual(
    lane === "standard"
      ? ["spec-writer", "test-writer", "implementor", "reviewer", "reporter"]
      : lane === "trivial"
        ? ["spec-writer", "implementor", "reporter"]
        : ["spec-writer", "implementor", "reviewer", "reporter"],
  );
  expect(gates).toBe(lane === "standard" ? 2 : 0);
});

test.each([
  "timeout",
  "cancel",
])("Pi %s stops an active conversation without advancing", async (mode) => {
  const f = await fixture();
  const provider = fauxProvider({
    models: [{ id: "fixture" }],
    tokensPerSecond: 10,
  });
  f.models.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage("Working ".repeat(100))]);
  f.workflow.steps = [
    {
      id: "slow",
      kind: "agent",
      runner: "pi",
      role: "slice-planner",
      timeoutMs: mode === "timeout" ? 30 : 10000,
    },
  ];
  const controller = new AbortController();
  const result = await runWorkflow({
    ...f,
    signal: controller.signal,
    onEvent: (event) => {
      if (mode === "cancel" && event.type === "text") controller.abort();
    },
  });
  expect(result.status).toBe(mode === "timeout" ? "blocked" : "paused");
  if (mode === "timeout") expect(result.reason).toMatch(/timeout/);
  expect(result.outcomes.slow).toBe(mode === "timeout" ? "failed" : undefined);
}, 5000);

test("a passing reviewer cannot hide must-fix findings", async () => {
  const f = await fixture();
  f.workflow.steps = [
    { id: "review", kind: "agent", runner: "shell", role: "reviewer" },
  ];
  f.workflow.runners.shell.command = `printf '%s' '{"outcome":"pass","summary":"looks good","findings":[{"summary":"data loss","evidence":"store.ts:4","classification":"must-fix"}]}' > "$ORCH_RESULT_FILE"`;
  expect(await runWorkflow(f)).toMatchObject({
    status: "blocked",
    reason: expect.stringMatching(/must-fix/),
  });
});

test.each([
  "ddev",
  "docker",
  "local-tests",
])("verifier receives resolved %s options and prior typed results", async (verification) => {
  const f = await fixture();
  f.workflow = resolveWorkflow(`version: 1
settings: { verification: ${verification} }
runners: { shell: { command: cat } }
steps:
  - { id: verify, kind: agent, runner: shell, options: { role: verifier, verification: '$settings.verification' } }
`);
  let brief = "";
  expect(
    await runWorkflow({
      ...f,
      execute: async () => ({
        code: 0,
        status: "done",
        stdout: "",
        stderr: "",
      }),
      runner: () => ({
        resumable: false,
        run: async (request) => {
          brief = request.prompt;
          return {
            status: "done",
            handoff: "verified",
            result: { outcome: "pass", summary: "verified", findings: [] },
            artifacts: [],
            ranOn: { provider: "fake", model: "fake", effort: "high" },
            usage: null,
          };
        },
      }),
    }),
  ).toMatchObject({ status: "completed" });
  expect(brief).toContain(`"verification":"${verification}"`);
  expect(brief).toContain("Previous results:");
});

test("blocked findings retain their typed result and unsuccessful outcome", async () => {
  const f = await fixture();
  f.workflow.steps = [
    { id: "review", kind: "agent", runner: "shell", role: "reviewer" },
  ];
  f.workflow.runners.shell.command = `printf '%s' '{"outcome":"findings","summary":"repair needed","findings":[{"summary":"data loss","evidence":"store.ts:4","classification":"must-fix"}]}' > "$ORCH_RESULT_FILE"`;
  expect(await runWorkflow(f)).toMatchObject({
    status: "blocked",
    outcomes: { review: "findings" },
    results: { review: { outcome: "findings", summary: "repair needed" } },
    handoffs: { review: "" },
  });
});

test("Pi pause resumes its existing conversation and asks for the outstanding result", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-pi-pause-"));
  try {
    const f = await fixture();
    f.workflow.steps = [
      { id: "plan", kind: "agent", runner: "pi", role: "slice-planner" },
    ];
    const controller = new AbortController();
    const path = join(dir, "run.sqlite");
    const paused = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text" && typeof event.data !== "string")
          controller.abort();
      },
    });
    expect(paused.status).toBe("paused");
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("submit_result", { outcome: "pass", summary: "resumed" }),
        { stopReason: "toolUse" },
      ),
    ]);
    const resumed = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
    });
    expect(resumed.status, resumed.reason).toBe("completed");
    expect(f.trace.filter((s) => s === "pickup")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom kinds route Pi from the runner request tier", async () => {
  const { createRegistrations, defineStepKind } = await import(
    "../src/registration.ts"
  );
  const { resultSchema } = await import("../src/runners/types.ts");
  const f = await fixture();
  const provider = fauxProvider({ models: [{ id: "small" }, { id: "large" }] });
  f.models.setProvider(provider.provider);
  let selected = "";
  provider.setResponses([
    (_context, _options, _state, model) => {
      selected = model.id;
      return fauxAssistantMessage(
        fauxToolCall("submit_result", { outcome: "pass", summary: "done" }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  const registrations = createRegistrations([
    defineStepKind({
      name: "custom",
      outcomes: ["pass"],
      runners: ["pi"],
      run: async (_step, helpers) => {
        const result = await helpers.runAgent("pi", {
          prompt: "work",
          role: "work",
          cwd: helpers.cwd,
          model: { tier: "heavy", effort: "high" },
          tools: ["read"],
          timeoutMs: 1000,
          resultSchema,
          signal: helpers.signal,
          onEvent: helpers.onEvent,
        });
        return { outcome: result.status === "done" ? "pass" : "failed" };
      },
    }),
  ]);
  f.workflow.runners.pi = {
    models: {
      light: { provider: "faux", model: "small" },
      standard: { provider: "faux", model: "small" },
      heavy: { provider: "faux", model: "large" },
      frontier: { provider: "faux", model: "large" },
    },
  };
  f.workflow.steps = [{ id: "custom", kind: "custom" }];
  expect(await runWorkflow({ ...f, registrations })).toMatchObject({
    status: "completed",
  });
  expect(selected).toBe("large");
});
