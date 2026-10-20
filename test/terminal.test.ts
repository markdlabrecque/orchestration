import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const driver = fileURLToPath(
  new URL("./fixtures/terminal-run.ts", import.meta.url),
);
function launch(
  dir: string,
  args: string[],
  onOutput?: (text: string, child: ReturnType<typeof spawn>) => void,
) {
  const child = spawn(process.execPath, [driver, dir, ...args]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
    onOutput?.(stdout, child);
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  return new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
test("CLI orderly pause, abort, final state and retirement retain status and transcript history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-terminal-"));
  try {
    await mkdir(join(dir, "code/144"), { recursive: true });
    await writeFile(
      join(dir, "workflow.yaml"),
      `version: 1
runners:
  shell:
    command: 'printf intermediate; sleep 30'
steps:
  - {id: implement, kind: agent, runner: shell, role: implementor}
`,
    );
    let interrupted = false;
    const paused = await launch(dir, ["run", "144"], (text, child) => {
      if (!interrupted && text.includes("Step implement")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    expect(paused, paused.stderr).toMatchObject({ code: 0 });
    expect(paused.stdout).toContain("paused");
    await rm(join(dir, "workflow.yaml"));
    expect(
      await launch(dir, ["abort", "144", "--fixture-crash-abort"]),
    ).toMatchObject({ signal: "SIGKILL" });
    const aborted = await launch(dir, ["run", "144"]);
    expect(aborted, aborted.stderr).toMatchObject({ code: 0 });
    expect(aborted.stdout).toContain("aborted");
    expect((await launch(dir, ["run", "144"])).stdout).toContain("aborted");
    const before = await readFile(
      join(dir, ".agents/orchestration/runs/144.events.jsonl"),
      "utf8",
    );
    const crashed = await launch(dir, [
      "retire",
      "144",
      "--fixture-crash-retire",
    ]);
    expect(crashed).toMatchObject({ signal: "SIGKILL" });
    await appendFile(
      join(dir, ".agents/orchestration/runs/144.events.jsonl"),
      '{"version":1',
    );
    const retired = await launch(dir, ["retire", "144"]);
    expect(retired, retired.stderr).toMatchObject({ code: 0 });
    expect(await readFile(join(dir, "retired"), "utf8")).toBe("retired\n");
    expect(
      (
        await readFile(
          join(dir, ".agents/orchestration/runs/144.events.jsonl"),
          "utf8",
        )
      ).startsWith(before),
    ).toBe(true);
    const recoveredEvents = await readFile(
      join(dir, ".agents/orchestration/runs/144.events.jsonl"),
      "utf8",
    );
    expect(
      recoveredEvents
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line).version === 1),
    ).toBe(true);
    const shown = await launch(dir, ["show", "144"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      version: 1,
      status: "aborted",
      crashes: { abort: 1, retire: 1 },
      retirement: { status: "done" },
    });
    expect(
      (await readFile(join(dir, "abort-comments"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);

test("CLI requires --retry after three process crashes and shows final completion without restarting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-terminal-crash-"));
  try {
    await mkdir(join(dir, "code/144"), { recursive: true });
    await writeFile(
      join(dir, "workflow.yaml"),
      `version: 1
steps:
  - {id: approval, kind: human, options: {ask: 'Proceed?', choices: [yes, no]}}
`,
    );
    for (let i = 0; i < 3; i++) {
      let killed = false;
      expect(
        await launch(dir, ["run", "144"], (text, child) => {
          if (!killed && text.includes("Proceed?")) {
            killed = true;
            child.kill("SIGKILL");
          }
        }),
      ).toMatchObject({ signal: "SIGKILL" });
    }
    const blocked = await launch(dir, ["run", "144"]);
    expect(blocked).toMatchObject({ code: 1 });
    expect(blocked.stdout).toContain("--retry");
    let answered = false;
    const retried = await launch(
      dir,
      ["run", "--retry", "144"],
      (text, child) => {
        if (!answered && text.includes("Proceed?")) {
          answered = true;
          child.stdin?.write("yes\n");
        }
      },
    );
    expect(retried, retried.stderr).toMatchObject({ code: 0 });
    expect(retried.stdout).toContain("completed");
    await rm(join(dir, "workflow.yaml"));
    expect((await launch(dir, ["run", "144"])).stdout).toBe("completed\n");
    expect(
      JSON.parse((await launch(dir, ["show", "144"])).stdout),
    ).toMatchObject({
      status: "completed",
      crashes: { approval: 3 },
      resumptions: 3,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);

test("SIGHUP and SIGTERM pause a running step orderly", async () => {
  for (const sig of ["SIGHUP", "SIGTERM"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "orch-signal-"));
    try {
      await mkdir(join(dir, "code/144"), { recursive: true });
      await writeFile(
        join(dir, "workflow.yaml"),
        `version: 1
runners:
  shell:
    command: 'printf intermediate; sleep 30'
steps:
  - {id: implement, kind: agent, runner: shell, role: implementor}
`,
      );
      let sent = false;
      const paused = await launch(dir, ["run", "144"], (text, child) => {
        if (!sent && text.includes("Step implement")) {
          sent = true;
          child.kill(sig);
        }
      });
      expect(paused, paused.stderr).toMatchObject({ code: 0 });
      expect(paused.stdout).toContain("paused");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 20_000);
