import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import type { Exec } from "../src/command.ts";

async function project(source: string) {
  const root = await mkdtemp(join(tmpdir(), "orch-preflight-"));
  const main = join(root, "main");
  await mkdir(main);
  const workflowPath = join(root, "workflow.yaml");
  await writeFile(workflowPath, source);
  const commands: string[][] = [];
  const execute: Exec = async ({ argv }) => {
    commands.push(argv);
    const stdout =
      argv[0] === "bash" && argv[2]?.includes("orch_resolve")
        ? `${root}\0${main}\0${root}/worktrees\0main\0`
        : argv[0] === "git"
          ? "git@github.com:fixture/repo.git"
          : "";
    return { code: 0, status: "done", stdout, stderr: "" };
  };
  return {
    root,
    main,
    workflowPath,
    execute,
    commands,
    models: createModels(),
    output: () => {},
  };
}

test("validate accepts a plain project without an override and ignores unused runners and unrelated forge tools", async () => {
  const f = await project(`version: 1
runners: { pi: { provider: unavailable, model: unavailable }, shell: { command: unavailable } }
steps: [{id: check, kind: shell, options: {command: echo}}]
`);
  try {
    expect(await runCli(["validate"], { ...f, cwd: f.main })).toBe(0);
    expect(
      f.commands.filter((argv) => ["gh", "glab", "ddev"].includes(argv[0])),
    ).toEqual([["gh", "--version"]]);
    expect(f.commands.some((argv) => argv.includes("unavailable"))).toBe(false);
    expect(
      f.commands.some((argv) => argv.some((s) => s.includes("setup-worktree"))),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("run rejects an invalid committed patch before tracker writes or pickup", async () => {
  const f = await project(
    `version: 1\nsteps: [{id: check, kind: shell, options: {command: echo}}]\n`,
  );
  try {
    await mkdir(join(f.main, ".orchestration"));
    await writeFile(
      join(f.main, ".orchestration/workflow.yaml"),
      `version: 1\npatch: [{set: check, with: {options: {command: '$settings.missing'}}}]\n`,
    );
    await expect(runCli(["run", "1"], { ...f, cwd: f.main })).rejects.toThrow(
      /workflow.yaml.*steps\[0\].*missing/,
    );
    expect(
      f.commands.some(
        (argv) =>
          argv[0] === "gh" || argv.some((s) => s.includes("setup-worktree")),
      ),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([
  [
    "missing role",
    `steps: [{id: work, kind: agent, runner: pi, options: {role: nonexistent}}]`,
    /missing role nonexistent/,
  ],
  [
    "missing model",
    `steps: [{id: work, kind: agent, runner: pi, options: {role: slice-planner}}]`,
    /Pi model/,
  ],
  [
    "missing runner command",
    `steps: [{id: work, kind: agent, runner: shell, options: {role: slice-planner}}]`,
    /missing command/,
  ],
])("run stops before pickup for %s", async (_label, body, expected) => {
  const f = await project(`version: 1\n${body}\n`);
  try {
    await expect(runCli(["run", "1"], { ...f, cwd: f.main })).rejects.toThrow(
      expected,
    );
    expect(
      f.commands.some(
        (argv) =>
          argv[0] === "gh" || argv.some((s) => s.includes("setup-worktree")),
      ),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("preflight checks DDEV for provisioning and excludes statically disabled agents", async () => {
  const f = await project(`version: 1
settings: { enabled: false }
steps:
  - {id: skipped, kind: agent, runner: pi, options: {role: nonexistent}, when: 'settings.enabled == true'}
  - {id: check, kind: shell, options: {command: echo}}
`);
  try {
    await mkdir(join(f.main, ".ddev"));
    expect(await runCli(["validate"], { ...f, cwd: f.main })).toBe(0);
    expect(
      f.commands.filter((argv) => ["gh", "glab", "ddev"].includes(argv[0])),
    ).toEqual([
      ["gh", "--version"],
      ["ddev", "--version"],
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("validate honors the selected forge override without probing unrelated CLIs", async () => {
  const f = await project(
    `version: 1\nsettings: {forge: gitlab}\nsteps: [{id: check, kind: shell, options: {command: echo}}]\n`,
  );
  try {
    expect(await runCli(["validate"], { ...f, cwd: f.main })).toBe(0);
    expect(
      f.commands.filter((argv) => ["gh", "glab", "ddev"].includes(argv[0])),
    ).toEqual([["glab", "--version"]]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the shipped workflow validates in a configured plain project with no override", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  const source = await readFile(
    new URL("../workflow.default.yaml", import.meta.url),
    "utf8",
  );
  const f = await project(source);
  f.models.setProvider(
    fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol" }] })
      .provider,
  );
  try {
    expect(await runCli(["validate"], { ...f, cwd: f.main })).toBe(0);
    expect(
      f.commands.some((argv) => argv[0] === "ddev" || argv[0] === "glab"),
    ).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an unused verification setting does not require DDEV on a plain project", async () => {
  const f = await project(
    `version: 1\nsettings: {verification: ddev}\nsteps: [{id: check, kind: shell, options: {command: echo}}]\n`,
  );
  try {
    expect(await runCli(["validate"], { ...f, cwd: f.main })).toBe(0);
    expect(f.commands.some((argv) => argv[0] === "ddev")).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
