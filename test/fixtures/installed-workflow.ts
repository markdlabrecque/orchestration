import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, stringify } from "yaml";
import { checked, exec } from "../../src/command.ts";

/** Exercise the installed executable; only model and forge processes are fakes. */
export async function installedWorkflow(
  stable: string,
  home: string,
  dir: string,
  baseEnv: Record<string, string>,
) {
  const projects = join(dir, "Projects"),
    root = join(projects, "fixture"),
    main = join(root, "code/main"),
    fakebin = join(dir, "fakebin");
  await mkdir(main, { recursive: true });
  await mkdir(fakebin);
  const env = {
    ...baseEnv,
    ORCH_PROJECTS_DIR: projects,
    PATH: `${fakebin}:${baseEnv.PATH}`,
  };
  const run = (argv: string[], cwd = main) => checked(exec, { argv, cwd, env });
  const git = (argv: string[]) => run(["git", ...argv]);
  await git(["init", "-b", "main"]);
  const remote = join(dir, "fixture.git");
  await git(["init", "--bare", remote]);
  await writeFile(join(main, "README.md"), "installed fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const origin = "https://github.com/team/repo.git";
  await git(["remote", "add", "origin", origin]);
  await git(["config", `url.${remote}.insteadOf`, origin]);
  await git(["push", "-u", "origin", "main"]);
  await writeFile(
    join(root, ".orch"),
    "BASE_BRANCH=main\nMAIN_CHECKOUT=code/main\n",
  );
  const state = join(dir, "forge-state.json");
  await writeFile(
    join(fakebin, "gh"),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fakeForge } from ${JSON.stringify(new URL("./forge.ts", import.meta.url).href)};
const args=process.argv.slice(2);
if(args[0]==='--version'){ console.log('fixture'); process.exit(0); }
const fake=fakeForge('github');
try {Object.assign(fake.state, JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8')));} catch(e){if(e.code!=='ENOENT')throw e;}
if(args[1]==='repos/team/repo/pulls' && args.includes('POST')) fake.state.head=execFileSync('git',['rev-parse','3'],{encoding:'utf8'}).trim();
const result=await fake.execute({argv:['gh',...args],cwd:process.cwd(),input:args.includes('--input')?readFileSync(0,'utf8'):undefined});
if(args[1]==='repos/team/repo/issues/3' && !args.includes('POST')) {const ticket=JSON.parse(result.stdout);ticket.labels=[{name:'lane:standard'}];result.stdout=JSON.stringify(ticket);}
writeFileSync(${JSON.stringify(state)},JSON.stringify(fake.state));
process.stdout.write(result.stdout);process.exitCode=result.code;
`,
  );
  await chmod(join(fakebin, "gh"), 0o755);
  const agent = join(dir, "agent.mjs");
  await writeFile(
    agent,
    `import {readFileSync,writeFileSync} from 'node:fs';
const schema=JSON.parse(process.env.ORCH_RESULT_SCHEMA), role=readFileSync(process.env.ORCH_ROLE_FILE,'utf8');
readFileSync(0,'utf8');
const result={outcome:'pass',summary:'fixture role complete'};
if(schema.properties.lane){result.lane='standard';result.implementationTier='standard';}
if(schema.properties.expectedFailures)result.expectedFailures=[{test:'writes change.txt',message:'expected implemented'}];
if(schema.properties.findings)result.findings=[];
if(role.startsWith('You are the implementor'))writeFileSync('change.txt','implemented');
writeFileSync(process.env.ORCH_RESULT_FILE,JSON.stringify(result));console.log(result.summary);
`,
  );
  const workflow = parse(
    await readFile(join(stable, "workflow.default.yaml"), "utf8"),
  );
  for (const step of workflow.steps)
    if (step.kind === "agent") step.runner = "shell";
  workflow.runners.shell.command = `node '${agent}'`;
  workflow.settings.tests = `if test -f change.txt && test "$(cat change.txt)" = implemented; then exit 0; else printf '%s' '{"passed":0,"failures":[{"test":"writes change.txt","message":"expected implemented","kind":"assertion"}],"errors":[]}' > "$ORCH_TEST_REPORT_FILE"; exit 1; fi`;
  await writeFile(
    join(home, ".config/orchestration/workflow.yaml"),
    stringify(workflow),
  );
  expect(await run(["orch", "validate"])).toBe("Workflow valid");
  expect(await run(["orch", "explain", "--simple"])).toContain(
    "Effective workflow",
  );
  expect(await run(["orch", "run", "3"])).toMatch(/merged$/);
  const status = JSON.parse(await run(["orch", "show", "3"]));
  expect(status).toMatchObject({
    status: "merged",
    outcomes: {
      spec: "pass",
      tests: "pass",
      implement: "pass",
      review: "pass",
      report: "pass",
      ci: "passed",
      merge: "merged",
      retire: "pass",
    },
  });
  expect(
    await readFile(
      join(root, ".agents/orchestration/runs/3.explain.html"),
      "utf8",
    ),
  ).toContain("Effective workflow");
  expect(await git(["show", "3:change.txt"])).toBe("implemented");
  expect(await run(["orch", "run", "3"])).toBe("merged");
}
