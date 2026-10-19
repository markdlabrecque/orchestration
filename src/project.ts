import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, type Exec, exec } from "./command.ts";
import type { Project } from "./engine.ts";
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export async function discoverProject(
  cwd: string,
  ticket: string,
  execute: Exec = exec,
): Promise<Project> {
  if (!/^[1-9][0-9]*$/.test(ticket))
    throw new Error("Expected a positive ticket number");
  const library = join(packageRoot, "scripts/orch-project.sh");
  const resolved = await checked(execute, {
    cwd,
    argv: [
      "bash",
      "-c",
      'source "$1"; orch_resolve || exit; printf "%s\\0%s\\0%s\\0%s\\0" "$ORCH_ROOT" "$MAIN_CHECKOUT" "$WORKTREE_ROOT" "$(orch_get "$ORCH_ROOT" BASE_BRANCH)"',
      "orch",
      library,
    ],
  });
  const [root, main, worktrees, base] = resolved.split("\0");
  if (!base) throw new Error("Missing BASE_BRANCH in .orch");
  const git = (args: string[], dir = main) =>
    checked(execute, { cwd: dir, argv: ["git", ...args] });
  const origin = await git(["config", "--get", "remote.origin.url"]);
  const match = origin.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (!match) throw new Error("This slice supports GitHub origins only");
  const worktree = resolve(worktrees, ticket),
    runs = join(root, ".agents/orchestration/runs");
  return {
    root,
    repo: match[1],
    forge: "github",
    main,
    base,
    worktree,
    runs,
    ticket,
    async pickup() {
      await checked(execute, {
        cwd: main,
        argv: [
          "bash",
          join(
            packageRoot,
            "scripts/worktree/create-worktree/scripts/setup-worktree.sh",
          ),
          ticket,
        ],
      });
      await access(worktree);
    },
    async publish(title) {
      // A retry keeps committed edits and never resets the dirty worktree.
      if (await git(["status", "--porcelain"], worktree)) {
        await git(["add", "--all"], worktree);
        await git(["commit", "-m", title], worktree);
      }
      await git(["fetch", "origin", base], worktree);
      await git(["rebase", `origin/${base}`], worktree);
      await git(
        ["push", "--set-upstream", "origin", `HEAD:refs/heads/${ticket}`],
        worktree,
      );
      return git(["rev-parse", "HEAD"], worktree);
    },
    async retire() {
      await checked(execute, {
        cwd: main,
        argv: [
          "bash",
          join(
            packageRoot,
            "scripts/worktree/retire-worktree/scripts/retire-worktree.sh",
          ),
          ticket,
        ],
        env: { ORCH_RETIRE_MANAGED: "1", ORCH_RETIRE_KEEP_BRANCH: "1" },
      });
    },
  };
}
export async function prepareRunDirectory(project: Project) {
  await mkdir(project.runs, { recursive: true });
  return join(project.runs, `${project.ticket}.sqlite`);
}
