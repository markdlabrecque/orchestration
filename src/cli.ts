import { appendFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { checked, type Exec, exec } from "./command.ts";
import { runWorkflow } from "./engine.ts";
import {
  discoverProject,
  packageRoot,
  prepareRunDirectory,
} from "./project.ts";
import type { RunnerEvent } from "./runners/types.ts";
import { createGitHubTracker } from "./tracker/github.ts";
import { resolveWorkflow } from "./workflow.ts";

export type CliOptions = {
  cwd?: string;
  execute?: Exec;
  models?: Models;
  workflowPath?: string;
  signal?: AbortSignal;
  output?: (text: string) => void;
  onEvent?: (event: RunnerEvent) => void;
};
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const output = options.output ?? console.log,
    cwd = options.cwd ?? process.cwd(),
    execute = options.execute ?? exec;
  if (argv.length === 0 || argv[0] === "--help") {
    output(
      "Usage: orch run <ticket> | orch validate | orch --version\nOne terminal per ticket. Ctrl-C or SIGHUP pauses; run the same command to resume.",
    );
    return 0;
  }
  if (argv[0] === "--version") {
    const pkg = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    output(
      `${pkg.version} ${await checked(execute, { cwd: packageRoot, argv: ["git", "rev-parse", "--short", "HEAD"] })}`,
    );
    return 0;
  }
  if (
    !["run", "validate"].includes(argv[0]) ||
    argv.length > (argv[0] === "run" ? 2 : 1)
  )
    throw new Error("Usage: orch run <ticket> | orch validate");
  const source = await readFile(
    options.workflowPath ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "orchestration/workflow.yaml",
      ),
    "utf8",
  );
  const workflow = resolveWorkflow(source);
  const project = await discoverProject(
    cwd,
    argv[0] === "validate" ? "1" : (argv[1] ?? ""),
    execute,
  );
  try {
    await access(join(project.main, ".orchestration/workflow.yaml"));
    throw new Error(
      "Project workflow patches are not implemented in this slice",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const step of workflow.steps)
    if (step.kind === "agent")
      await access(join(packageRoot, "roles", `${step.role}.md`));
  await checked(execute, { cwd, argv: ["gh", "--version"] });
  await checked(execute, {
    cwd,
    argv: ["bash", "-n", "-c", workflow.runners.shell.command],
  });
  const defaults = createModels();
  defaults.setProvider(openaiProvider());
  defaults.setProvider(anthropicProvider());
  const models = options.models ?? defaults;
  if (!models.getModel(workflow.runners.pi.provider, workflow.runners.pi.model))
    throw new Error("Configured Pi model is unavailable");
  if (argv[0] === "validate") {
    output("Workflow valid");
    return 0;
  }
  const file = await prepareRunDirectory(project);
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const pause = () => controller.abort();
  if (!options.signal) {
    process.once("SIGINT", pause);
    process.once("SIGHUP", pause);
  }
  try {
    const state = await runWorkflow({
      workflow,
      project,
      models,
      tracker: createGitHubTracker(project.repo, cwd, execute),
      storage: await openNodeSqliteStorage(file),
      signal,
      role: (name) =>
        readFile(join(packageRoot, "roles", `${name}.md`), "utf8"),
      onEvent: (event) => {
        appendFileSync(
          join(project.runs, `${project.ticket}.events.jsonl`),
          `${JSON.stringify(event)}\n`,
        );
        options.onEvent?.(event);
        if (
          event.type === "status" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "step" in event.data
        )
          output(`Step ${event.data.step}`);
        if (event.type === "tool") output("Agent tool call");
        if (event.type === "text" && typeof event.data === "string")
          output(event.data);
      },
    });
    output(`${state.status}${state.reason ? `: ${state.reason}` : ""}`);
    return state.status === "blocked" ? 1 : 0;
  } finally {
    if (!options.signal) {
      process.removeListener("SIGINT", pause);
      process.removeListener("SIGHUP", pause);
    }
  }
}
