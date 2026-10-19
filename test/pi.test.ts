import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { createPiRunner, PiResults } from "../src/runners/pi.ts";
import { type RunnerResult, resultSchema } from "../src/runners/types.ts";

test("Pi runs an owned conversation and requires a schema-backed submission", async () => {
  const models = createModels(),
    faux = fauxProvider({ models: [{ id: "fixture" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_result", { outcome: "pass", summary: "planned" }),
      { stopReason: "toolUse" },
    ),
  ]);
  let harness: Harness;
  const Task = defineTask<
    Record<string, never>,
    { phase: "run" },
    RunnerResult
  >({
    name: "test.pi",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const result = await createPiRunner(harness, task.id, "plan", {
          provider: "faux",
          model: "fixture",
        }).run({
          prompt: "plan the ticket",
          role: "planner",
          cwd: process.cwd(),
          model: { tier: "standard", effort: "medium" },
          tools: ["read"],
          timeoutMs: 2000,
          resultSchema,
          signal: runtime.signal,
          onEvent: () => {},
        });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const registry = createRegistry();
  registry.install(PiResults);
  registry.install(defineExtension({ name: "test", tasks: [Task] }));
  harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx);
    const id = await root.commit(
      (tx) => tx.createTask(Task, {}, { ownership: { kind: "conversation" } }),
      ctx,
    );
    expect((await harness.waitForTask(id, ctx)).state).toMatchObject({
      outcome: {
        result: {
          status: "done",
          result: { outcome: "pass", summary: "planned" },
        },
      },
    });
    faux.setResponses([fauxAssistantMessage("I forgot the tool")]);
    const missing = await root.commit(
      (tx) => tx.createTask(Task, {}, { ownership: { kind: "conversation" } }),
      ctx,
    );
    expect((await harness.waitForTask(missing, ctx)).state).toMatchObject({
      outcome: { result: { status: "failed" } },
    });
  } finally {
    await harness.close(ctx);
  }
});
