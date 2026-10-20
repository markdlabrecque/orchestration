import { AdapterError } from "./errors.ts";
import { run } from "./process.ts";

export type WorktreeInfo = {
  branch: string;
  path: string;
  // Absent when the worktree is not open in a workspace. The real list has no dirty field.
  open_workspace_id?: string;
};
export type Placement = { workspace_id: string; pane_id: string; path: string };
export type AgentState = "idle" | "working" | "blocked" | "unknown";

export type Herdr = ReturnType<typeof createHerdr>;

// Thin wrapper over the herdr 0.9.1 CLI. Success prints {id,result} on stdout; failure prints
// {error:{code,message},id} and exits non-zero. This wrapper has no way to pass --force:
// release is refused for a dirty tree (dirty_worktree_requires_force) instead.
export function createHerdr(options: {
  bin: string;
  env?: Record<string, string>;
  // Named Herdr session (`--session`); never the default session when set.
  session?: string;
  // The repository, passed as `--cwd` to worktree list/create/open.
  repo?: string;
  paneRunTimeoutMs?: number;
}) {
  const globals = options.session ? ["--session", options.session] : [];
  const cwd = options.repo ? ["--cwd", options.repo] : [];
  // biome-ignore lint/suspicious/noExplicitAny: Herdr JSON shapes vary per command
  const call = async (args: string[], timeoutMs?: number): Promise<any> => {
    const r = await run(options.bin, [...globals, ...args], {
      env: options.env,
      timeoutMs,
    });
    if (r.timedOut)
      throw new AdapterError(
        "timeout",
        `herdr ${args[0]} ${args[1]} timed out`,
      );
    if (r.code === 0) {
      try {
        return JSON.parse(r.stdout).result ?? {};
      } catch {
        return {};
      }
    }
    let error: { code?: string; message?: string } | undefined;
    for (const text of [r.stderr, r.stdout]) {
      try {
        error ??= JSON.parse(text).error;
      } catch {}
    }
    throw new AdapterError(
      error?.code ?? "herdr-failed",
      error?.message ?? `herdr ${args.join(" ")} exited ${r.code}`,
    );
  };
  // biome-ignore lint/suspicious/noExplicitAny: Herdr JSON shapes vary per command
  const placement = (result: any): Placement => ({
    workspace_id: result.workspace.workspace_id,
    pane_id: result.root_pane.pane_id,
    path: result.worktree.path,
  });
  return {
    async worktreeList(): Promise<WorktreeInfo[]> {
      return (await call(["worktree", "list", ...cwd])).worktrees;
    },
    async worktreeCreate(spec: {
      branch: string;
      base: string;
      path: string;
    }): Promise<Placement> {
      return placement(
        await call([
          "worktree",
          "create",
          ...cwd,
          "--branch",
          spec.branch,
          "--base",
          spec.base,
          "--path",
          spec.path,
          "--no-focus",
        ]),
      );
    },
    async worktreeOpen(branch: string): Promise<Placement> {
      return placement(
        await call([
          "worktree",
          "open",
          ...cwd,
          "--branch",
          branch,
          "--no-focus",
        ]),
      );
    },
    // By workspace id: the real remove has no --branch and no --cwd.
    worktreeRemove: (workspaceId: string) =>
      call(["worktree", "remove", "--workspace", workspaceId]),
    paneRun: (pane: string, command: string[]) =>
      call(
        ["pane", "run", pane, ...command],
        options.paneRunTimeoutMs ?? 30_000,
      ),
    async paneAgentStatus(pane: string): Promise<string> {
      return (await call(["pane", "get", pane])).pane.agent_status;
    },
    reportAgent: (pane: string, state: AgentState, seq: number) =>
      call([
        "pane",
        "report-agent",
        pane,
        "--source",
        "orch",
        "--agent",
        "orch",
        "--state",
        state,
        "--seq",
        String(seq),
      ]),
  };
}
