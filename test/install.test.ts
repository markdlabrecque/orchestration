import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checked, exec } from "../src/command.ts";
import { packageRoot } from "../src/project.ts";
import { installedWorkflow } from "./fixtures/installed-workflow.ts";

test("stable install links a working CLI, preserves global edits and rejects ticket worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-install-"));
  try {
    const home = join(dir, "home"),
      stable = join(dir, "stable"),
      ticket = join(dir, "145");
    await mkdir(stable, { recursive: true });
    const store = await checked(exec, {
      cwd: packageRoot,
      argv: ["pnpm", "store", "path"],
    });
    const env = {
      npm_config_store_dir: store,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PNPM_HOME: join(home, "pnpm"),
      npm_config_global_dir: join(home, "global"),
      npm_config_global_bin_dir: join(home, "pnpm"),
      PATH: `${join(home, "pnpm")}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    for (const file of [
      "src",
      "bin",
      "scripts",
      "skills",
      "roles",
      "workflow.default.yaml",
      "package.json",
      "pnpm-lock.yaml",
    ])
      await cp(join(packageRoot, file), join(stable, file), {
        recursive: true,
      });
    // Dependencies are already installed by the suite; link the same store into this fixture.
    await cp(join(packageRoot, "node_modules"), join(stable, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const run = (argv: string[], cwd = stable) =>
      checked(exec, { argv, cwd, env });
    await writeFile(join(stable, ".gitignore"), "node_modules/\n");
    await run(["git", "init", "-b", "main"]);
    await run([
      "git",
      "add",
      ".gitignore",
      "src",
      "bin",
      "scripts",
      "skills",
      "roles",
      "workflow.default.yaml",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    await run(["git", "commit", "-m", "fixture"]);
    const global = join(home, ".config/orchestration/workflow.yaml");
    await mkdir(join(home, ".config/orchestration"), { recursive: true });
    await writeFile(global, "user edits\n");
    const skill = join(home, ".pi/agent/skills/orch/SKILL.md");
    const bundledSkill = await readFile(
      join(stable, "skills/orch/SKILL.md"),
      "utf8",
    );
    await run(["bash", "scripts/install-local"]);
    expect(await readFile(skill, "utf8")).toBe(bundledSkill);
    expect(await readFile(global, "utf8")).toBe("user edits\n");
    expect(await realpath(join(home, "bin/orch-update"))).toBe(
      join(stable, "scripts/update-local"),
    );
    const commit = await run(["git", "rev-parse", "--short", "HEAD"]);
    expect(await run(["orch", "--version"], dir)).toBe(
      `2.0.0-alpha.1 ${commit}`,
    );
    await run(["git", "worktree", "add", "-b", "145", ticket]);
    const rejected = await exec({
      argv: ["bash", "scripts/install-local"],
      cwd: ticket,
      env,
    });
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("stable checkout");
    expect(await readFile(global, "utf8")).toBe("user edits\n");
    await run(["orch", "workflow", "reset", "--force"], dir);
    expect(await readFile(`${global}.bak`, "utf8")).toBe("user edits\n");
    await rm(global);
    await writeFile(skill, "local skill edits\n");
    await run(["bash", "scripts/install-local"]);
    expect(await readFile(skill, "utf8")).toBe(bundledSkill);
    const pristine = await readFile(
      join(stable, "workflow.default.yaml"),
      "utf8",
    );
    expect(await readFile(global, "utf8")).toBe(pristine);
    const upstream = join(dir, "updates.git"),
      publisher = join(dir, "publisher");
    await run(["git", "clone", "--bare", stable, upstream]);
    await run(["git", "remote", "add", "origin", upstream]);
    await run(["git", "fetch", "origin"]);
    await run(["git", "branch", "--set-upstream-to=origin/main", "main"]);
    await run(["git", "clone", upstream, publisher]);
    const pkg = JSON.parse(
      await readFile(join(publisher, "package.json"), "utf8"),
    );
    pkg.version = "2.0.0-alpha.2";
    await writeFile(
      join(publisher, "package.json"),
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    const updatedSkill = `${bundledSkill}\nUpdated fixture instructions.\n`;
    await writeFile(join(publisher, "skills/orch/SKILL.md"), updatedSkill);
    await run(
      ["git", "add", "package.json", "skills/orch/SKILL.md"],
      publisher,
    );
    await run(["git", "commit", "-m", "fixture update"], publisher);
    await run(["git", "push"], publisher);
    const updated = await run(
      ["git", "rev-parse", "--short", "HEAD"],
      publisher,
    );
    await writeFile(skill, "local skill edits before update\n");
    await run([join(home, "bin/orch-update")], dir);
    expect(await readFile(skill, "utf8")).toBe(updatedSkill);
    expect(await run(["orch", "--version"], dir)).toBe(
      `2.0.0-alpha.2 ${updated}`,
    );
    expect(await readFile(global, "utf8")).toBe(pristine);
    await writeFile(join(stable, "local-work.txt"), "do not lose this");
    const refusedUpdate = await exec({
      argv: [join(home, "bin/orch-update")],
      cwd: dir,
      env,
    });
    expect(refusedUpdate.code).not.toBe(0);
    expect(refusedUpdate.stderr).toContain("uncommitted work");
    expect(await readFile(join(stable, "local-work.txt"), "utf8")).toBe(
      "do not lose this",
    );
    await installedWorkflow(stable, home, dir, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
