import { parse } from "yaml";

export type Step =
  | { id: string; kind: "agent"; runner: "pi" | "shell"; role: string }
  | { id: string; kind: "mr" | "ci" | "merge" };
export type Workflow = {
  version: 1;
  runners: {
    pi: { provider: string; model: string };
    shell: { command: string };
  };
  steps: Step[];
};

// This first slice deliberately rejects language it cannot execute.
export function resolveWorkflow(source: string): Workflow {
  const value = parse(source);
  if (!value || value.version !== 1 || !Array.isArray(value.steps))
    throw new Error("workflow: expected version 1 and steps");
  for (const key of Object.keys(value))
    if (!["version", "runners", "steps"].includes(key))
      throw new Error(`workflow: unsupported ${key}`);
  if (
    typeof value.runners?.pi?.provider !== "string" ||
    !value.runners.pi.provider ||
    typeof value.runners.pi.model !== "string" ||
    !value.runners.pi.model ||
    typeof value.runners?.shell?.command !== "string" ||
    !value.runners.shell.command
  )
    throw new Error("workflow: configure pi provider/model and shell command");
  const ids = new Set<string>();
  const kinds: string[] = [];
  for (const [index, step] of value.steps.entries()) {
    if (
      !step ||
      typeof step.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(step.id) ||
      ids.has(step.id)
    )
      throw new Error(`steps[${index}]: invalid or duplicate id`);
    if (["ticket", "assign", "pickup", "retire"].includes(step.id))
      throw new Error(`steps[${index}]: reserved id ${step.id}`);
    ids.add(step.id);
    for (const key of Object.keys(step))
      if (!["id", "kind", "runner", "role"].includes(key))
        throw new Error(`steps[${index}]: unsupported ${key}`);
    if (!["agent", "mr", "ci", "merge"].includes(step.kind))
      throw new Error(`steps[${index}]: unknown kind ${step.kind}`);
    if (
      step.kind === "agent" &&
      (!["pi", "shell"].includes(step.runner) ||
        typeof step.role !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(step.role))
    )
      throw new Error(`steps[${index}]: unknown runner or role ${step.runner}`);
    if (step.kind !== "agent" && (step.runner || step.role))
      throw new Error(`steps[${index}]: only agents have runners/roles`);
    kinds.push(step.kind);
  }
  if (
    kinds.slice(-3).join(",") !== "mr,ci,merge" ||
    kinds.slice(0, -3).some((k) => k !== "agent") ||
    kinds.length < 4
  )
    throw new Error("workflow: agent steps must precede mr, ci, merge");
  return value as Workflow;
}
