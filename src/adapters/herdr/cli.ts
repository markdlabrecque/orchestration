import { createAdapter } from "./adapter.ts";
import { requireCapability } from "./declaration.ts";
import { resolveBin } from "./discovery.ts";
import { AdapterError } from "./errors.ts";
import { createHerdr } from "./herdr.ts";
import { checkContract, createOrch } from "./orch.ts";
import { run } from "./process.ts";

const USAGE =
  "Usage: orch-herdr run <ticket> [--branch <branch>] [--base <ref>] [--worktree-path <path>] [--session <name>] [--interval <ms>] [--owner-lifetime host-bound] | orch-herdr release <ticket> [--branch <branch>] [--session <name>] (HERDR_SESSION is the --session fallback)";

// The project's main branch: origin's HEAD when known, else main.
async function mainBranch(
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  try {
    const r = await run(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd, env },
    );
    if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "") || "main";
  } catch {}
  return "main";
}

// Entry point behind bin/orch-herdr. Returns the process exit code.
export async function main(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    output?: (text: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const output = options.output ?? console.log;
  const [command, ticket, ...rest] = argv;
  try {
    if ((command !== "run" && command !== "release") || !ticket)
      throw new AdapterError("usage", USAGE);
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const features = [
      ...(rest.includes("--question-presentation")
        ? ["question-presentation"]
        : []),
      ...(rest.includes("--notifications") ? ["notifications"] : []),
    ];
    requireCapability({ ownerLifetime: flag("--owner-lifetime"), features });
    const cwd = options.cwd ?? process.cwd();
    const orchBin = resolveBin("orch", "ORCH_BIN", env);
    const childEnv = Object.fromEntries(
      Object.entries(env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    const orch = createOrch({ bin: orchBin, cwd, env: childEnv });
    await checkContract(orch);
    const session = flag("--session") ?? env.HERDR_SESSION ?? undefined;
    const adapter = createAdapter({
      herdr: createHerdr({
        bin: resolveBin("herdr", "HERDR_BIN", env),
        env: childEnv,
        session: session || undefined,
        repo: cwd,
      }),
      repo: cwd,
      base: flag("--base") ?? (await mainBranch(cwd, childEnv)),
      worktreePath: flag("--worktree-path"),
      orch,
      orchBin,
      paneEnv: Object.fromEntries(
        ["ORCH_PROJECTS_DIR", "ORCH_BIN"].flatMap((k) => {
          const v = env[k];
          return v ? [[k, v]] : [];
        }),
      ),
      ticket,
      branch: flag("--branch") ?? `ticket-${ticket}`,
    });
    if (command === "release") {
      await adapter.release();
      output(JSON.stringify({ ok: true }));
      return 0;
    }
    const started = await adapter.start();
    output(JSON.stringify({ ok: true, ...started }));
    const interval = Number(flag("--interval") ?? 2000);
    let seenWorking = false;
    while (!options.signal?.aborted) {
      const { state } = await adapter.poll();
      if (state === "working") seenWorking = true;
      else if (seenWorking && state !== "unknown") break;
      await new Promise((r) => setTimeout(r, interval));
    }
    return 0;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    output(
      JSON.stringify({
        ok: false,
        error: { code: e.code ?? "error", message: e.message ?? String(error) },
      }),
    );
    return 1;
  }
}
