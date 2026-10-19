import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "vitest";
import { runWorkflow } from "../src/engine.ts";
import { createTracker } from "../src/tracker/index.ts";
import { resolveWorkflow } from "../src/workflow.ts";
import { fakeForge } from "./fixtures/forge.ts";

test.each([
  "github",
  "gitlab",
] as const)("%s interrupted filing stays paused until reconciliation, without replaying the agent", async (forge) => {
  const dir = await mkdtemp(join(tmpdir(), "orch-tracker-"));
  try {
    const fake = fakeForge(forge);
    fake.state.loseResponse = true;
    let agentCalls = 0;
    const file = join(dir, "run.sqlite");
    const run = async () =>
      runWorkflow({
        workflow: resolveWorkflow(`version: 1
runners: {shell: {command: cat}}
steps: [{id: implement, kind: agent, runner: shell, role: implementor}]
`),
        storage: await openNodeSqliteStorage(file),
        models: createModels(),
        tracker: createTracker({ repo: "team/repo", forge }, dir, fake.execute),
        project: {
          root: dir,
          main: dir,
          worktree: dir,
          runs: dir,
          repo: "team/repo",
          ticket: "3",
          base: "main",
          pickup: async () => {},
          publish: async () => "abc",
          retire: async () => {},
        },
        role: async (name) => name,
        runner: () => ({
          resumable: false,
          run: async () => {
            agentCalls++;
            return {
              status: "done",
              handoff: "done",
              result: {
                outcome: "pass",
                summary: "done",
                followUps: [{ summary: "Later work", evidence: "module.ts:8" }],
              },
              artifacts: [],
              ranOn: { provider: "fake", model: "fake", effort: "medium" },
              usage: null,
            };
          },
        }),
      });
    expect(await run()).toMatchObject({
      status: "paused",
      findings: [{ id: "F1", filing: "pending" }],
    });
    fake.state.unavailable = true;
    expect(await run()).toMatchObject({
      status: "paused",
      findings: [{ id: "F1", filing: "pending" }],
    });
    fake.state.unavailable = false;
    expect(await run()).toMatchObject({
      status: "completed",
      findings: [{ id: "F1", filing: "linked", link: { id: "20" } }],
    });
    expect(fake.state.writes).toBe(1);
    expect(agentCalls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
