import { expect, test } from "vitest";
import { resolveWorkflow } from "../src/workflow.ts";

test("loads the fixed workflow from data and rejects unsafe ordering before pickup", () => {
  const source = `version: 1
runners:
  pi: { provider: openai, model: gpt-6-sol }
  shell: { command: codex exec - }
steps:
  - { id: plan, kind: agent, runner: pi, role: planner }
  - { id: implement, kind: agent, runner: shell, role: implementor }
  - { id: mr, kind: mr }
  - { id: ci, kind: ci }
  - { id: merge, kind: merge }
`;
  expect(resolveWorkflow(source).steps.map((s) => s.id)).toEqual([
    "plan",
    "implement",
    "mr",
    "ci",
    "merge",
  ]);
  expect(() =>
    resolveWorkflow(source.replace("id: ci, kind: ci", "id: ci, kind: merge")),
  ).toThrow(/ci/);
  expect(() =>
    resolveWorkflow(source.replace("runner: shell", "runner: missing")),
  ).toThrow(/missing/);
});

test("rejects an agent id that would collide with engine-owned pickup", () => {
  const source = `version: 1
runners:
  pi: { provider: faux, model: fixture }
  shell: { command: cat }
steps:
  - { id: pickup, kind: agent, runner: pi, role: planner }
  - { id: mr, kind: mr }
  - { id: ci, kind: ci }
  - { id: merge, kind: merge }
`;
  expect(() => resolveWorkflow(source)).toThrow(/reserved/);
});

test("applies every patch in order, merges named configuration and deletes stale options", () => {
  const result = resolveWorkflow(
    `version: 1
settings: { old: unused, command: echo, retained: yes }
runners: { shell: { command: cat }, pi: { provider: openai, model: old } }
budgets: { bounces: { max: 3 } }
repairs:
  fix: { id: fix, kind: shell, options: { command: echo } }
steps:
  - { id: first, kind: shell, options: { command: '$settings.command', stale: '$settings.old', nested: { keep: 1, remove: 2 } } }
  - { id: second, kind: shell, options: { command: echo } }
  - { id: third, kind: shell, options: { command: echo } }
`,
    `version: 1
settings: { old: null, command: 'printf patched' }
runners: { pi: { provider: openai, model: new } }
budgets: { bounces: { max: 2 } }
repairs: { fix: { id: fixed, kind: shell, options: { command: 'echo fixed' } } }
patch:
  - set: first
    with: { options: { stale: null, nested: { remove: null } } }
  - insert_after: first
    step: { id: added, kind: shell, options: { command: echo } }
  - insert_before: first
    step: { id: start, kind: shell, options: { command: echo } }
  - replace: second
    step: { id: replacement, kind: shell, options: { command: echo } }
  - move: third
    before: first
  - move: added
    after: replacement
  - drop: start
`,
  );
  expect(result.steps.map((s) => s.id)).toEqual([
    "third",
    "first",
    "replacement",
    "added",
  ]);
  expect(result.steps[1].options).toEqual({
    command: "printf patched",
    nested: { keep: 1 },
  });
  expect(result.settings).toEqual({
    command: "printf patched",
    retained: "yes",
  });
  expect(result.runners.pi).toEqual({ provider: "openai", model: "new" });
  expect(result.budgets).toEqual({ bounces: { max: 2 } });
  expect(result.repairs.fix).toEqual({
    id: "fixed",
    kind: "shell",
    options: { command: "echo fixed" },
  });
});

test("loads explicit modules relative to each declaring workflow file", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadWorkflow } = await import("../src/workflow.ts");
  const dir = await mkdtemp(join(tmpdir(), "orch-modules-"));
  try {
    await mkdir(join(dir, "global"));
    await mkdir(join(dir, "project"));
    await writeFile(
      join(dir, "global/custom.mjs"),
      `export default {type:'kind', name:'custom', outcomes:['checked','failed'], run:async()=>({outcome:'checked'})}`,
    );
    await writeFile(
      join(dir, "project/custom.mjs"),
      `export default {type:'runner', name:'custom', tools:['read'], resumable:true, create:()=>({resumable:true,run:async()=>({status:'done',handoff:'custom',artifacts:[],ranOn:{provider:'fixture',model:'fixture',effort:'medium'},usage:null})})}`,
    );
    const globalPath = join(dir, "global/workflow.yaml");
    const projectPath = join(dir, "project/workflow.yaml");
    await writeFile(
      globalPath,
      `version: 1\nuses: ['./custom.mjs']\nsteps: [{id: check, kind: custom}]\n`,
    );
    await writeFile(
      projectPath,
      `version: 1\nuses: ['./custom.mjs']\npatch: []\n`,
    );
    const loaded = await loadWorkflow(globalPath, projectPath);
    expect(loaded.workflow.steps[0].kind).toBe("custom");
    expect(loaded.registrations.kinds.get("custom")?.outcomes).toEqual([
      "checked",
      "failed",
    ]);
    expect(loaded.registrations.runners.get("custom")?.resumable).toBe(true);
    await writeFile(
      projectPath,
      `version: 1\nuses: ['../global/custom.mjs']\npatch: []\n`,
    );
    await expect(loadWorkflow(globalPath, projectPath)).rejects.toThrow(
      /project\/workflow.yaml.*uses\[0\].*duplicate kind custom/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const base = `version: 1
settings: { tests: pnpm test }
runners: { pi: { provider: fixture, model: fixture } }
steps:
  - { id: check, kind: shell, options: { command: echo } }
`;
test.each([
  ["missing target", "patch: [{drop: missing}]", /patch\[0\].*missing/],
  [
    "duplicate insertion",
    "patch: [{insert_after: check, step: {id: check, kind: shell}}]",
    /patch\[0\].*duplicate/,
  ],
  ["set id", "patch: [{set: check, with: {id: renamed}}]", /patch\[0\].*id/],
  [
    "two move anchors",
    "patch: [{move: check, before: check, after: check}]",
    /patch\[0\].*before/,
  ],
  [
    "missing move anchor",
    "patch: [{move: check, before: missing}]",
    /patch\[0\].*missing/,
  ],
  [
    "removed setting",
    "settings: {tests: null}\npatch: [{set: check, with: {options: {command: '$settings.tests'}}}]",
    /steps\[0\].*setting tests/,
  ],
  [
    "condition setting",
    "patch: [{set: check, with: {when: 'settings.absent == yes'}}]",
    /steps\[0\].*setting absent/,
  ],
  [
    "hidden invalid condition",
    "patch: [{set: check, with: {when: ['lane == trivial', 'run JavaScript']}}]",
    /steps\[0\].*condition/,
  ],
  [
    "scalar membership",
    "patch: [{set: check, with: {when: 'lane in standard'}}]",
    /steps\[0\].*condition/,
  ],
  [
    "list equality",
    "patch: [{set: check, with: {when: 'lane == [standard]'}}]",
    /steps\[0\].*condition/,
  ],
  [
    "unknown outcome",
    "patch: [{set: check, with: {on: {passed: {repair: fix, budget: bounces}}}}]",
    /steps\[0\].*outcome passed/,
  ],
  [
    "unknown repair",
    "patch: [{set: check, with: {on: {failed: {repair: absent, budget: bounces}}}}]",
    /steps\[0\].*repair absent/,
  ],
  [
    "unknown budget",
    "repairs: {fix: {kind: shell, options: {command: echo}}}\npatch: [{set: check, with: {on: {failed: {repair: fix, budget: absent}}}}]",
    /steps\[0\].*budget absent/,
  ],
  [
    "dangling session",
    "patch: [{replace: check, step: {id: check, kind: agent, runner: pi, options: {role: reviewer}, session: missing}}]",
    /steps\[0\].*session missing/,
  ],
  [
    "runner on shell",
    "patch: [{set: check, with: {runner: pi}}]",
    /steps\[0\].*only agent/,
  ],
  [
    "unknown kind",
    "patch: [{set: check, with: {kind: unknown}}]",
    /steps\[0\].*unknown kind/,
  ],
  [
    "missing tests command",
    "settings: {tests: null}\npatch: [{set: check, with: {gate: tests-green}}]",
    /steps\[0\].*settings.tests/,
  ],
  [
    "invalid budget",
    "budgets: {bounces: {max: -1}}\npatch: []",
    /budgets.bounces/,
  ],
  ["scratch project", "from: scratch\npatch: []", /project.*from/],
])("rejects %s with a located error", (_name, patch, expected) => {
  expect(() => resolveWorkflow(base, `version: 1\n${patch}\n`)).toThrow(
    expected,
  );
});

test("validates ordered repair definitions and reports unused repairs", async () => {
  const { unusedRepairs } = await import("../src/workflow.ts");
  const workflow = resolveWorkflow(
    base,
    `version: 1
budgets: { bounces: { max: 3 } }
repairs:
  fix:
    - { id: fix-code, kind: shell, options: { command: echo } }
    - { id: push-code, kind: shell, options: { command: echo } }
  unused: { kind: shell, options: { command: echo } }
patch:
  - set: check
    with: { on: { failed: { repair: fix, budget: bounces } } }
`,
  );
  expect(unusedRepairs(workflow)).toEqual(["unused"]);
});

test.each([
  [
    "null condition",
    "steps: [{id: check, kind: shell, options: {command: echo}, when: null}]",
    /steps\[0\].*condition/,
  ],
  [
    "empty condition",
    "steps: [{id: check, kind: shell, options: {command: echo}, when: ''}]",
    /steps\[0\].*condition/,
  ],
  [
    "inherited kind",
    "steps: [{id: check, kind: toString}]",
    /steps\[0\].*unknown kind/,
  ],
  ["invalid uses", "uses: not-a-list\nsteps: []", /uses/],
  [
    "null setting value",
    "settings: {command: null}\nsteps: [{id: check, kind: shell, options: {command: '$settings.command'}}]",
    /steps\[0\].*setting command/,
  ],
])("rejects %s without execution", (_label, body, error) => {
  expect(() => resolveWorkflow(`version: 1\n${body}\n`)).toThrow(error);
});

test("rejects unknown patch fields instead of ignoring a misspelled operation argument", () => {
  expect(() =>
    resolveWorkflow(base, "version: 1\npatch: [{drop: check, typo: true}]\n"),
  ).toThrow(/patch\[0\].*typo/);
});

test("uses loads an import-only npm package from the declaring file's node_modules", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadWorkflow } = await import("../src/workflow.ts");
  const dir = await mkdtemp(join(tmpdir(), "orch-package-"));
  try {
    const pkg = join(dir, "node_modules/fixture-kind");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "fixture-kind",
        type: "module",
        exports: { import: "./index.js" },
      }),
    );
    await writeFile(
      join(pkg, "index.js"),
      "export default {type:'kind',name:'fixture',outcomes:['pass'],run:async()=>({outcome:'pass'})}",
    );
    const path = join(dir, "workflow.yaml");
    await writeFile(
      path,
      "version: 1\nuses: [fixture-kind]\nsteps: [{id: check, kind: fixture}]\n",
    );
    expect((await loadWorkflow(path)).workflow.steps[0].kind).toBe("fixture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  {
    id: "verify",
    kind: "agent",
    runner: "shell",
    options: { role: "verifier", verification: "production" },
  },
  {
    id: "approval",
    kind: "human",
    options: { ask: "Approve?", choices: ["yes", "yes"] },
  },
  {
    id: "approval",
    kind: "human",
    options: { ask: "Approve?", choices: ["yes", "pass"] },
  },
])("rejects invalid verification modes and ambiguous human choices", (step) => {
  expect(() =>
    resolveWorkflow(
      JSON.stringify({
        version: 1,
        runners: { shell: { command: "cat" } },
        steps: [step],
      }),
    ),
  ).toThrow();
});
