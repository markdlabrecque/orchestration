// Separate process: SIGKILL proves recovery uses SQLite, not in-memory closures.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { exec } from "../../src/command.ts";
import { runWorkflow } from "../../src/engine.ts";
import { createGitHubTracker } from "../../src/tracker/github.ts";
import { resolveWorkflow } from "../../src/workflow.ts";

const [dir, mode] = process.argv.slice(2);
const cwd = join(dir, "worktree");
const crash = () => {
  if (!existsSync(join(dir, "crashed"))) {
    writeFileSync(join(dir, "crashed"), "yes");
    process.kill(process.pid, "SIGKILL");
  }
};
const command = `node ${JSON.stringify(join(dir, "agent.mjs"))}`;
const workflow = resolveWorkflow(`version: 1
runners:
  shell: { command: ${JSON.stringify(command)} }
  pi: { provider: faux, model: fixture }
budgets: { bounces: { max: 3 } }
repairs:
  fix: { id: fix, kind: agent, runner: ${mode === "pi" ? "pi" : "shell"}, role: implementor, tools: [read, edit] }
steps:
  - { id: review, kind: agent, runner: shell, role: reviewer, on: { findings: { repair: fix, budget: bounces } } }`);
const models = createModels();
const provider = fauxProvider({ models: [{ id: "fixture" }] });
models.setProvider(provider.provider);
provider.setResponses([
  (context) => {
    appendFileSync(join(dir, "model-calls"), "request\n");
    if (
      !context.messages.some(
        (m) => m.role === "toolResult" && m.toolName === "write",
      )
    )
      return fauxAssistantMessage(
        fauxToolCall("write", { path: join(cwd, "item"), content: "fixed\n" }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage(
      fauxToolCall("submit_result", {
        outcome: "pass",
        summary: "fixed",
        responses: [{ id: "F1", action: "changed", reason: "wrote fixed" }],
      }),
      { stopReason: "toolUse" },
    );
  },
]);
const github = createGitHubTracker("a/b", cwd, async (request) => {
  const remote = join(dir, "remote.json");
  if (request.argv.includes("POST")) {
    appendFileSync(join(dir, "writes"), "write\n");
    const { body } = JSON.parse(request.input ?? "{}");
    writeFileSync(
      remote,
      JSON.stringify({
        number: 99,
        html_url: "https://github.com/a/b/issues/99",
        body,
      }),
    );
    crash();
  }
  return {
    status: "done",
    code: 0,
    stderr: "",
    stdout: JSON.stringify([
      [],
      existsSync(remote) ? [JSON.parse(readFileSync(remote, "utf8"))] : [],
    ]),
  };
});
const state = await runWorkflow({
  workflow,
  models,
  storage: await openNodeSqliteStorage(join(dir, "run.sqlite")),
  role: async (name) => name,
  execute: async (request) =>
    request.argv[0] === "gh"
      ? { status: "done", code: 0, stdout: "", stderr: "" }
      : exec(request),
  project: {
    root: dir,
    repo: "a/b",
    main: cwd,
    worktree: cwd,
    runs: dir,
    base: "main",
    ticket: "142",
    pickup: async () => {},
    publish: async () => "head",
    retire: async () => {},
  },
  tracker: {
    ...github,
    readTicket: async () => ({
      id: "142",
      url: "ticket",
      title: "Repair",
      body: "",
    }),
    assign: async () => {},
  },
  onEvent: (event) => {
    if (
      mode === "shell" &&
      event.type === "text" &&
      String(event.data).includes("ready-to-crash")
    )
      crash();
    if (
      mode === "pi" &&
      event.type === "tool" &&
      typeof event.data === "object" &&
      event.data &&
      "type" in event.data &&
      event.data.type === "tool_execution_end"
    )
      crash();
  },
});
writeFileSync(join(dir, "result.json"), JSON.stringify(state));
