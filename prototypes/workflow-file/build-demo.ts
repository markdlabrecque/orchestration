// PROTOTYPE (#128): bake demo.html from demo.template.html. Everything static
// (file texts, resolved workflows, loader errors) is computed here in Node so the
// page needs no YAML parser; the browser only runs the engine walk. Run: node build-demo.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { createRegistry, resolve } from "#engine";

const here: string = import.meta.dirname;
const text = (rel: string) => readFileSync(join(here, rel), "utf8");
const data = (rel: string): any => parse(text(rel));

const files: Record<string, string> = {};
for (const rel of ["global/workflow.yaml", "projects/orchestration/.orchestration/workflow.yaml", "projects/drupal-site/.orchestration/workflow.yaml", "projects/drupal-site/.orchestration/steps/a11y-scan.step.ts"]) files[rel] = text(rel);
for (const f of readdirSync(join(here, "bad")).sort()) files[`bad/${f}`] = text(`bad/${f}`);

const global = data("global/workflow.yaml");
const effective = (wf: any) => stringify({ version: wf.version, budgets: wf.budgets, repairs: wf.repairs, settings: wf.settings, steps: wf.steps }, { lineWidth: 0 });

const projects: Record<string, any> = {};
const g = resolve(global, undefined, createRegistry());
if (!g.ok) throw new Error(g.error);
projects.global = { workflow: g.workflow, effectiveYaml: effective(g.workflow), settings: g.workflow.settings };
for (const name of readdirSync(join(here, "projects")).sort()) {
  const override = data(`projects/${name}/.orchestration/workflow.yaml`);
  const registry = createRegistry();
  for (const rel of override.uses ?? []) registry.register((await import(pathToFileURL(resolvePath(here, "projects", name, rel)).href)).default);
  const r = resolve(global, override, registry);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  projects[name] = { workflow: r.workflow, effectiveYaml: effective(r.workflow), settings: r.workflow.settings };
}

const bad = readdirSync(join(here, "bad")).sort().map((f) => {
  const r = resolve(global, data(`bad/${f}`), createRegistry());
  return { file: `bad/${f}`, error: r.ok ? "ACCEPTED (bug: should be rejected)" : r.error };
});

const safe = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const html = text("demo.template.html")
  .replace("/* @DATA */", safe(JSON.stringify({ files, projects, bad })))
  .replace("/* @ENGINE */", safe(text("engine.js")))
  .replace("/* @SCENARIOS */", safe(text("scenarios.js")));
writeFileSync(join(here, "demo.html"), html);
console.log(`wrote demo.html (${(html.length / 1024).toFixed(0)} KB)`);
