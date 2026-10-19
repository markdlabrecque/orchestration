import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { type RunOptions, runWorkflow } from "../src/engine.ts";
import { resolveWorkflow } from "../src/workflow.ts";

function fixture(yaml: string): RunOptions {
  return {
    workflow: resolveWorkflow(
      `version: 1\nrunners: { shell: { command: cat } }\n${yaml}`,
    ),
    storage: new MemoryStorage(),
    models: createModels(),
    role: async (name) => name,
    execute: async () => ({
      status: "done",
      code: 0,
      stdout: "base",
      stderr: "",
    }),
    project: {
      root: "/fixture",
      repo: "a/b",
      main: process.cwd(),
      worktree: process.cwd(),
      runs: "/fixture/runs",
      base: "main",
      ticket: "142",
      pickup: async () => {},
      publish: async () => "head",
      retire: async () => {},
    },
    tracker: {
      readTicket: async () => ({
        id: "142",
        url: "ticket",
        title: "Repair",
        body: "",
      }),
      assign: async () => {},
      abort: async () => {},
      comment: async () => ({ id: "1", url: "comment" }),
      followUp: async () => ({ id: "2", url: "followup" }),
      pullRequest: async () => ({ id: "3", url: "pr" }),
      readPullRequest: async () => ({
        id: "3",
        url: "pr",
        head: "head",
        merged: false,
      }),
      ci: async () => "passed",
      merge: async () => {},
    },
  };
}

test("ordered repair bodies return to their detector and share spent budget", async () => {
  const f = fixture(`budgets: { bounces: { max: 3 } }
repairs:
  fix:
    - { id: edit, kind: shell, options: { command: edit } }
    - { id: check, kind: shell, options: { command: check } }
steps:
  - { id: review, kind: shell, options: { command: review }, on: { failed: { repair: fix, budget: bounces } } }
  - { id: verify, kind: shell, options: { command: verify }, on: { failed: { repair: fix, budget: bounces } } }`);
  const trace: string[] = [];
  f.execute = async (r) => {
    const command = r.argv[2];
    const failed =
      ["review", "verify"].includes(command) && !trace.includes(command);
    if (["review", "verify", "edit", "check"].includes(command))
      trace.push(command);
    return { status: "done", code: failed ? 1 : 0, stdout: "base", stderr: "" };
  };
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(trace).toEqual([
    "review",
    "edit",
    "check",
    "review",
    "verify",
    "edit",
    "check",
    "verify",
  ]);
  expect(result.budgets).toEqual({ bounces: { spent: 2, grants: 0 } });
});

const finding = {
  summary: "data loss",
  evidence: "store.ts:4",
  classification: "must-fix" as const,
};
function agents(
  f: RunOptions,
  results: import("../src/runners/types.ts").AgentResult[],
  prompts: string[] = [],
) {
  f.runner = () => ({
    resumable: false,
    run: async (request) => {
      prompts.push(request.prompt);
      const result = results.shift();
      if (!result) throw new Error("Unexpected agent call");
      return {
        status: "done",
        handoff: result.summary,
        result,
        artifacts: [],
        ranOn: { provider: "fake", model: "fake", effort: "high" },
        usage: null,
      };
    },
  });
}
const reviewWorkflow = `budgets: { bounces: { max: 3 } }
repairs: { fix: { id: fix, kind: agent, runner: shell, role: implementor } }
steps:
  - { id: review, kind: agent, runner: shell, role: reviewer, on: { findings: { repair: fix, budget: bounces } } }`;

test("reviewer confirms stable IDs after repair; new scoped discoveries file immediately as follow-ups", async () => {
  const f = fixture(reviewWorkflow);
  const prompts: string[] = [];
  agents(
    f,
    [
      { outcome: "findings", summary: "needs repair", findings: [finding] },
      {
        outcome: "pass",
        summary: "changed",
        responses: [{ id: "F1", action: "changed", reason: "guard added" }],
      },
      {
        outcome: "pass",
        summary: "confirmed",
        decisions: [{ id: "F1", status: "fixed", reason: "guard verified" }],
        findings: [{ ...finding, summary: "new discovery" }],
      },
    ],
    prompts,
  );
  const filed: string[] = [];
  f.tracker.followUp = async (title, _body, marker) => {
    filed.push(title, marker);
    return { id: "9", url: "followup/9" };
  };
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(result.findings).toMatchObject([
    {
      id: "F1",
      detector: "review",
      status: "fixed",
      responses: [{ action: "changed" }],
      decisions: [{ status: "fixed" }],
    },
    {
      id: "F2",
      classification: "follow-up",
      filing: "linked",
      link: { id: "9", url: "followup/9" },
    },
  ]);
  expect(result.budgets.bounces.spent).toBe(1);
  expect(prompts[1]).toContain("F1");
  expect(prompts[2]).toContain("Repair diff:");
  expect(prompts[2]).toContain("guard added");
  expect(filed[0]).toBe("new discovery");
});

test("a repair gate failure spends another slot and uses a fresh repair invocation", async () => {
  const f = fixture(
    reviewWorkflow
      .replace("role: implementor }", "role: implementor, gate: tests-green }")
      .replace("budgets:", "settings: { tests: verify-repair }\nbudgets:"),
  );
  let gates = 0;
  f.execute = async (r) => ({
    status: "done",
    code: r.argv[2] === "verify-repair" && ++gates === 1 ? 1 : 0,
    stdout: "tree",
    stderr: "",
  });
  agents(f, [
    { outcome: "findings", summary: "fix", findings: [finding] },
    {
      outcome: "pass",
      summary: "first",
      responses: [{ id: "F1", action: "changed", reason: "first" }],
    },
    {
      outcome: "pass",
      summary: "second",
      responses: [{ id: "F1", action: "changed", reason: "second" }],
    },
    {
      outcome: "pass",
      summary: "reviewed",
      findings: [],
      decisions: [{ id: "F1", status: "fixed", reason: "confirmed" }],
    },
  ]);
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(result.budgets.bounces.spent).toBe(2);
  expect(result.findings?.[0].responses.map((r) => r.reason)).toEqual([
    "first",
    "second",
  ]);
});

test("at the cap a recorded grant allows exactly one additional repair", async () => {
  const f = fixture(reviewWorkflow.replace("max: 3", "max: 0"));
  agents(f, [
    { outcome: "findings", summary: "fix", findings: [finding] },
    {
      outcome: "pass",
      summary: "fixed",
      responses: [{ id: "F1", action: "changed", reason: "fixed" }],
    },
    {
      outcome: "pass",
      summary: "reviewed",
      findings: [],
      decisions: [{ id: "F1", status: "fixed", reason: "confirmed" }],
    },
  ]);
  f.ask = async () => "grant";
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(result.budgets.bounces).toEqual({ spent: 1, grants: 1 });
});

test("failed deferral remains open; resume links the ticket before asking about remaining findings", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openNodeSqliteStorage } = await import(
    "@earendil-works/pi-durable/storage/sqlite/node"
  );
  const dir = await mkdtemp(join(tmpdir(), "orch-deferral-"));
  try {
    const f = fixture(reviewWorkflow.replace("max: 3", "max: 0"));
    const path = join(dir, "run.sqlite");
    agents(f, [
      {
        outcome: "findings",
        summary: "fix",
        findings: [finding, { ...finding, summary: "another issue" }],
      },
    ]);
    const answers = ["defer", "F1", "separate migration needed"];
    f.ask = async () => answers.shift() ?? "abort";
    let marker = "";
    f.tracker.followUp = async (_title, _body, m) => {
      marker = m;
      throw new Error("response unknown");
    };
    const paused = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
    });
    expect(paused.status).toBe("paused");
    expect(paused.findings).toMatchObject([
      {
        id: "F1",
        status: "open",
        filing: "pending",
        deferralReason: "separate migration needed",
      },
      { id: "F2", status: "open" },
    ]);
    f.tracker.followUp = async (_title, _body, m) => {
      expect(m).toBe(marker);
      return { id: "9", url: "followup/9" };
    };
    f.ask = async (question) => {
      expect(question).toContain("F2");
      return "abort";
    };
    const resumed = await runWorkflow({
      ...f,
      storage: await openNodeSqliteStorage(path),
    });
    expect(resumed.status, resumed.reason).toBe("aborted");
    expect(resumed.findings).toMatchObject([
      { id: "F1", status: "deferred", link: { url: "followup/9" } },
      { id: "F2", status: "open" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("park publishes a draft listing open findings and never merges or retires", async () => {
  const f = fixture(reviewWorkflow.replace("max: 3", "max: 0"));
  agents(f, [{ outcome: "findings", summary: "fix", findings: [finding] }]);
  f.ask = async () => "park";
  const trace: string[] = [];
  f.project.publish = async () => {
    trace.push("publish");
    return "park-head";
  };
  f.tracker.pullRequest = async (
    _title,
    body,
    _branch,
    _base,
    _marker,
    options,
  ) => {
    expect(body).toContain("F1");
    expect(body).toContain("data loss");
    expect(options).toEqual({ draft: true });
    trace.push("draft");
    return { id: "3", url: "draft" };
  };
  f.project.retire = async () => {
    trace.push("retire");
  };
  f.tracker.merge = async () => {
    trace.push("merge");
  };
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("parked");
  expect(trace).toEqual(["publish", "draft"]);
});

test("CI repairs publish the new commit before fresh SHA CI and the pinned merge", async () => {
  const f = fixture(`budgets: { ci_repairs: { max: 2 } }
repairs:
  ci-fix:
    - { id: change, kind: shell, options: { command: change } }
    - { id: push-fix, kind: mr }
steps:
  - { id: mr, kind: mr }
  - { id: ci, kind: ci, on: { failed: { repair: ci-fix, budget: ci_repairs } } }
  - { id: merge, kind: merge }`);
  let head = "old",
    merged = false;
  const trace: string[] = [];
  f.execute = async (r) => {
    if (r.argv[2] === "change") {
      trace.push("edit");
      head = "new";
    }
    return { status: "done", code: 0, stdout: "tree", stderr: "" };
  };
  f.project.publish = async () => {
    trace.push(`push:${head}`);
    return head;
  };
  f.tracker.ci = async (_id, sha) => {
    trace.push(`ci:${sha}`);
    return sha === "old" ? "failed" : "passed";
  };
  f.tracker.readPullRequest = async () => ({
    id: "3",
    url: "pr",
    head,
    merged,
  });
  f.tracker.merge = async (_id, sha) => {
    trace.push(`merge:${sha}`);
    merged = true;
  };
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("merged");
  expect(trace).toEqual([
    "push:old",
    "ci:old",
    "edit",
    "push:new",
    "ci:new",
    "merge:new",
  ]);
  expect(result.budgets.ci_repairs).toEqual({ spent: 1, grants: 0 });
});

test("shipped workflow shares three review/verify slots and publishes inside its separate two-slot CI repair", async () => {
  const { readFile } = await import("node:fs/promises");
  const w = resolveWorkflow(
    await readFile(
      new URL("../workflow.default.yaml", import.meta.url),
      "utf8",
    ),
  );
  expect(w.budgets).toEqual({ bounces: { max: 3 }, ci_repairs: { max: 2 } });
  expect(w.steps.find((s) => s.id === "review")?.on?.findings.budget).toBe(
    "bounces",
  );
  expect(w.steps.find((s) => s.id === "verify")?.on?.findings.budget).toBe(
    "bounces",
  );
  const edge = w.steps.find((s) => s.id === "ci")?.on?.failed;
  expect(edge?.budget).toBe("ci_repairs");
  expect([w.repairs[edge?.repair ?? ""]].flat().at(-1)?.kind).toBe("mr");
});

test.each([
  "repair clears",
  "other reviewer",
  "missing confirmation",
  "agent defers",
])("%s cannot resolve an unauthorized finding", async (mode) => {
  const f = fixture(reviewWorkflow);
  const first = {
    outcome: "findings" as const,
    summary: "fix",
    findings: [finding],
  };
  const repair = {
    outcome: "pass" as const,
    summary: "fix",
    responses: [{ id: "F1", action: "changed" as const, reason: "fixed" }],
  };
  const recheck = {
    outcome: "pass" as const,
    summary: "reviewed",
    findings: [],
    decisions: [
      {
        id: mode === "other reviewer" ? "F99" : "F1",
        status: "fixed" as const,
        reason: "confirmed",
      },
    ],
  };
  const bad =
    mode === "repair clears"
      ? { ...repair, decisions: recheck.decisions }
      : mode === "agent defers"
        ? { ...repair, status: "deferred" }
        : repair;
  agents(f, [
    first,
    bad,
    mode === "missing confirmation" ? { ...recheck, decisions: [] } : recheck,
  ]);
  const result = await runWorkflow(f);
  expect(result.status).toBe("blocked");
  expect(result.findings?.[0].status).toBe("open");
  expect(result.budgets.bounces.spent).toBe(1);
});

test("all human deferrals recheck without another slot and still enforce the detecting gate", async () => {
  const f = fixture(
    reviewWorkflow
      .replace("max: 3", "max: 0")
      .replace("role: reviewer, on:", "role: reviewer, gate: tests-green, on:")
      .replace("budgets:", "settings: { tests: still-failing }\nbudgets:"),
  );
  const answers = ["defer", "F1", "human accepted risk"];
  f.ask = async () => answers.shift() ?? "abort";
  f.execute = async (r) => ({
    status: "done",
    code: r.argv[2] === "still-failing" ? 1 : 0,
    stdout: "tree",
    stderr: "",
  });
  agents(f, [
    { outcome: "findings", summary: "fix", findings: [finding] },
    { outcome: "pass", summary: "deferred", findings: [], decisions: [] },
  ]);
  const result = await runWorkflow(f);
  expect(result.status).toBe("blocked");
  expect(result.reason).toContain("tests-green");
  expect(result.findings?.[0]).toMatchObject({
    status: "deferred",
    filing: "linked",
  });
  expect(result.budgets.bounces).toBeUndefined();
});

test("non-review roles can report follow-ups but cannot declare findings resolved", async () => {
  const f = fixture(
    "steps: [{ id: implement, kind: agent, runner: shell, role: implementor }]",
  );
  agents(f, [
    {
      outcome: "pass",
      summary: "done",
      followUps: [{ summary: "later work", evidence: "module.ts:8" }],
    },
  ]);
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(result.findings).toMatchObject([
    {
      id: "F1",
      detector: "implement",
      classification: "follow-up",
      filing: "linked",
    },
  ]);
});

test("Pi can recheck after all findings are deferred without reusing its original result", async () => {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(
    "@earendil-works/pi-ai/providers/faux"
  );
  const f = fixture(
    reviewWorkflow
      .replace("max: 3", "max: 0")
      .replace(
        "id: review, kind: agent, runner: shell",
        "id: review, kind: agent, runner: pi",
      ),
  );
  f.workflow.runners.pi = { provider: "faux", model: "fixture" };
  const provider = fauxProvider({ models: [{ id: "fixture" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  f.models = models;
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_result", {
        outcome: "findings",
        summary: "fix",
        findings: [finding],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit_result", {
        outcome: "pass",
        summary: "accepted deferral",
        findings: [],
        decisions: [],
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  const answers = ["defer", "F1", "human decision"];
  f.ask = async () => answers.shift() ?? "abort";
  const result = await runWorkflow(f);
  expect(result.status, result.reason).toBe("completed");
  expect(result.budgets.bounces).toBeUndefined();
});

test("a CI repair without publication cannot validate its local edits against the old SHA", async () => {
  const f = fixture(`budgets: { ci: { max: 1 } }
repairs: { fix: { id: edit, kind: shell, options: { command: edit } } }
steps:
  - { id: mr, kind: mr }
  - { id: ci, kind: ci, on: { failed: { repair: fix, budget: ci } } }
  - { id: merge, kind: merge }`);
  let polls = 0,
    merges = 0;
  f.tracker.ci = async () => (++polls === 1 ? "failed" : "passed");
  f.tracker.merge = async () => {
    merges++;
  };
  const result = await runWorkflow(f);
  expect(result.status).toBe("blocked");
  expect(result.reason).toMatch(/publish/i);
  expect(polls).toBe(1);
  expect(merges).toBe(0);
});

test("a second reviewer cannot confirm the first reviewer’s finding instead of its own", async () => {
  const f = fixture(`${reviewWorkflow}
  - { id: verify, kind: agent, runner: shell, role: verifier, options: { verification: local-tests }, on: { findings: { repair: fix, budget: bounces } } }`);
  agents(f, [
    { outcome: "findings", summary: "first", findings: [finding] },
    {
      outcome: "pass",
      summary: "fixed",
      responses: [{ id: "F1", action: "changed", reason: "fixed" }],
    },
    {
      outcome: "pass",
      summary: "confirmed",
      findings: [],
      decisions: [{ id: "F1", status: "fixed", reason: "confirmed" }],
    },
    { outcome: "findings", summary: "second", findings: [finding] },
    {
      outcome: "pass",
      summary: "fixed",
      responses: [{ id: "F2", action: "changed", reason: "fixed" }],
    },
    {
      outcome: "pass",
      summary: "wrong owner",
      findings: [],
      decisions: [{ id: "F1", status: "withdrawn", reason: "wrong ID" }],
    },
  ]);
  const result = await runWorkflow(f);
  expect(result.status).toBe("blocked");
  expect(result.findings).toMatchObject([
    { id: "F1", detector: "review", status: "fixed" },
    { id: "F2", detector: "verify", status: "open" },
  ]);
});
