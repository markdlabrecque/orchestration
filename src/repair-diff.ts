import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked, type Exec } from "./command.ts";

// A private temporary Git index captures tracked and untracked changes without
// touching the user's index. Only tree identities are kept in durable state.
export async function worktreeTree(
  cwd: string,
  execute: Exec,
  signal: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), "orch-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    for (const argv of [
      ["git", "read-tree", "HEAD"],
      ["git", "add", "--all"],
    ])
      await checked(execute, { cwd, argv, env, signal });
    return await checked(execute, {
      cwd,
      argv: ["git", "write-tree"],
      env,
      signal,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
