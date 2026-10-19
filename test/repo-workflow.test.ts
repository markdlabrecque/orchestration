import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checked, exec } from "../src/command.ts";
import { packageRoot } from "../src/project.ts";
import { loadWorkflow, matchesWhen } from "../src/workflow.ts";

test("repository override requires its own CI job on the exact head in every lane", async () => {
  const { workflow } = await loadWorkflow(
    join(packageRoot, "workflow.default.yaml"),
    join(packageRoot, ".orchestration/workflow.yaml"),
  );
  expect(workflow.settings.tests).toBe("pnpm check");
  const check = workflow.steps.find((s) => s.id === "repository-ci");
  expect(check).toBeDefined();
  if (!check) throw new Error("missing repository CI");
  expect(workflow.steps.indexOf(check)).toBeLessThan(
    workflow.steps.findIndex((s) => s.kind === "merge"),
  );
  for (const lane of ["standard", "trivial", "no-code"])
    expect(matchesWhen(check.when, workflow.settings, lane)).toBe(true);
  const dir = await mkdtemp(join(tmpdir(), "orch-ci-"));
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin/gh"),
      `#!/usr/bin/env node
const args=process.argv.slice(2);
console.log(args[1]==='view' ? JSON.stringify({headRefOid:process.env.FIXTURE_HEAD}) : process.env.FIXTURE_CHECKS);
`,
    );
    await chmod(join(dir, "bin/gh"), 0o755);
    const head = await checked(exec, {
      cwd: packageRoot,
      argv: ["git", "rev-parse", "HEAD"],
    });
    for (const [checks, sha, passes] of [
      [[{ name: "check", workflow: "v2", bucket: "pass" }], head, true],
      [[{ name: "check", workflow: "v2", bucket: "fail" }], head, false],
      [[{ name: "check", workflow: "v2", bucket: "pending" }], head, false],
      [[{ name: "check", workflow: "other", bucket: "pass" }], head, false],
      [[], head, false],
      [[{ name: "check", workflow: "v2", bucket: "pass" }], "stale", false],
    ] as const) {
      const result = await exec({
        cwd: packageRoot,
        argv: ["bash", "-c", String(check.options?.command)],
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          FIXTURE_HEAD: sha,
          FIXTURE_CHECKS: JSON.stringify(checks),
        },
      });
      expect(result.code === 0, result.stderr).toBe(passes);
    }
    expect(
      await readFile(join(packageRoot, ".github/workflows/v2.yml"), "utf8"),
    ).toContain("pnpm check");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
