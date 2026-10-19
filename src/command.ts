import { spawn } from "node:child_process";
export type CommandRequest = {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
};
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  status: "done" | "aborted" | "timeout";
};
export type Exec = (request: CommandRequest) => Promise<CommandResult>;
export const exec: Exec = async (request) => {
  if (request.signal?.aborted)
    return { code: 1, stdout: "", stderr: "", status: "aborted" };
  return new Promise((resolve, reject) => {
    const child = spawn(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      detached: true,
      stdio: "pipe",
    });
    let stdout = "",
      stderr = "",
      status: CommandResult["status"] = "done";
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
      force = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 250);
    };
    const abort = () => {
      status = "aborted";
      kill();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = request.timeoutMs
      ? setTimeout(() => {
          status = "timeout";
          kill();
        }, request.timeoutMs)
      : undefined;
    child.stdout.on("data", (b) => {
      const text = String(b);
      stdout += text;
      request.onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (b) => {
      const text = String(b);
      stderr += text;
      request.onOutput?.(text, "stderr");
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(force);
      request.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      // Descendants may have redirected stdio and outlived the group leader.
      if (status !== "done") {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr, status });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.input ?? "");
  });
};
export async function checked(
  execute: Exec,
  request: CommandRequest,
): Promise<string> {
  const result = await execute(request);
  if (result.code !== 0 || result.status !== "done")
    throw new Error(
      `${request.argv[0]}: ${result.status}: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
