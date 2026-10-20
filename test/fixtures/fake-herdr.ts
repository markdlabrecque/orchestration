// Scripted fake Herdr for tests (#172); reused by the #173 adapter tests.
//
// createFakeHerdr() makes a temp dir holding the fake server state (state.json) and an
// invocation log (log.jsonl), plus an executable wrapper `bin` that runs
// test/fixtures/fake-herdr-cli.ts. Point an adapter at `bin` and pass `env` to its child
// processes, or call `exec(args)` directly. Every invocation (including failures) is logged.
//
// Commands answered (JSON on stdout, exit 0; failures print {ok:false,error:{code,message}}
// on stderr and exit 1):
//   worktree list                              -> {ok, worktrees:[{branch,path,workspace_id,dirty}]}
//   worktree create --branch B [--base X] [--path P]
//                                              -> {ok, workspace_id, pane_id, path}
//                                                 NOT idempotent: repeat fails worktree_create_failed
//   worktree open --branch B                   -> same shape as create; worktree_not_found if absent
//   worktree remove --branch B [--force]       -> dirty tree without --force fails
//                                                 dirty_worktree_requires_force
//   pane run <pane> <cmd...>                   -> {ok}; recorded (see ran()); pane_not_found if absent
//   pane read <pane>                           -> {ok, text}
//   pane get <pane>                            -> {ok, pane_id, agent_status}
//   pane report-agent <pane> --source S --agent A --state ST --seq N
//                                              -> {ok, ignored}; seq <= last seq is ignored
//   pane release-agent <pane>                  -> {ok}; agent_status back to "unknown"
//   server restart                             -> workspaces survive; agent_status resets to
//                                                 "unknown" and the seq counter resets
//
// Helper API (FakeHerdr):
//   bin, env                 executable path and env ({FAKE_HERDR_DIR}) for child processes
//   exec(args)               run one command -> {code, stdout, stderr, json, error}
//   markDirty(branch)        make a worktree dirty (not logged)
//   setOutput(pane, text)    script what `pane read` returns (not logged)
//   ran(pane)                commands sent with `pane run`
//   restart()                simulate a server restart
//   note(kind, ...detail)    log a non-Herdr event; use note("receipt-query", requestId)
//                            when the adapter queries `orch request`
//   log(), violations()      invocation log and rule violations the fake itself detected
//   reset(), cleanup()       clear state/log; remove the temp dir
//
// Rule assertions (throw with a descriptive message):
//   assertListBeforeCreate(log)            every worktree create is preceded by list or open
//   assertNoForce(log)                     no invocation passed --force
//   assertReceiptsQueriedBeforeResend(log) a repeated identical `pane run` needs a
//                                          receipt-query note between the two sends
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type LogEntry = { args: string[]; code: number; note?: boolean };

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  // Parsed stdout on success.
  // biome-ignore lint/suspicious/noExplicitAny: test fixture, shapes vary per command
  json: any;
  // The `error` object parsed from stderr on failure.
  // biome-ignore lint/suspicious/noExplicitAny: test fixture, shapes vary per error
  error: any;
};

export type FakeHerdr = ReturnType<typeof createFakeHerdr>;

const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-herdr-cli.ts",
);

export function createFakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "log.jsonl");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\nexec node --no-warnings "${cliPath}" "$@"\n`);
  chmodSync(bin, 0o755);
  const env = { FAKE_HERDR_DIR: dir };

  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const editState = (fn: (s: ReturnType<typeof readState>) => void) => {
    const s = readState();
    fn(s);
    writeFileSync(stateFile, JSON.stringify(s));
  };
  const parse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const fake = {
    dir,
    bin,
    env,
    exec(args: string[]): ExecResult {
      const r = spawnSync(bin, args, {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
      return {
        code: r.status ?? -1,
        stdout: r.stdout,
        stderr: r.stderr,
        json: parse(r.stdout),
        error: parse(r.stderr)?.error,
      };
    },
    markDirty(branch: string) {
      editState((s) => {
        for (const w of s.worktrees) if (w.branch === branch) w.dirty = true;
      });
    },
    setOutput(pane: string, text: string) {
      editState((s) => {
        if (s.panes[pane]) s.panes[pane].output = text;
      });
    },
    ran(pane: string): string[] {
      return readState().panes[pane]?.ran ?? [];
    },
    restart() {
      return fake.exec(["server", "restart"]);
    },
    note(kind: string, ...detail: string[]) {
      writeFileSync(
        logFile,
        `${JSON.stringify({ args: [kind, ...detail], code: 0, note: true })}\n`,
        { flag: "a" },
      );
    },
    log(): LogEntry[] {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    violations(): string[] {
      return existsSync(stateFile) ? readState().violations : [];
    },
    reset() {
      rmSync(stateFile, { force: true });
      rmSync(logFile, { force: true });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return fake;
}

const isCmd = (e: LogEntry, group: string, verb: string) =>
  !e.note && e.args[0] === group && e.args[1] === verb;

export function assertListBeforeCreate(log: LogEntry[]) {
  log.forEach((e, i) => {
    if (!isCmd(e, "worktree", "create")) return;
    const seen = log
      .slice(0, i)
      .some(
        (p) => isCmd(p, "worktree", "list") || isCmd(p, "worktree", "open"),
      );
    if (!seen)
      throw new Error(
        `worktree create (${e.args.join(" ")}) without a prior worktree list or open`,
      );
  });
}

export function assertNoForce(log: LogEntry[]) {
  for (const e of log)
    if (!e.note && e.args.includes("--force"))
      throw new Error(`--force was passed: ${e.args.join(" ")}`);
}

export function assertReceiptsQueriedBeforeResend(log: LogEntry[]) {
  const lastSend = new Map<string, number>();
  log.forEach((e, i) => {
    if (!isCmd(e, "pane", "run")) return;
    const key = e.args.slice(2).join(" ");
    const prev = lastSend.get(key);
    if (prev !== undefined) {
      const queried = log
        .slice(prev + 1, i)
        .some((n) => n.note && n.args[0] === "receipt-query");
      if (!queried)
        throw new Error(
          `pane run re-sent without a receipt query first: ${key}`,
        );
    }
    lastSend.set(key, i);
  });
}
