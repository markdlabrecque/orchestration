import type { Exec } from "./command.ts";
import type {
  Runner,
  RunnerEvent,
  RunnerRequest,
  RunnerResult,
} from "./runners/types.ts";
import type { Step } from "./workflow.ts";

export type StepHelpers = {
  cwd: string;
  signal: AbortSignal;
  exec: Exec;
  onEvent(event: RunnerEvent): void;
  runAgent(name: string, request: RunnerRequest): Promise<RunnerResult>;
};
export type StepKind = {
  type: "kind";
  name: string;
  /** The first declared outcome advances the workflow. */
  outcomes: string[];
  /** Runner names this kind may call, so preflight can check them before pickup. */
  runners?: string[];
  run(
    step: Step,
    helpers: StepHelpers,
  ): Promise<{ outcome: string; handoff?: string }>;
};
export type RunnerDefinition = {
  type: "runner";
  name: string;
  resumable: boolean;
  tools: string[];
  create(config: Record<string, unknown>): Runner;
  preflight?(
    config: Record<string, unknown>,
    context: { cwd: string; exec: Exec },
  ): Promise<void>;
};
export function defineStepKind(definition: Omit<StepKind, "type">): StepKind {
  return { ...definition, type: "kind" };
}
export function defineRunner(
  definition: Omit<RunnerDefinition, "type">,
): RunnerDefinition {
  return { ...definition, type: "runner" };
}
export const builtinOutcomes: Record<string, string[]> = {
  agent: ["pass", "findings", "failed"],
  shell: ["pass", "failed"],
  human: ["pass", "declined"],
  mr: ["pass", "failed"],
  ci: ["passed", "failed", "timeout"],
  merge: ["merged", "conflict"],
};
export type Registrations = {
  kinds: Map<string, StepKind>;
  runners: Map<string, RunnerDefinition>;
};
export function createRegistrations(
  definitions: (StepKind | RunnerDefinition)[] = [],
): Registrations {
  const registrations: Registrations = { kinds: new Map(), runners: new Map() };
  for (const definition of definitions) register(registrations, definition);
  return registrations;
}
export function register(
  registrations: Registrations,
  definition: StepKind | RunnerDefinition,
): void {
  if (!definition || !/^[a-z][a-z0-9-]*$/.test(definition.name))
    throw new Error("registration needs a name");
  if (definition.type === "kind") {
    if (
      Object.hasOwn(builtinOutcomes, definition.name) ||
      registrations.kinds.has(definition.name)
    )
      throw new Error(`duplicate kind ${definition.name}`);
    if (
      !Array.isArray(definition.outcomes) ||
      !definition.outcomes.length ||
      definition.outcomes.some((s) => typeof s !== "string" || !s) ||
      new Set(definition.outcomes).size !== definition.outcomes.length ||
      typeof definition.run !== "function"
    )
      throw new Error(`invalid kind ${definition.name}`);
    registrations.kinds.set(definition.name, definition);
  } else if (definition.type === "runner") {
    if (
      ["pi", "shell"].includes(definition.name) ||
      registrations.runners.has(definition.name)
    )
      throw new Error(`duplicate runner ${definition.name}`);
    if (
      typeof definition.resumable !== "boolean" ||
      !Array.isArray(definition.tools) ||
      typeof definition.create !== "function"
    )
      throw new Error(`invalid runner ${definition.name}`);
    registrations.runners.set(definition.name, definition);
  } else
    throw new Error(
      "module must default-export defineRunner or defineStepKind",
    );
}
