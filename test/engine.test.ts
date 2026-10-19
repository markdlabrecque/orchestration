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
