import { stringify } from "yaml";
import {
  type loadWorkflow,
  matchesWhen,
  resolveWorkflow,
  unusedRepairs,
  type Workflow,
} from "./workflow.ts";

type Loaded = Awaited<ReturnType<typeof loadWorkflow>>;
const lanes = ["standard", "trivial", "no-code"];
function describe(workflow: Workflow): string {
  return [
    ...lanes.map(
      (lane) =>
        `Lane ${lane}: ${workflow.steps
          .filter((step) => matchesWhen(step.when, workflow.settings, lane))
          .map((step) => step.id)
          .join(" → ")}`,
    ),
    `Steps\n${stringify(workflow.steps)}`,
    `Settings\n${stringify(workflow.settings)}`,
    `Runners\n${stringify(workflow.runners)}`,
    `Budgets\n${stringify(workflow.budgets)}`,
    `Repairs\n${stringify(workflow.repairs)}`,
    `Unused repairs: ${unusedRepairs(workflow).join(", ") || "none"}`,
  ].join("\n\n");
}
export function explainText(loaded: Loaded): string {
  const global = resolveWorkflow(loaded.globalSource, undefined, {
    registrations: loaded.registrations,
  });
  return `Global workflow\n${describe(global)}\n\nPatch operations and configuration overrides\n${loaded.patchSource ?? "No project override"}\n\nEffective workflow\n${describe(loaded.workflow)}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}
export function explainHtml(loaded: Loaded): string {
  const global = resolveWorkflow(loaded.globalSource, undefined, {
    registrations: loaded.registrations,
  });
  const effective = loaded.workflow;
  const code = (value: unknown) => `<pre>${escapeHtml(stringify(value))}</pre>`;
  const panel = (workflow: Workflow, other: Workflow, title: string) => {
    const steps = workflow.steps
      .map((step, index) => {
        const previous = other.steps.find((s) => s.id === step.id);
        const changed =
          JSON.stringify(step) !== JSON.stringify(previous) ||
          other.steps[index]?.id !== step.id;
        const active = lanes.filter((lane) =>
          matchesWhen(step.when, workflow.settings, lane),
        );
        return `<li ${changed ? 'class="changed"' : ""} data-lanes="${active.join(" ")}"><div class="step-title"><strong>${escapeHtml(step.id)}</strong><span>${escapeHtml(step.kind)}${step.runner ? ` / ${escapeHtml(step.runner)}` : ""}</span></div><p class="state">${active.includes("standard") ? "Runs" : "Skipped"}</p>${changed ? '<span class="badge">Project difference</span>' : ""}<details><summary>Options, conditions and gates</summary>${code(step)}</details></li>`;
      })
      .join("");
    const sections = (["settings", "runners", "budgets", "repairs"] as const)
      .map(
        (section) =>
          `<section><h3>${section[0].toUpperCase()}${section.slice(1)}</h3>${
            Object.keys(workflow[section]).length
              ? Object.entries(workflow[section])
                  .map(
                    ([name, value]) =>
                      `<details ${section === "settings" ? "open" : ""} ${JSON.stringify(value) !== JSON.stringify(other[section][name]) ? 'class="changed"' : ""}><summary>${escapeHtml(name)}</summary>${code(value)}</details>`,
                  )
                  .join("")
              : "<p>None</p>"
          }</section>`,
      )
      .join("");
    return `<article><h2>${title}</h2><ol>${steps}</ol>${sections}<p>Unused repairs: ${escapeHtml(unusedRepairs(workflow).join(", ") || "none")}</p></article>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workflow explanation</title>
<style>
:root{color-scheme:dark;--bg:#101014;--panel:#1c1b22;--text:#eee9dc;--muted:#b9b4aa;--gold:#e6c477}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:32px 24px}h1{font-size:2.2rem;line-height:1.2}h2{font-size:1.35rem;color:var(--gold)}h3{font-size:1.1rem}p{color:var(--muted)}header{margin-bottom:28px}.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{min-width:0;background:var(--panel);border:1px solid #37343c;border-radius:10px;padding:24px}ol{padding:0;list-style:none;counter-reset:step}li{counter-increment:step;border:1px solid #46424c;border-radius:6px;margin:12px 0;padding:14px}li strong:before{content:counter(step) '. ';color:var(--muted)}.step-title{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}.step-title span,.badge{font-size:.8rem;color:var(--gold)}.state{margin:5px 0;font-size:.85rem}.changed{border-left:3px solid var(--gold);background:#e6c4770a;padding-left:12px}.skipped{border-style:dashed}.skipped .step-title{color:var(--muted)}details{margin:10px 0}summary{cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:#111116;border-radius:5px;padding:14px;margin:10px 0}label{font-weight:600}select{font:inherit;margin-left:10px;padding:8px 12px;border:1px solid var(--gold);border-radius:5px;background:var(--panel);color:var(--text)}h1,h2,h3,p,strong,span{overflow-wrap:anywhere}.patch{margin:24px 0;border:1px solid #70603f;border-radius:8px;padding:20px}.patch h2{margin-top:0}:focus-visible{outline:2px solid var(--gold);outline-offset:3px}@media(max-width:720px){main{padding:20px 12px}.columns{grid-template-columns:minmax(0,1fr)}article{padding:16px}h1{font-size:1.8rem}}@media print{details{display:block}.columns{grid-template-columns:1fr}body{background:white;color:black}}
</style></head><body><main><header><h1>Workflow explanation</h1><p>Global configuration and the project patch, resolved before pickup. Gold borders mark changed, added, removed or moved entries.</p><label for="lane">Preview lane</label><select id="lane">${lanes.map((lane) => `<option>${lane}</option>`).join("")}</select><p>Lane selection previews conditions only. The spec result or a ticket label chooses the run's lane. Skipped steps stay visible.</p></header>
<section class="patch"><h2>Patch operations and configuration overrides</h2><pre>${escapeHtml(loaded.patchSource ?? "No project override")}</pre></section>
<div class="columns">${panel(global, effective, "Global workflow")}${panel(effective, global, "Effective workflow")}</div>
<details><summary>Complete text explanation</summary><pre>${escapeHtml(explainText(loaded))}</pre></details></main>
<script>const lane = document.getElementById('lane'); function update(){document.querySelectorAll('[data-lanes]').forEach(row=>{const active=row.dataset.lanes.split(' ').includes(lane.value);row.classList.toggle('skipped',!active);row.querySelector('.state').textContent=active?'Runs':'Skipped';});} lane.addEventListener('change',update);update();</script></body></html>`;
}
