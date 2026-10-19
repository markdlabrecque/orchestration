import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checked, exec } from "../src/command.ts";

const driver = fileURLToPath(
  new URL("./fixtures/repair-crash.ts", import.meta.url),
);
async function child(dir: string, mode: string) {
  return new Promise<{
    code: number | null;
    signal: string | null;
    stderr: string;
  }>((resolve, reject) => {
    const p = spawn(process.execPath, [driver, dir, mode]);
    let stderr = "";
    p.stderr.on("data", (b) => {
      stderr += b;
    });
    p.on("error", reject);
    p.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
test.each([
  "pi",
  "shell",
  "filing",
])("SIGKILL during %s resumes a real repair without spending again or refiling", async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), "orch-repair-crash-"));
  try {
    const cwd = join(dir, "worktree");
    await mkdir(cwd);
    for (const argv of [
      ["git", "init", "-b", "main"],
      ["git", "config", "user.name", "Fixture"],
      ["git", "config", "user.email", "fixture@example.com"],
      ["git", "config", "core.hooksPath", "/dev/null"],
    ])
      await checked(exec, { cwd, argv });
    await writeFile(join(cwd, "item"), "broken\n");
    await checked(exec, { cwd, argv: ["git", "add", "."] });
    await checked(exec, { cwd, argv: ["git", "commit", "-m", "fixture"] });
    await writeFile(
      join(dir, "agent.mjs"),
      `
import fs from 'node:fs';
const role=fs.readFileSync(process.env.ORCH_ROLE_FILE,'utf8');
const brief=fs.readFileSync(0,'utf8');
const review=role.startsWith('reviewer');
fs.appendFileSync(${JSON.stringify(join(dir, "agent-calls"))},review?'review\\n':'repair\\n');
const fixed=fs.readFileSync('item','utf8')==='fixed\\n';
let result;
if(review) {
  if(fixed && (!brief.includes('-broken') || !brief.includes('+fixed'))) throw new Error('Missing real repair diff');
  result=fixed ? {outcome:'pass',summary:'confirmed',findings:${mode === "filing" ? "[{summary:'later work',evidence:'item',classification:'must-fix'}]" : "[]"},decisions:[{id:'F1',status:'fixed',reason:'file is fixed'}]}
    : {outcome:'findings',summary:'broken',findings:[{summary:'fix item',evidence:'item',classification:'must-fix'}]};
} else {
  fs.writeFileSync('item','fixed\\n');
  if(!fs.existsSync(${JSON.stringify(join(dir, "crashed"))}) && ${JSON.stringify(mode)}==='shell') {
    console.log('ready-to-crash');
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
  result={outcome:'pass',summary:'fixed',responses:[{id:'F1',action:'changed',reason:'wrote fixed'}]};
}
fs.writeFileSync(process.env.ORCH_RESULT_FILE,JSON.stringify(result));
`,
    );
    expect(await child(dir, mode)).toMatchObject({ signal: "SIGKILL" });
    const resumed = await child(dir, mode);
    expect(resumed.code, resumed.stderr).toBe(0);
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    expect(result.status, result.reason).toBe("completed");
    expect(result.budgets.bounces).toEqual({ spent: 1, grants: 0 });
    expect(result.findings[0]).toMatchObject({ id: "F1", status: "fixed" });
    expect(await readFile(join(cwd, "item"), "utf8")).toBe("fixed\n");
    expect(
      (await readFile(join(dir, "agent-calls"), "utf8"))
        .split("\n")
        .filter((v) => v === "review"),
    ).toHaveLength(2);
    if (mode === "filing") {
      expect(await readFile(join(dir, "writes"), "utf8")).toBe("write\n");
      expect(result.findings[1]).toMatchObject({
        id: "F2",
        filing: "linked",
        link: { id: "99" },
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
