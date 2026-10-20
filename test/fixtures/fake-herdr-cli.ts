// Scripted fake Herdr CLI. Run through the wrapper that test/fixtures/fake-herdr.ts creates;
// see that file's header for the interface. State and the invocation log live in
// $FAKE_HERDR_DIR (state.json, log.jsonl), so every process sees the same fake server.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type Worktree = {
  branch: string;
  base: string;
  path: string;
  workspaceId: string;
  paneId: string;
  dirty: boolean;
};
type Pane = {
  id: string;
  agentStatus: string;
  lastSeq: number;
  ran: string[];
  output: string;
};
type State = {
  next: number;
  worktrees: Worktree[];
  panes: Record<string, Pane>;
  violations: string[];
};
type Entry = { args: string[]; code: number };
type Result = {
  code: number;
  out?: unknown;
  err?: { code: string; message: string };
};

const dir = process.env.FAKE_HERDR_DIR;
if (!dir) {
  process.stderr.write("FAKE_HERDR_DIR is required\n");
  process.exit(2);
}
const stateFile = join(dir, "state.json");
const logFile = join(dir, "log.jsonl");
const load = (): State =>
  existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { next: 1, worktrees: [], panes: {}, violations: [] };
const prior: Entry[] = existsSync(logFile)
  ? readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];

const VALUE_FLAGS = new Set([
  "branch",
  "base",
  "path",
  "source",
  "agent",
  "state",
  "seq",
]);
function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) flags[key] = argv[++i] ?? "";
      else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const fail = (code: string, message: string): Result => ({
  code: 1,
  err: { code, message },
});

function handle(args: string[], s: State): Result {
  const [group, verb, ...tail] = args;
  const { flags, rest } = parse(tail);
  const branch = typeof flags.branch === "string" ? flags.branch : "";
  const find = () => s.worktrees.find((w) => w.branch === branch);

  if (group === "worktree") {
    if (verb === "list")
      return {
        code: 0,
        out: {
          ok: true,
          worktrees: s.worktrees.map((w) => ({
            branch: w.branch,
            path: w.path,
            workspace_id: w.workspaceId,
            dirty: w.dirty,
          })),
        },
      };
    if (verb === "create") {
      const seen = prior.some(
        (e) =>
          e.args[0] === "worktree" &&
          (e.args[1] === "list" || e.args[1] === "open"),
      );
      if (!seen)
        s.violations.push(
          `list-before-create: create ${branch} without a prior worktree list or open`,
        );
      if (find())
        return fail(
          "worktree_create_failed",
          `worktree ${branch} already exists`,
        );
      const n = s.next++;
      const wt: Worktree = {
        branch,
        base: typeof flags.base === "string" ? flags.base : "main",
        path: typeof flags.path === "string" ? flags.path : `/wt/${branch}`,
        workspaceId: `w-${n}`,
        paneId: `p-${n}`,
        dirty: false,
      };
      s.worktrees.push(wt);
      s.panes[wt.paneId] = {
        id: wt.paneId,
        agentStatus: "unknown",
        lastSeq: -1,
        ran: [],
        output: "",
      };
      return {
        code: 0,
        out: {
          ok: true,
          workspace_id: wt.workspaceId,
          pane_id: wt.paneId,
          path: wt.path,
        },
      };
    }
    if (verb === "open") {
      const w = find();
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      return {
        code: 0,
        out: {
          ok: true,
          workspace_id: w.workspaceId,
          pane_id: w.paneId,
          path: w.path,
        },
      };
    }
    if (verb === "remove") {
      if (flags.force)
        s.violations.push(`no-force: worktree remove ${branch} passed --force`);
      const w = find();
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      if (w.dirty && !flags.force)
        return fail(
          "dirty_worktree_requires_force",
          `worktree ${branch} has changes`,
        );
      s.worktrees = s.worktrees.filter((x) => x !== w);
      delete s.panes[w.paneId];
      return { code: 0, out: { ok: true } };
    }
  }

  if (group === "pane") {
    const id = rest[0];
    const pane = id ? s.panes[id] : undefined;
    if (!pane) return fail("pane_not_found", `no pane ${id}`);
    if (verb === "run") {
      pane.ran.push(rest.slice(1).join(" "));
      return { code: 0, out: { ok: true } };
    }
    if (verb === "read")
      return { code: 0, out: { ok: true, text: pane.output } };
    if (verb === "get")
      return {
        code: 0,
        out: { ok: true, pane_id: pane.id, agent_status: pane.agentStatus },
      };
    if (verb === "report-agent") {
      const seq = Number(flags.seq);
      if (!Number.isFinite(seq))
        return fail("invalid_args", "--seq is required");
      if (seq <= pane.lastSeq)
        return { code: 0, out: { ok: true, ignored: true } };
      pane.lastSeq = seq;
      pane.agentStatus = String(flags.state ?? "unknown");
      return { code: 0, out: { ok: true, ignored: false } };
    }
    if (verb === "release-agent") {
      pane.agentStatus = "unknown";
      return { code: 0, out: { ok: true } };
    }
  }

  if (group === "server" && verb === "restart") {
    // Workspaces survive; reported agent state and the seq counter do not.
    for (const p of Object.values(s.panes)) {
      p.agentStatus = "unknown";
      p.lastSeq = -1;
    }
    return { code: 0, out: { ok: true } };
  }

  // Test-only verbs: not part of the real Herdr CLI.
  if (group === "fake") {
    if (verb === "mark-dirty") {
      const w = find();
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      w.dirty = true;
      return { code: 0, out: { ok: true } };
    }
    if (verb === "set-output") {
      const pane = s.panes[rest[0]];
      if (!pane) return fail("pane_not_found", `no pane ${rest[0]}`);
      pane.output = rest.slice(1).join(" ");
      return { code: 0, out: { ok: true } };
    }
  }
  return fail("unknown_command", `unknown command: ${args.join(" ")}`);
}

const args = process.argv.slice(2);
const state = load();
const result = handle(args, state);
writeFileSync(stateFile, JSON.stringify(state));
appendFileSync(logFile, `${JSON.stringify({ args, code: result.code })}\n`);
if (result.err)
  process.stderr.write(`${JSON.stringify({ ok: false, error: result.err })}\n`);
else process.stdout.write(`${JSON.stringify(result.out)}\n`);
process.exit(result.code);
