// PROTOTYPE (#128), round 2: load the files, resolve each project, show the loader's errors,
// run the scripted walks. Run with: node check.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { createRegistry, resolve, start, reduce, whenText } from "#engine";
import { scenarios } from "./scenarios.js";

const here: string = import.meta.dirname;
const read = (rel: string): any => parse(readFileSync(join(here, rel), "utf8"));
const global = read("global/workflow.yaml");

async function registryFor(projectRoot: string, override: any) {
  const registry = createRegistry();
  for (const rel of override?.uses ?? []) {
    const mod = await import(pathToFileURL(resolvePath(projectRoot, rel)).href);
    registry.register(mod.default);
  }
  return registry;
}

function describe(workflow: any): string {
  const repairs = Object.entries<any>(workflow.repairs).map(([n, r]) => `${n} (${r.kind}${r.gate ? `, gate ${r.gate}` : ""})`).join(", ");
  const steps = workflow.steps
    .map((s: any) => {
      const bits = [s.id];
      if (s.kind !== "agent") bits.push(`<${s.kind}>`);
      if (s.when !== undefined) bits.push(`[when ${whenText(s.when)}]`);
      for (const [outcome, edge] of Object.entries<any>(s.on ?? {})) bits.push(`{${outcome} -> ${edge.repair} via ${edge.budget}}`);
      return bits.join(" ");
    })
    .join("\n    ");
  return `repairs: ${repairs}\n    ${steps}`;
}

let failures = 0;
const projects: Record<string, any> = { global: { workflow: null, registry: createRegistry() } };

console.log("== Effective workflows");
const globalResolved = resolve(global, undefined, projects.global.registry);
if (!globalResolved.ok) { console.log(`global: ERROR ${globalResolved.error}`); failures++; }
else { projects.global.workflow = globalResolved.workflow; console.log(`global:\n    ${describe(globalResolved.workflow)}`); }

for (const name of readdirSync(join(here, "projects"))) {
  const root = join(here, "projects", name);
  const override = read(`projects/${name}/.orchestration/workflow.yaml`);
  const registry = await registryFor(root, override);
  const result = resolve(global, override, registry);
  if (!result.ok) { console.log(`${name}: ERROR ${result.error}`); failures++; continue; }
  projects[name] = { workflow: result.workflow, registry };
  console.log(`${name} (settings ${JSON.stringify(result.workflow.settings)}):\n    ${describe(result.workflow)}`);
}

console.log("\n== What the loader rejects");
for (const file of readdirSync(join(here, "bad")).sort()) {
  const result = resolve(global, read(`bad/${file}`), createRegistry());
  if (result.ok) { console.log(`bad/${file}: ACCEPTED, but it should have been rejected`); failures++; }
  else console.log(`bad/${file}:\n    ${result.error}`);
}

console.log("\n== Scripted walks");
for (const sc of scenarios) {
  let state = start(projects[sc.project].workflow, { project: sc.project, lane: sc.lane });
  const trail: string[] = [];
  for (const press of sc.presses) {
    const before = state.current?.key ?? "-";
    state = press.restart ? reduce(state, { type: "restart" }) : reduce(state, { type: "outcome", outcome: press.outcome });
    trail.push(press.restart ? `${before} (restart)` : `${before}:${press.outcome}`);
  }
  const problems: string[] = [];
  if (state.status !== sc.expect.status) problems.push(`status ${state.status}, expected ${sc.expect.status}`);
  if (sc.expect.reasonIncludes && !(state.reason ?? "").includes(sc.expect.reasonIncludes)) problems.push(`reason "${state.reason}" lacks "${sc.expect.reasonIncludes}"`);
  if (sc.expect.currentKey && state.current?.key !== sc.expect.currentKey) problems.push(`current ${state.current?.key}, expected ${sc.expect.currentKey}`);
  const budgets = Object.entries<any>(state.budgets).map(([k, v]) => `${k} ${v.used}/${v.max}`).join(", ");
  console.log(`${sc.title} [${sc.project}, ${sc.lane}]: ${problems.length ? "PROBLEM " + problems.join("; ") : "ok"}\n    ${trail.join(" > ")}\n    end: ${state.status}${state.reason ? ` (${state.reason})` : ""}; ${budgets}`);
  if (problems.length) failures++;
}

console.log(failures ? `\n${failures} problem(s)` : "\nall good");
process.exit(failures ? 1 : 0);
