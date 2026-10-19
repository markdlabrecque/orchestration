import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { checked, type Exec, exec } from "./command.ts";
import type { Project } from "./engine.ts";
import { createRegistrations, type Registrations } from "./registration.ts";
import { piModel, tiers } from "./runners/model.ts";
import {
  matchesWhen,
  type Step,
  validateWorkflow,
  type Workflow,
} from "./workflow.ts";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Include every possible lane, and only repairs reachable from selected steps. */
export function relevantSteps(workflow: Workflow): Step[] {
  const selected: Step[] = [];
  const visited = new Set<string>();
  const visit = (step: Step) => {
    if (
      !["standard", "trivial", "no-code"].some((lane) =>
        matchesWhen(step.when, workflow.settings, lane),
      )
    )
      return;
    selected.push(step);
    for (const edge of Object.values(step.on ?? {})) {
      if (visited.has(edge.repair)) continue;
      visited.add(edge.repair);
      const repair = workflow.repairs[edge.repair];
      for (const child of Array.isArray(repair) ? repair : [repair])
        visit(child);
    }
  };
  workflow.steps.forEach(visit);
  return selected;
}
export async function preflight(options: {
  workflow: Workflow;
  project: Project;
  models: Models;
  role(name: string): Promise<string>;
  registrations?: Registrations;
  execute?: Exec;
}) {
  const { workflow, project, models } = options;
  const registrations = options.registrations ?? createRegistrations();
  const execute = options.execute ?? exec;
  validateWorkflow(workflow, registrations);
  if (!project.base?.trim()) throw new Error("Missing BASE_BRANCH in .orch");
  const steps = relevantSteps(workflow);
  const runners = new Set(
    steps.filter((s) => s.kind === "agent").map((s) => s.runner ?? ""),
  );
  for (const step of steps) {
    for (const name of registrations.kinds.get(step.kind)?.runners ?? [])
      runners.add(name);
    if (step.kind === "agent") {
      const name = String(step.options?.role ?? step.role);
      try {
        await options.role(name);
      } catch (error) {
        throw new Error(
          `step ${step.id}: missing role ${name}: ${String(error)}`,
        );
      }
    }
  }
  for (const name of runners) {
    const config = workflow.runners[name];
    const usedTiers = new Set(
      steps
        .filter((s) => s.runner === name)
        .flatMap((s) =>
          (s.options?.role ?? s.role) === "implementor"
            ? tiers
            : [s.model?.tier ?? "standard"],
        ),
    );
    if (
      steps.some((s) =>
        registrations.kinds.get(s.kind)?.runners?.includes(name),
      )
    )
      for (const tier of tiers) usedTiers.add(tier);
    if (name === "pi") {
      for (const tier of usedTiers) {
        const model = piModel(config, tier);
        if (!models.getModel(model.provider, model.model))
          throw new Error("runners.pi: configured Pi model is unavailable");
      }
    } else if (name === "shell") {
      if (typeof config?.command !== "string" || !config.command.trim())
        throw new Error("runners.shell: missing command");
      if (config.models !== undefined) {
        const mappings = config.models;
        if (
          !mappings ||
          typeof mappings !== "object" ||
          Array.isArray(mappings)
        )
          throw new Error("runners.shell: invalid model tier mappings");
        for (const tier of usedTiers)
          if (typeof mappings[tier] !== "string" || !mappings[tier].trim())
            throw new Error(`runners.shell: missing model tier ${tier}`);
      }
      await checked(execute, {
        cwd: project.main,
        argv: ["bash", "-n", "-c", config.command],
      });
      // Syntax validation must not run an agent. Check a simple leading executable
      // separately; shell compound commands are validated by bash above.
      const first = config.command.match(/^\s*([\w./-]+)(?:\s|$)/)?.[1];
      if (
        first &&
        !["if", "for", "while", "until", "case", "function"].includes(first)
      ) {
        await checked(execute, {
          cwd: project.main,
          argv: ["bash", "-c", 'command -v -- "$1"', "orch-preflight", first],
        });
      }
    } else {
      const definition = registrations.runners.get(name);
      if (!definition) throw new Error(`unknown runner ${name}`);
      await definition.preflight?.(config ?? {}, {
        cwd: project.main,
        exec: execute,
      });
      const runner = definition.create(config ?? {});
      if (
        typeof runner?.run !== "function" ||
        runner.resumable !== definition.resumable
      )
        throw new Error(`runners.${name}: cannot start registered runner`);
    }
  }
  const forge = workflow.settings.forge ?? project.forge;
  if (forge !== undefined && forge !== "github" && forge !== "gitlab")
    throw new Error("settings.forge: expected github or gitlab");
  if (forge)
    await checked(execute, {
      cwd: project.main,
      argv: [forge === "github" ? "gh" : "glab", "--version"],
    });
  if (
    steps.some((step) => step.options?.verification === "ddev") ||
    (await exists(join(project.main, ".ddev"))) ||
    (await exists(join(project.main, "composer.json")))
  )
    await checked(execute, { cwd: project.main, argv: ["ddev", "--version"] });
}
