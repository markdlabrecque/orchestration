// Run in a separate process so SIGKILL tests actual persisted recovery.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runWorkflow } from "../../src/engine.ts";
import type { Tracker } from "../../src/tracker/types.ts";
import { resolveWorkflow } from "../../src/workflow.ts";

const [dir, mode] = process.argv.slice(2);
const workflow = resolveWorkflow(
  await readFile(new URL("./slice-workflow.yaml", import.meta.url), "utf8"),
);
workflow.runners.pi = { provider: "faux", model: "fixture" };
workflow.runners.shell.command = `if [ ! -f dirty ]; then printf saved > dirty; printf crash-shell; else test "$(cat dirty)" = saved || exit 1; fi; printf '{"outcome":"pass","summary":"implemented"}' > "$ORCH_RESULT_FILE"`;
const models = createModels(),
  faux = fauxProvider({ models: [{ id: "fixture" }] });
models.setProvider(faux.provider);
faux.setResponses([
  (context) => {
    appendFileSync(join(dir, "model-calls"), "request\n");
    if (
      mode === "pi-mid" &&
      !context.messages.some(
        (m) => m.role === "toolResult" && m.toolName === "read",
      )
    ) {
      writeFileSync(join(dir, "plan-input"), "retained conversation input");
      return fauxAssistantMessage(
        fauxToolCall("read", { path: join(dir, "plan-input") }),
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      fauxToolCall("submit_result", { outcome: "pass", summary: "planned" }),
      { stopReason: "toolUse" },
    );
  },
]);
let merged = false;
const tracker: Tracker = {
  readTicket: async () => ({
    id: "139",
    url: "ticket",
    title: "Change",
    body: "Implement it",
  }),
  assign: async () => {},
  comment: async () => ({ id: "1", url: "comment" }),
  abort: async () => {},
  followUp: async () => ({ id: "2", url: "ticket" }),
  pullRequest: async () => ({ id: "3", url: "pr" }),
  readPullRequest: async () => ({ id: "3", url: "pr", head: "abc", merged }),
  ci: async () => "passed",
  merge: async () => {
    merged = true;
  },
};
const state = await runWorkflow({
  workflow,
  models,
  storage: await openNodeSqliteStorage(join(dir, "run.sqlite")),
  tracker,
  project: {
    root: dir,
    repo: "a/b",
    main: dir,
    base: "main",
    worktree: dir,
    runs: dir,
    ticket: "139",
    pickup: async () => {
      appendFileSync(join(dir, "pickups"), "pickup\n");
    },
    publish: async () => "abc",
    retire: async () => {},
  },
  role: async () => "Do work",
  onEvent: (event) => {
    if (existsSync(join(dir, "crashed"))) return;
    const piEnd =
      event.type === "tool" &&
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === "tool_execution_end";
    if (
      (["pi", "pi-mid"].includes(mode) && piEnd) ||
      (mode === "shell" && event.data === "crash-shell")
    ) {
      writeFileSync(join(dir, "crashed"), "yes");
      process.kill(process.pid, "SIGKILL");
    }
  },
});
writeFileSync(join(dir, "result.json"), JSON.stringify(state));
