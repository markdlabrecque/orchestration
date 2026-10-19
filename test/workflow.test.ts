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
