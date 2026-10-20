// Scripted fake Herdr CLI, modelled on the real Herdr 0.9.1 CLI. Run through the wrapper that
// test/fixtures/fake-herdr.ts creates; see that file's header for the interface. State and the
// invocation log live in $FAKE_HERDR_DIR (state.json, log.jsonl), so every process sees the
// same fake server.
//
// Like the real CLI it rejects options a command does not have (exit 2, "unknown option").
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
  label: string;
  // Present only while the worktree is open in a workspace.
  workspaceId?: string;
  paneId?: string;
  // Internal only: the real list has no dirty field, but remove still refuses dirty trees.
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
type Entry = { args: string[]; code: number; session?: string };
type Result = {
  code: number;
  out?: Record<string, unknown>;
  err?: { code: string; message: string };
};
type Spec = { value: string[]; bool: string[]; required?: string[] };

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

const WT_OPEN_FLAGS = ["focus", "no-focus", "trust-repository"];
const SPECS: Record<string, Spec> = {
  "worktree list": {
    value: ["workspace", "cwd"],
    bool: ["trust-repository"],
  },
  "worktree create": {
    value: ["workspace", "cwd", "branch", "base", "path", "label"],
    bool: WT_OPEN_FLAGS,
    required: ["branch", "base", "path"],
  },
  "worktree open": {
    value: ["workspace", "cwd", "path", "branch", "label"],
    bool: WT_OPEN_FLAGS,
  },
  "worktree remove": {
    value: ["workspace"],
    bool: ["force", "trust-repository"],
    required: ["workspace"],
  },
  "pane read": { value: [], bool: [] },
  "pane get": { value: [], bool: [] },
  "pane report-agent": {
    value: ["source", "agent", "state", "seq"],
    bool: [],
    required: ["seq"],
  },
  "pane release-agent": { value: [], bool: [] },
  "server restart": { value: [], bool: [] },
  "fake mark-dirty": { value: ["branch"], bool: [] },
  "fake close": { value: ["branch"], bool: [] },
};
// Everything after the pane id belongs to the command, flags included.
const RAW = new Set(["pane run", "fake set-output"]);

class UsageError extends Error {}

function parse(key: string, argv: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  if (RAW.has(key)) return { flags, rest: argv };
  const spec = SPECS[key];
  if (!spec) return { flags, rest: argv };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (spec.value.includes(name)) {
      const v = argv[++i];
      if (v === undefined)
        throw new UsageError(`option '--${name}' requires a value`);
      flags[name] = v;
    } else if (spec.bool.includes(name)) flags[name] = true;
    else throw new UsageError(`unknown option '--${name}' for ${key}`);
  }
  for (const r of spec.required ?? [])
    if (flags[r] === undefined)
      throw new UsageError(`missing required option '--${r}' for ${key}`);
  return { flags, rest };
}

const fail = (code: string, message: string): Result => ({
  code: 1,
  err: { code, message },
});
const str = (v: string | true | undefined) =>
  typeof v === "string" ? v : undefined;

function handle(args: string[], s: State): Result {
  const [group, verb, ...tail] = args;
  const { flags, rest } = parse(`${group} ${verb}`, tail);
  const branch = str(flags.branch) ?? "";
  const findWorktree = () =>
    s.worktrees.find(
      (w) =>
        (flags.workspace !== undefined && w.workspaceId === flags.workspace) ||
        (flags.path !== undefined && w.path === flags.path) ||
        (flags.branch !== undefined && w.branch === branch),
    );
  const openWorkspace = (w: Worktree) => {
    if (!w.workspaceId) {
      const n = s.next++;
      w.workspaceId = `w-${n}`;
      w.paneId = `p-${n}`;
      s.panes[w.paneId] = {
        id: w.paneId,
        agentStatus: "unknown",
        lastSeq: -1,
        ran: [],
        output: "",
      };
    }
  };
  const placement = (type: string, w: Worktree) => ({
    code: 0,
    out: {
      type,
      root_pane: { pane_id: w.paneId },
      workspace: { workspace_id: w.workspaceId },
      worktree: { branch: w.branch, path: w.path, label: w.label },
    },
  });

  if (group === "worktree") {
    if (verb === "list")
      return {
        code: 0,
        out: {
          type: "worktree_list",
          worktrees: s.worktrees.map((w) => ({
            branch: w.branch,
            path: w.path,
            label: w.label,
            is_linked_worktree: true,
            ...(w.workspaceId ? { open_workspace_id: w.workspaceId } : {}),
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
      if (s.worktrees.some((w) => w.branch === branch))
        return fail(
          "worktree_create_failed",
          `worktree ${branch} already exists`,
        );
      const wt: Worktree = {
        branch,
        base: str(flags.base) ?? "main",
        path: str(flags.path) ?? `/wt/${branch}`,
        label: str(flags.label) ?? branch,
        dirty: false,
      };
      s.worktrees.push(wt);
      openWorkspace(wt);
      return placement("worktree_created", wt);
    }
    if (verb === "open") {
      const w = findWorktree();
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      openWorkspace(w);
      return placement("worktree_opened", w);
    }
    if (verb === "remove") {
      if (flags.force)
        s.violations.push(
          `no-force: worktree remove ${flags.workspace} passed --force`,
        );
      const w = s.worktrees.find((x) => x.workspaceId === flags.workspace);
      if (!w)
        return fail("workspace_not_found", `no workspace ${flags.workspace}`);
      if (w.dirty && !flags.force)
        return fail(
          "dirty_worktree_requires_force",
          `worktree ${w.branch} has changes`,
        );
      s.worktrees = s.worktrees.filter((x) => x !== w);
      if (w.paneId) delete s.panes[w.paneId];
      return { code: 0, out: { type: "worktree_removed" } };
    }
  }

  if (group === "pane") {
    const id = rest[0];
    const pane = id ? s.panes[id] : undefined;
    if (!pane) return fail("pane_not_found", `no pane ${id}`);
    if (verb === "run") {
      pane.ran.push(rest.slice(1).join(" "));
      return { code: 0, out: { type: "ok" } };
    }
    if (verb === "read")
      return { code: 0, out: { type: "pane_read", text: pane.output } };
    if (verb === "get")
      return {
        code: 0,
        out: {
          type: "pane_info",
          pane: { pane_id: pane.id, agent_status: pane.agentStatus },
        },
      };
    if (verb === "report-agent") {
      const seq = Number(flags.seq);
      if (!Number.isFinite(seq))
        return fail("invalid_args", "--seq is required");
      if (seq <= pane.lastSeq)
        return { code: 0, out: { type: "agent_reported", ignored: true } };
      pane.lastSeq = seq;
      pane.agentStatus = str(flags.state) ?? "unknown";
      return { code: 0, out: { type: "agent_reported", ignored: false } };
    }
    if (verb === "release-agent") {
      pane.agentStatus = "unknown";
      return { code: 0, out: { type: "ok" } };
    }
  }

  if (group === "server" && verb === "restart") {
    // Workspaces survive; reported agent state and the seq counter do not.
    for (const p of Object.values(s.panes)) {
      p.agentStatus = "unknown";
      p.lastSeq = -1;
    }
    return { code: 0, out: { type: "ok" } };
  }

  // Test-only verbs: not part of the real Herdr CLI.
  if (group === "fake") {
    const w = s.worktrees.find((x) => x.branch === branch);
    if (verb === "mark-dirty") {
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      w.dirty = true;
      return { code: 0, out: { type: "ok" } };
    }
    if (verb === "close") {
      // Close the workspace but keep the worktree on disk.
      if (!w) return fail("worktree_not_found", `no worktree for ${branch}`);
      if (w.paneId) delete s.panes[w.paneId];
      w.workspaceId = undefined;
      w.paneId = undefined;
      return { code: 0, out: { type: "ok" } };
    }
    if (verb === "set-output") {
      const pane = s.panes[rest[0]];
      if (!pane) return fail("pane_not_found", `no pane ${rest[0]}`);
      pane.output = rest.slice(1).join(" ");
      return { code: 0, out: { type: "ok" } };
    }
  }
  return fail("unknown_command", `unknown command: ${args.join(" ")}`);
}

// The global --session option comes before the command, as in `herdr --session <name> ...`.
let argv = process.argv.slice(2);
let session: string | undefined;
if (argv[0] === "--session") {
  session = argv[1];
  argv = argv.slice(2);
}
const state = load();
const id = `fake-${prior.length + 1}`;
let result: Result;
try {
  result = handle(argv, state);
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  result = { code: 2, err: { code: "invalid_args", message: error.message } };
}
writeFileSync(stateFile, JSON.stringify(state));
const entry: Entry = { args: argv, code: result.code };
if (session !== undefined) entry.session = session;
appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
if (result.err)
  process.stderr.write(`${JSON.stringify({ error: result.err, id })}\n`);
else process.stdout.write(`${JSON.stringify({ id, result: result.out })}\n`);
process.exit(result.code);
