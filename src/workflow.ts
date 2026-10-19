import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveModule } from "import-meta-resolve";
import { parse } from "yaml";
import {
  builtinOutcomes,
  createRegistrations,
  type Registrations,
  register,
} from "./registration.ts";

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Step = {
  id: string;
  kind: string;
  runner?: string;
  role?: string;
  options?: Record<string, JsonValue>;
  when?: string | string[];
  gate?: string;
  on?: Record<string, { repair: string; budget: string }>;
  session?: string;
  tools?: string[];
  timeoutMs?: number;
  model?: {
    tier: string;
    effort: import("@earendil-works/pi-ai").ModelThinkingLevel;
  };
};
export type Workflow = {
  version: 1;
  settings: Record<string, JsonValue>;
  runners: Record<string, Record<string, JsonValue>>;
  budgets: Record<string, { max: number }>;
  repairs: Record<string, Step | Step[]>;
  steps: Step[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// RFC 7396: arrays replace, objects merge, and null removes a member.
function merge(target: unknown, patch: unknown): unknown {
  if (!object(patch)) return structuredClone(patch);
  const result = object(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}
function settingsIn(
  value: unknown,
  settings: Record<string, JsonValue>,
): unknown {
  if (typeof value === "string" && value.startsWith("$settings.")) {
    const key = value.slice(10);
    if (!Object.hasOwn(settings, key) || settings[key] === null)
      throw new Error(`missing setting ${key}`);
    return structuredClone(settings[key]);
  }
  if (Array.isArray(value)) return value.map((v) => settingsIn(v, settings));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, settingsIn(v, settings)]),
    );
  return value;
}
export function matchesWhen(
  when: Step["when"],
  settings: Workflow["settings"],
  lane = "standard",
): boolean {
  return (Array.isArray(when) ? when : when !== undefined ? [when] : [])
    .map((condition) => {
      if (typeof condition !== "string") throw new Error("invalid condition");
      const match = condition
        .trim()
        .match(/^(lane|(?:\$?settings\.)[\w-]+)\s+(==|!=|not in|in)\s+(.+)$/);
      if (!match) throw new Error(`invalid condition ${condition}`);
      const [, name, op, text] = match;
      const key = name.replace(/^\$?settings\./, "");
      if (
        name !== "lane" &&
        (!Object.hasOwn(settings, key) || settings[key] === null)
      )
        throw new Error(`missing setting ${key}`);
      const actual = name === "lane" ? lane : settings[key];
      const expected = parse(text);
      if (op.includes("in") && !Array.isArray(expected))
        throw new Error(`invalid condition ${condition}`);
      if ((!op.includes("in") && Array.isArray(expected)) || object(expected))
        throw new Error(`invalid condition ${condition}`);
      const equal = Array.isArray(expected)
        ? expected.includes(actual)
        : actual === expected;
      return op === "!=" || op === "not in" ? !equal : equal;
    })
    .every(Boolean);
}
export function resolveWorkflow(
  source: string,
  patchSource?: string,
  options: { registrations?: Registrations } = {},
): Workflow {
  const registrations = options.registrations ?? createRegistrations();
  const global = parse(source);
  if (!object(global) || global.version !== 1 || !Array.isArray(global.steps))
    throw new Error("workflow: expected version 1 and steps");
  checkSections(global, "global");
  const value = {
    settings: {},
    runners: {},
    budgets: {},
    repairs: {},
    ...global,
  } as Workflow;
  if (patchSource !== undefined) {
    const patch = parse(patchSource);
    if (
      !object(patch) ||
      patch.version !== 1 ||
      (patch.patch !== undefined && !Array.isArray(patch.patch))
    )
      throw new Error("project: expected version 1 and patch");
    checkSections(patch, "project");
    for (const section of [
      "settings",
      "runners",
      "budgets",
      "repairs",
    ] as const) {
      if (patch[section]) {
        const entries = { ...value[section] };
        for (const [key, entry] of Object.entries(
          patch[section] as Record<string, unknown>,
        )) {
          if (entry === null) delete entries[key];
          else entries[key] = structuredClone(entry) as never;
        }
        value[section] = entries as never;
      }
    }
    for (const [index, op] of (patch.patch ?? []).entries()) {
      const where = `project.patch[${index}]`;
      if (!object(op)) throw new Error(`${where}: expected operation object`);
      const operations = [
        "insert_before",
        "insert_after",
        "drop",
        "replace",
        "set",
        "move",
      ].filter((key) => Object.hasOwn(op, key));
      if (operations.length !== 1)
        throw new Error(`${where}: expected exactly one operation`);
      const operation = operations[0];
      const allowed = [
        operation,
        ...(operation === "set"
          ? ["with"]
          : operation === "move"
            ? ["before", "after"]
            : operation === "drop"
              ? []
              : ["step"]),
      ];
      for (const key of Object.keys(op))
        if (!allowed.includes(key))
          throw new Error(`${where}: unsupported ${key}`);
      const find = (id: unknown) => {
        const i = value.steps.findIndex((s) => s.id === id);
        if (i < 0) throw new Error(`${where}: missing step ${id}`);
        return i;
      };
      const target = find(op[operation]);
      if (operation === "set") {
        if (!object(op.with) || Object.hasOwn(op.with, "id"))
          throw new Error(`${where}: set requires with and cannot change id`);
        value.steps[target] = merge(value.steps[target], op.with) as Step;
      } else if (operation === "drop") value.steps.splice(target, 1);
      else if (operation === "move") {
        if (Object.hasOwn(op, "before") === Object.hasOwn(op, "after"))
          throw new Error(
            `${where}: move requires exactly one of before/after`,
          );
        const [moved] = value.steps.splice(target, 1);
        const anchor = find(op.before ?? op.after);
        value.steps.splice(anchor + (op.after ? 1 : 0), 0, moved);
      } else {
        if (!object(op.step) || typeof op.step.id !== "string")
          throw new Error(`${where}: step needs id`);
        if (
          value.steps.some(
            (s, i) =>
              s.id === (op.step as Step).id &&
              !(operation === "replace" && i === target),
          )
        )
          throw new Error(`${where}: duplicate id ${op.step.id}`);
        if (operation === "replace")
          value.steps.splice(target, 1, op.step as Step);
        else
          value.steps.splice(
            target + (operation === "insert_after" ? 1 : 0),
            0,
            op.step as Step,
          );
      }
    }
  }
  for (const [name, repair] of Object.entries(value.repairs)) {
    const steps = Array.isArray(repair) ? repair : [repair];
    for (const [index, step] of steps.entries()) {
      if (object(step) && step.id === undefined)
        step.id = steps.length === 1 ? name : `${name}-${index}`;
    }
  }
  for (const { step, location } of workflowSteps(value)) {
    try {
      step.options = settingsIn(step.options ?? {}, value.settings) as Record<
        string,
        JsonValue
      >;
    } catch (error) {
      throw new Error(`${location}: ${String(error)}`);
    }
  }
  validateWorkflow(value, registrations);
  return value;
}

/** Load modules only from explicit uses entries, relative to their declaring file. */
export async function loadWorkflow(globalPath: string, projectPath?: string) {
  const registrations = createRegistrations();
  const sources: string[] = [];
  for (const file of [globalPath, projectPath]) {
    if (!file) continue;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (
        file === projectPath &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw new Error(`${file}: ${String(error)}`);
    }
    let document: unknown;
    try {
      document = parse(source);
    } catch (error) {
      throw new Error(`${file}: ${String(error)}`);
    }
    if (!object(document)) throw new Error(`${file}: expected workflow object`);
    if (
      document.uses !== undefined &&
      (!Array.isArray(document.uses) ||
        document.uses.some((s: unknown) => typeof s !== "string"))
    )
      throw new Error(`${file}: uses must be a list of module paths`);
    for (const [index, specifier] of (
      (document.uses ?? []) as string[]
    ).entries()) {
      try {
        const url = resolveModule(specifier, pathToFileURL(resolve(file)).href);
        const module = await import(url);
        register(registrations, module.default);
      } catch (error) {
        throw new Error(`${file}: uses[${index}]: ${String(error)}`);
      }
    }
    sources.push(source);
  }
  try {
    return {
      workflow: resolveWorkflow(sources[0], sources[1], { registrations }),
      registrations,
      globalSource: sources[0],
      patchSource: sources[1],
    };
  } catch (error) {
    throw new Error(
      `${globalPath}${projectPath ? ` + ${projectPath}` : ""}: ${String(error)}`,
    );
  }
}

function checkSections(
  document: Record<string, unknown>,
  layer: "global" | "project",
) {
  const allowed = [
    "version",
    "uses",
    "settings",
    "runners",
    "budgets",
    "repairs",
    layer === "global" ? "steps" : "patch",
  ];
  for (const key of Object.keys(document))
    if (!allowed.includes(key)) throw new Error(`${layer}: unsupported ${key}`);
  if (
    document.uses !== undefined &&
    (!Array.isArray(document.uses) ||
      document.uses.some((s) => typeof s !== "string" || !s))
  )
    throw new Error(`${layer}.uses: expected module paths`);
  for (const key of ["settings", "runners", "budgets", "repairs"])
    if (document[key] !== undefined && !object(document[key]))
      throw new Error(`${layer}.${key}: expected named entries`);
}
export function workflowSteps(
  workflow: Workflow,
): { step: Step; location: string }[] {
  return [
    ...workflow.steps.map((step, i) => ({ step, location: `steps[${i}]` })),
    ...Object.entries(workflow.repairs).flatMap(([name, repair]) =>
      (Array.isArray(repair) ? repair : [repair]).map((step, i) => ({
        step,
        location: `repairs.${name}[${i}]`,
      })),
    ),
  ];
}
export function unusedRepairs(workflow: Workflow): string[] {
  const used = new Set(
    workflowSteps(workflow).flatMap(({ step }) =>
      Object.values(step.on ?? {}).map((edge) => edge.repair),
    ),
  );
  return Object.keys(workflow.repairs).filter((name) => !used.has(name));
}
export function validateWorkflow(
  workflow: Workflow,
  registrations: Registrations = createRegistrations(),
): void {
  for (const [name, budget] of Object.entries(workflow.budgets))
    if (!object(budget) || !Number.isInteger(budget.max) || budget.max < 0)
      throw new Error(`budgets.${name}: max must be a nonnegative integer`);
  for (const [name, repair] of Object.entries(workflow.repairs))
    if (Array.isArray(repair) && !repair.length)
      throw new Error(`repairs.${name}: needs at least one step`);
  const ids = new Set<string>();
  const all = workflowSteps(workflow);
  for (const [index, { step, location }] of all.entries()) {
    try {
      if (
        !object(step) ||
        typeof step.id !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(step.id)
      )
        throw new Error("invalid id");
      if (ids.has(step.id)) throw new Error(`duplicate id ${step.id}`);
      ids.add(step.id);
      if (["ticket", "assign", "pickup", "retire"].includes(step.id))
        throw new Error(`reserved id ${step.id}`);
      for (const key of Object.keys(step))
        if (
          ![
            "id",
            "kind",
            "runner",
            "role",
            "options",
            "when",
            "gate",
            "on",
            "session",
            "tools",
            "timeoutMs",
            "model",
          ].includes(key)
        )
          throw new Error(`unsupported ${key}`);
      const outcomes =
        registrations.kinds.get(step.kind)?.outcomes ??
        (Object.hasOwn(builtinOutcomes, step.kind)
          ? builtinOutcomes[step.kind]
          : undefined);
      if (!outcomes) throw new Error(`unknown kind ${step.kind}`);
      if (
        step.kind !== "agent" &&
        (step.runner !== undefined ||
          step.role !== undefined ||
          step.session !== undefined ||
          step.tools !== undefined ||
          step.model !== undefined ||
          step.timeoutMs !== undefined)
      )
        throw new Error(
          "only agent steps name runner/role/session/tools/model/timeoutMs",
        );
      if (step.options !== undefined && !object(step.options))
        throw new Error("options must be an object");
      if (step.kind === "agent") {
        const runner = step.runner ?? "";
        if (
          !["pi", "shell"].includes(runner) &&
          !registrations.runners.has(runner)
        )
          throw new Error(`unknown runner ${runner}`);
        const role = step.options?.role ?? step.role;
        if (typeof role !== "string" || !/^[a-z][a-z0-9-]*$/.test(role))
          throw new Error("missing or invalid role");
        if (
          role === "verifier" &&
          !["local-tests", "ddev", "docker"].includes(
            String(step.options?.verification),
          )
        )
          throw new Error(
            "verifier needs options.verification: local-tests, ddev or docker",
          );
        if (
          step.role !== undefined &&
          step.options?.role !== undefined &&
          step.role !== step.options.role
        )
          throw new Error("conflicting role and options.role");
        if (
          step.timeoutMs !== undefined &&
          (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)
        )
          throw new Error("invalid timeoutMs");
        if (
          step.model !== undefined &&
          (!object(step.model) ||
            !["light", "standard", "heavy", "frontier"].includes(
              step.model.tier,
            ) ||
            !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
              step.model.effort,
            ))
        )
          throw new Error("invalid model tier/effort");
        if (
          step.tools !== undefined &&
          (!Array.isArray(step.tools) ||
            step.tools.some(
              (tool) =>
                typeof tool !== "string" ||
                !/^(read|edit|shell|web|mcp:[\w-]+)$/.test(tool),
            ))
        )
          throw new Error("invalid tools");
        const supported =
          runner === "pi"
            ? ["read", "edit", "shell"]
            : registrations.runners.get(runner)?.tools;
        if (supported && step.tools?.some((t) => !supported.includes(t)))
          throw new Error(`runner ${runner}: unsupported tool permission`);
        if (step.session !== undefined) {
          const previous = all
            .slice(0, index)
            .find(({ step: prior }) => prior.id === step.session)?.step;
          if (
            !previous ||
            previous.kind !== "agent" ||
            previous.runner !== runner ||
            runner === "shell" ||
            (runner !== "pi" && !registrations.runners.get(runner)?.resumable)
          )
            throw new Error(
              `invalid session ${step.session}: needs previous agent on same session-capable runner`,
            );
        }
      }
      if (
        step.kind === "shell" &&
        (typeof step.options?.command !== "string" ||
          !step.options.command.trim())
      )
        throw new Error("shell needs options.command");
      if (
        step.kind === "human" &&
        (typeof step.options?.ask !== "string" ||
          !Array.isArray(step.options.choices) ||
          step.options.choices.length < 1 ||
          step.options.choices.some((c) => typeof c !== "string" || !c) ||
          new Set(step.options.choices).size !== step.options.choices.length ||
          step.options.choices.slice(1).includes("pass"))
      )
        throw new Error("human needs options.ask and choices");
      if (
        step.kind === "merge" &&
        !workflow.steps.slice(0, index).some((s) => s.kind === "ci")
      )
        throw new Error("merge requires preceding ci");
      matchesWhen(step.when, workflow.settings);
      if (step.gate !== undefined) {
        if (
          !["tests-red", "tests-green", "ci-green-on-head"].includes(step.gate)
        )
          throw new Error(`unknown gate ${step.gate}`);
        if (
          step.gate.startsWith("tests-") &&
          (typeof workflow.settings.tests !== "string" ||
            !workflow.settings.tests.trim())
        )
          throw new Error("test gate requires settings.tests");
      }
      if (step.on !== undefined && !object(step.on))
        throw new Error("on must map outcomes");
      for (const [outcome, edge] of Object.entries(step.on ?? {})) {
        const declared =
          step.kind === "human"
            ? ["pass", ...(step.options?.choices as string[]).slice(1)]
            : outcomes;
        if (!declared.includes(outcome))
          throw new Error(`invalid outcome ${outcome}`);
        if (
          !object(edge) ||
          typeof edge.repair !== "string" ||
          !Object.hasOwn(workflow.repairs, edge.repair)
        )
          throw new Error(`unknown repair ${edge?.repair}`);
        if (
          typeof edge.budget !== "string" ||
          !Object.hasOwn(workflow.budgets, edge.budget)
        )
          throw new Error(`unknown budget ${edge.budget}`);
        if (Object.keys(edge).some((k) => !["repair", "budget"].includes(k)))
          throw new Error(`invalid outcome mapping ${outcome}`);
      }
    } catch (error) {
      throw new Error(`${location}: ${String(error)}`);
    }
  }
}
