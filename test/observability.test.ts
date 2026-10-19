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
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import type { Exec } from "../src/command.ts";

test("show and tail read live projections without opening SQLite or loading workflow tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-observe-"));
  const runs = join(root, ".agents/orchestration/runs");
  await mkdir(runs, { recursive: true });
  const execute: Exec = async ({ argv }) => ({
    code: 0,
    status: "done",
    stderr: "",
    stdout:
      argv[0] === "bash"
        ? `${root}\0${root}\0${root}/code\0main\0`
        : "https://github.com/a/b.git",
  });
  const status = {
    version: 1,
    ticket: "144",
    status: "running",
    currentStep: "implement",
    outcomes: { spec: "pass" },
    resumptions: 2,
    crashes: { implement: 1 },
    budgets: { bounces: { spent: 3, grants: 1 } },
  };
  try {
    await writeFile(join(runs, "144.sqlite"), "must never be opened");
    await writeFile(join(runs, "144.status.json"), JSON.stringify(status));
    const output: string[] = [];
    expect(
      await runCli(["show", "144"], {
        cwd: root,
        execute,
        output: (s) => output.push(s),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0])).toEqual(status);
    const first = { version: 1, type: "text", data: "full transcript" };
    const second = { version: 1, type: "status", data: { status: "paused" } };
    await writeFile(
      join(runs, "144.events.jsonl"),
      `${JSON.stringify(first)}\n{"version":1`,
    );
    const controller = new AbortController();
    const events: unknown[] = [];
    const tail = runCli(["tail", "144"], {
      cwd: root,
      execute,
      signal: controller.signal,
      output: (s) => {
        events.push(JSON.parse(s));
        if (events.length === 1)
          void appendFile(
            join(runs, "144.events.jsonl"),
            ',"type":"status","data":{"status":"paused"}}\n',
          );
        if (events.length === 2) controller.abort();
      },
    });
    expect(await tail).toBe(0);
    expect(events).toEqual([first, second]);
    expect(await readFile(join(runs, "144.sqlite"), "utf8")).toBe(
      "must never be opened",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
