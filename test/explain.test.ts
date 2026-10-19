import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { type Exec, exec } from "../src/command.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orch-explain-"));
  dirs.push(dir);
  const root = join(dir, "project"),
    main = join(root, "code/main"),
    config = join(dir, "global.yaml");
  await mkdir(join(main, ".orchestration"), { recursive: true });
  await writeFile(
    join(root, ".orch"),
    "BASE_BRANCH=main\nMAIN_CHECKOUT=code/main\n",
  );
  const execute: Exec = (request) =>
    exec({
      ...request,
      env: {
        ...request.env,
        ORCH_PROJECTS_DIR: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await execute({ cwd: main, argv: ["git", "init", "-b", "main"] });
  await execute({
    cwd: main,
    argv: [
      "git",
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/repo.git",
    ],
  });
  await writeFile(
    config,
    `version: 1
settings: {message: original}
runners: {shell: {command: agent}}
repairs:
  unused: {id: unused, kind: shell, options: {command: echo unused}}
steps:
  - {id: check, kind: shell, options: {command: '$settings.message'}, when: 'lane == standard'}
`,
  );
  await writeFile(
    join(main, ".orchestration/workflow.yaml"),
    `version: 1
settings: {message: '<script>alert("ticket")</script>'}
patch:
  - set: check
    with: {when: 'lane != no-code'}
`,
  );
  const output: string[] = [];
  return {
    dir,
    root,
    main,
    config,
    output,
    options: {
      cwd: main,
      workflowPath: config,
      execute,
      output: (s: string) => output.push(s),
    },
  };
}

test("explain text compares global and effective steps, lanes and configuration without preflight or browser", async () => {
  const f = await fixture();
  expect(await runCli(["explain", "--simple"], f.options)).toBe(0);
  const text = f.output.join("\n");
  for (const expected of [
    "Global workflow",
    "Effective workflow",
    "Patch operations",
    "set: check",
    "standard",
    "trivial",
    "no-code",
    "Settings",
    "Runners",
    "Unused repairs: unused",
    "original",
    '<script>alert("ticket")</script>',
  ])
    expect(text).toContain(expected);
});

test("explain writes a self-contained escaped report and opens that file", async () => {
  const f = await fixture();
  const opened: string[][] = [];
  const execute: Exec = async (request) => {
    if (["xdg-open", "open"].includes(request.argv[0])) {
      opened.push(request.argv);
      return { code: 0, status: "done", stdout: "", stderr: "" };
    }
    return f.options.execute(request);
  };
  expect(await runCli(["explain"], { ...f.options, execute })).toBe(0);
  const file = join(f.root, ".agents/orchestration/explain.html");
  expect(opened).toEqual([
    [process.platform === "darwin" ? "open" : "xdg-open", file],
  ]);
  const html = await readFile(file, "utf8");
  expect(html).toContain(
    "&lt;script&gt;alert(&quot;ticket&quot;)&lt;/script&gt;",
  );
  expect(html).not.toContain('<script>alert("ticket")</script>');
  expect(html).toContain('id="lane"');
  expect(html).toContain('class="changed"');
  expect(html).toContain("Unused repairs: unused");
  expect(html).toContain("Global workflow");
  expect(html).toContain("Effective workflow");
});

test("workflow diff shows drift; reset refuses edits and force preserves every backup", async () => {
  const f = await fixture();
  const original = await readFile(f.config, "utf8");
  expect(await runCli(["workflow", "diff"], f.options)).toBe(0);
  expect(f.output.join("\n")).toContain("+settings: {message: original}");
  await expect(runCli(["workflow", "reset"], f.options)).rejects.toThrow(
    "--force",
  );
  expect(await readFile(f.config, "utf8")).toBe(original);
  expect(await runCli(["workflow", "reset", "--force"], f.options)).toBe(0);
  expect(await readFile(`${f.config}.bak`, "utf8")).toBe(original);
  const shipped = await readFile(
    new URL("../workflow.default.yaml", import.meta.url),
    "utf8",
  );
  expect(await readFile(f.config, "utf8")).toBe(shipped);
  // Reset an unedited global too, without destroying the earlier backup.
  expect(await runCli(["workflow", "reset"], f.options)).toBe(0);
  expect(await readFile(`${f.config}.bak`, "utf8")).toBe(original);
  f.output.length = 0;
  await runCli(["workflow", "diff"], f.options);
  expect(f.output).toEqual(["Global workflow matches shipped default"]);
});
