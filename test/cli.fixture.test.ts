import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../src/cli.ts";
import { checked, type Exec, exec } from "../src/command.ts";
import { type JsonValue, resolveWorkflow } from "../src/workflow.ts";

test.each([
  "slice",
  "standard",
  "trivial",
  "no-code",
])("[fixture] %s CLI to real worktree, durable Pi, shell, GitHub adapter, CI, merge and retirement", async (lane) => {
  const dir = await mkdtemp(join(tmpdir(), "orch-e2e-"));
  const projects = join(dir, "Projects"),
    root = join(projects, "fixture"),
    main = join(root, "code/main"),
    bare = join(dir, "remote.git");
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ORCH_PROJECTS_DIR: projects,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (argv: string[], cwd = main) =>
    checked(exec, { cwd, argv: ["git", ...argv], env });
  try {
    await mkdir(main, { recursive: true });
    await git(["init", "-b", "main"]);
    await git(["init", "--bare", bare]);
    await writeFile(join(main, "README.md"), "fixture");
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
    await git([
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/repo.git",
    ]);
    await git([
      "config",
      `url.${bare}.insteadOf`,
      "https://github.com/fixture/repo.git",
    ]);
    await git(["push", "-u", "origin", "main"]);
    await writeFile(
      join(root, ".orch"),
      "BASE_BRANCH=main\nMAIN_CHECKOUT=code/main\n",
    );
    const workflow = resolveWorkflow(
      await readFile(
        new URL(
          lane === "slice"
            ? "./fixtures/slice-workflow.yaml"
            : "../workflow.default.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    workflow.runners.pi = { provider: "faux", model: "fixture" };
    workflow.runners.shell = { command: "" };
    workflow.settings.tests = `if test -f change.txt && test "$(cat change.txt)" = implemented; then exit 0; else printf '%s' '{"passed":0,"failures":[{"test":"writes change.txt","message":"expected implemented","kind":"assertion"}],"errors":[]}' > "$ORCH_TEST_REPORT_FILE"; exit 1; fi`;
    workflow.runners.shell.command = `printf implemented > change.txt; printf '{"outcome":"pass","summary":"implementation complete"}' > "$ORCH_RESULT_FILE"; printf handoff`;
    // Both workflow layers load a module relative to their own file.
    const registrationsUrl = new URL("../src/registration.ts", import.meta.url)
      .href;
    await writeFile(
      join(dir, "custom-kind.mjs"),
      `
      import { defineStepKind } from ${JSON.stringify(registrationsUrl)};
      export default defineStepKind({ name: 'record', outcomes: ['recorded', 'failed'],
        run: async (step, helpers) => {
          const result = await helpers.exec({ cwd: helpers.cwd, argv: ['bash', '-c', step.options.command] });
          return {outcome: result.code === 0 ? 'recorded' : 'failed'};
        }
      });
    `,
    );
    await mkdir(join(main, ".orchestration"));
    await writeFile(
      join(main, ".orchestration/custom-runner.mjs"),
      `
      import { defineRunner } from ${JSON.stringify(registrationsUrl)};
      export default defineRunner({ name: 'custom', resumable: false, tools: ['read'],
        create: (config) => ({ resumable: false, run: async (request) => ({
          status: 'done', handoff: config.message, result: {outcome: 'pass', summary: request.role},
          artifacts: [], ranOn: {provider:'fixture', model:'fixture', effort:'medium'}, usage:null
        }) })
      });
    `,
    );
    await writeFile(
      join(main, ".orchestration/workflow.yaml"),
      `version: 1
uses: ['./custom-runner.mjs']
settings: {record: 'printf registered > custom.txt'}
runners: {custom: {message: 'custom runner handoff'}}
patch:
  - insert_before: ${lane === "slice" ? "plan" : "spec"}
    step: {id: custom-agent, kind: agent, runner: custom, tools: [read], options: {role: slice-planner}}
  - insert_after: implement
    step: {id: record, kind: record, options: {command: '$settings.record'}}
`,
    );
    await git(["add", ".orchestration"]);
    await git(["commit", "-m", "fixture project workflow"]);
    await git(["push", "origin", "main"]);
    const config = join(dir, "workflow.yaml");
    await writeFile(
      config,
      stringify({ ...workflow, uses: ["./custom-kind.mjs"] }),
    );
    const models = createModels(),
      faux = fauxProvider({ models: [{ id: "fixture" }] });
    models.setProvider(faux.provider);
    const results: Record<string, JsonValue>[] =
      lane === "slice"
        ? [{ outcome: "pass", summary: "plan" }]
        : [
            {
              outcome: "pass",
              summary: "spec",
              lane: "standard",
              implementationTier: "heavy",
            },
            ...(lane === "standard"
              ? [
                  {
                    outcome: "pass",
                    summary: "red",
                    expectedFailures: [
                      {
                        test: "writes change.txt",
                        message: "expected implemented",
                      },
                    ],
                  },
                ]
              : []),
            ...(lane !== "trivial"
              ? [{ outcome: "pass", summary: "review", findings: [] }]
              : []),
            { outcome: "pass", summary: "report" },
          ];
    faux.setResponses(
      results.map((result) =>
        fauxAssistantMessage(fauxToolCall("submit_result", result), {
          stopReason: "toolUse",
        }),
      ),
    );
    let merged = false,
      head = "",
      comment: unknown = null,
      pr: unknown = null;
    const merges: string[] = [];
    const execute: Exec = async (request) => {
      if (request.argv[0] !== "gh")
        return exec({ ...request, env: { ...env, ...request.env } });
      const args = request.argv,
        path = args[2];
      let result: unknown = {};
      if (args[1] === "--version")
        return { code: 0, status: "done", stdout: "gh fixture", stderr: "" };
      if (args[1] === "pr") result = [{ name: "fixture", bucket: "pass" }];
      else if (path === "user") result = { login: "fixture" };
      else if (path === "repos/fixture/repo/issues/139")
        result = {
          number: 139,
          title: "Change the fixture",
          body: "Implement change.txt",
          html_url: "ticket",
          labels: lane === "slice" ? [] : [{ name: `lane:${lane}` }],
        };
      else if (path?.includes("/comments")) {
        if (args.includes("POST")) {
          comment = {
            id: 5,
            body: JSON.parse(request.input ?? "").body,
            html_url: "comment",
          };
          result = comment;
        } else result = [comment ? [comment] : []];
      } else if (path === "repos/fixture/repo/pulls" && args.includes("POST")) {
        head = await git(["rev-parse", "139"]);
        pr = {
          number: 7,
          html_url: "pr",
          body: JSON.parse(request.input ?? "").body,
        };
        result = pr;
      } else if (path?.includes("pulls?")) result = [pr ? [pr] : []];
      else if (path === "repos/fixture/repo/pulls/7")
        result = { number: 7, html_url: "pr", head: { sha: head }, merged };
      else if (path?.endsWith("/merge")) {
        const body = JSON.parse(request.input ?? "");
        expect(body).toEqual({ merge_method: "squash", sha: head });
        merges.push(body.sha);
        merged = true;
        result = { merged: true };
      } else if (!path?.endsWith("/assignees"))
        throw new Error(`Unexpected fixture API ${args.join(" ")}`);
      return {
        code: 0,
        status: "done",
        stdout: JSON.stringify(result),
        stderr: "",
      };
    };
    const output: string[] = [];
    expect(
      await runCli(["run", "139"], {
        cwd: main,
        execute,
        models,
        workflowPath: config,
        output: (s) => output.push(s),
      }),
      output.join("\n"),
    ).toBe(0);
    expect(output.at(-1)).toBe("merged");
    expect(output).toContain("custom runner handoff");
    expect(await git(["show", "139:custom.txt"])).toBe("registered");
    expect(merges).toHaveLength(1);
    expect(await git(["show", "139:change.txt"])).toBe("implemented");
    await expect(access(join(root, "code/139"))).rejects.toThrow();
    await access(join(root, ".agents/orchestration/runs/139.sqlite"));
    expect(
      await runCli(["run", "139"], {
        cwd: main,
        execute,
        models,
        workflowPath: config,
        output: () => {},
      }),
    ).toBe(0);
    expect(merges).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
