import { AdapterError } from "./errors.ts";
import { run } from "./process.ts";

export type WorktreeInfo = {
  branch: string;
  path: string;
  workspace_id: string;
  dirty: boolean;
};
export type Placement = { workspace_id: string; pane_id: string; path: string };
export type AgentState = "idle" | "working" | "blocked" | "unknown";

export type Herdr = ReturnType<typeof createHerdr>;

// Thin wrapper over the herdr CLI. Failures print {ok:false,error:{code,message}} on stderr.
// This wrapper has no way to pass --force: release is refused for a dirty tree instead.
export function createHerdr(options: {
  bin: string;
  env?: Record<string, string>;
  paneRunTimeoutMs?: number;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: Herdr JSON shapes vary per command
  const call = async (args: string[], timeoutMs?: number): Promise<any> => {
    const r = await run(options.bin, args, { env: options.env, timeoutMs });
    if (r.timedOut)
      throw new AdapterError(
        "timeout",
        `herdr ${args[0]} ${args[1]} timed out`,
      );
    if (r.code === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { ok: true };
      }
    }
    let error: { code?: string; message?: string } | undefined;
    try {
      error = JSON.parse(r.stderr).error;
    } catch {}
    throw new AdapterError(
      error?.code ?? "herdr-failed",
      error?.message ?? `herdr ${args.join(" ")} exited ${r.code}`,
    );
  };
  return {
    async worktreeList(): Promise<WorktreeInfo[]> {
      return (await call(["worktree", "list"])).worktrees;
    },
    worktreeCreate: (branch: string): Promise<Placement> =>
      call(["worktree", "create", "--branch", branch]),
    worktreeOpen: (branch: string): Promise<Placement> =>
      call(["worktree", "open", "--branch", branch]),
    worktreeRemove: (branch: string) =>
      call(["worktree", "remove", "--branch", branch]),
    paneRun: (pane: string, command: string[]) =>
      call(
        ["pane", "run", pane, ...command],
        options.paneRunTimeoutMs ?? 30_000,
      ),
    async paneAgentStatus(pane: string): Promise<string> {
      return (await call(["pane", "get", pane])).agent_status;
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
