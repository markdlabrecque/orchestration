import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { capabilitiesResponse } from "./capabilities.ts";
import { checked, type Exec, exec } from "./command.ts";
import { runWorkflow } from "./engine.ts";
import { explainHtml, explainText } from "./explain.ts";
import { observeRun, showRun, tailRun } from "./observability.ts";
import { preflight } from "./preflight.ts";
import {
  discoverProject,
  packageRoot,
  prepareRunDirectory,
} from "./project.ts";
import type { RunnerEvent } from "./runners/types.ts";
import { publishOwner, snapshotResponse } from "./snapshot.ts";
import { createTracker, selectForge } from "./tracker/index.ts";
import { loadWorkflow } from "./workflow.ts";
import { globalWorkflowPath, workflowConfig } from "./workflow-config.ts";

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
      "Usage: orch run <ticket> [--retry] | orch show <ticket> | orch tail <ticket> | orch abort <ticket> | orch retire <ticket> | orch validate | orch capabilities --json | orch snapshot <ticket> | orch explain [--simple] | orch workflow diff/reset [--force] | orch --version\nOne terminal per ticket. Ctrl-C, SIGHUP or SIGTERM pauses; run the same command to resume. Stop the run before abort or retire; these commands do not check liveness.",
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
  if (argv[0] === "capabilities") {
    const rest = argv.slice(1);
    const i = rest.indexOf("--owner-lifetime");
    const wanted = i >= 0 ? rest[i + 1] : undefined;
    if (!rest.includes("--json") || (i >= 0 && !wanted))
      throw new Error(
        "Usage: orch capabilities --json [--owner-lifetime <value>]",
      );
    output(JSON.stringify(capabilitiesResponse(wanted)));
    return 0;
  }
  if (argv[0] === "workflow")
    return workflowConfig(
      argv.slice(1),
      options.workflowPath ?? globalWorkflowPath(),
      execute,
      output,
    );
  if (argv[0] === "explain") {
    if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--simple"))
      throw new Error("Usage: orch explain [--simple]");
    const project = await discoverProject(cwd, "1", execute);
    const loaded = await loadWorkflow(
      options.workflowPath ?? globalWorkflowPath(),
      join(project.main, ".orchestration/workflow.yaml"),
    );
    if (argv[1] === "--simple") output(explainText(loaded));
    else {
      const file = join(project.root, ".agents/orchestration/explain.html");
      await mkdir(join(project.root, ".agents/orchestration"), {
        recursive: true,
      });
      await writeFile(file, explainHtml(loaded));
      output(file);
      await checked(execute, {
        cwd,
        argv: [process.platform === "darwin" ? "open" : "xdg-open", file],
      });
    }
    return 0;
  }
  const retry = argv.includes("--retry");
  if (retry) argv = argv.filter((a) => a !== "--retry");
  if (
    ![
      "run",
      "validate",
      "show",
      "snapshot",
      "tail",
      "abort",
      "retire",
    ].includes(argv[0]) ||
    (retry && argv[0] !== "run") ||
    argv.length !== (argv[0] === "validate" ? 1 : 2)
  )
    throw new Error(
      "Usage: orch run <ticket> [--retry] | orch show/tail/abort/retire <ticket> | orch validate",
    );
  const project = await discoverProject(
    cwd,
    argv[0] === "validate" ? "1" : (argv[1] ?? ""),
    execute,
  );
  if (argv[0] === "snapshot") {
    output(JSON.stringify(await snapshotResponse(project)));
    return 0;
  }
  if (argv[0] === "show") {
    await showRun(project, output);
    return 0;
  }
  if (argv[0] === "tail") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (!options.signal) {
      process.once("SIGINT", stop);
      process.once("SIGHUP", stop);
      process.once("SIGTERM", stop);
    }
    try {
      await tailRun(project, output, options.signal ?? controller.signal);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGHUP", stop);
      process.removeListener("SIGTERM", stop);
    }
    return 0;
  }
  const load = () =>
    loadWorkflow(
      options.workflowPath ?? globalWorkflowPath(),
      join(project.main, ".orchestration/workflow.yaml"),
    );
  const defaults = createModels();
  defaults.setProvider(openaiProvider());
  defaults.setProvider(anthropicProvider());
  const models = options.models ?? defaults;
  const role = (name: string) =>
    readFile(join(packageRoot, "roles", `${name}.md`), "utf8");
  if (argv[0] === "validate") {
    const { workflow, registrations } = await load();
    project.forge = selectForge(project, workflow.settings.forge);
    await preflight({
      workflow,
      registrations,
      project,
      models,
      role,
      execute,
    });
    output("Workflow valid");
    return 0;
  }
  if (argv[0] !== "run")
    await access(join(project.runs, `${project.ticket}.sqlite`));
  const file = await prepareRunDirectory(project);
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const pause = () => controller.abort();
  if (!options.signal) {
    process.once("SIGINT", pause);
    process.once("SIGHUP", pause);
    process.once("SIGTERM", pause);
  }
  const releaseOwner = options.signal ? undefined : await publishOwner(project);
  try {
    const observer = observeRun(project, output, options.onEvent);
    const state = await runWorkflow({
      // The engine reads final/control state before loading optional execution tools.
      workflow: {
        version: 1,
        settings: {},
        runners: {},
        budgets: {},
        repairs: {},
        steps: [],
      },
      prepare: async (saved, control) => {
        const loaded =
          control && saved
            ? { workflow: saved, registrations: undefined }
            : await load();
        if (!saved && "globalSource" in loaded)
          await writeFile(
            join(project.runs, `${project.ticket}.explain.html`),
            explainHtml(loaded),
          );
        project.forge = selectForge(project, loaded.workflow.settings.forge);
        return {
          ...loaded,
          tracker: createTracker(project, project.main, execute),
        };
      },
      execute,
      project,
      models,
      storage: await openNodeSqliteStorage(file),
      signal,
      role,
      command: argv[0] as "run" | "abort" | "retire",
      retry,
      onState: observer.state,
      onEvent: observer.event,
    });
    output(`${state.status}${state.reason ? `: ${state.reason}` : ""}`);
    return state.status === "blocked" ? 1 : 0;
  } finally {
    await releaseOwner?.();
    if (!options.signal) {
      process.removeListener("SIGINT", pause);
      process.removeListener("SIGHUP", pause);
      process.removeListener("SIGTERM", pause);
    }
  }
}
