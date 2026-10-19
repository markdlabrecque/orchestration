import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, type Exec, exec } from "./command.ts";
import type { Project } from "./engine.ts";
import { repositoryFromOrigin } from "./tracker/index.ts";
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
      'source "$1"; orch_resolve || exit; printf "%s\\0%s\\0%s\\0%s\\0%s\\0" "$ORCH_ROOT" "$MAIN_CHECKOUT" "$WORKTREE_ROOT" "$(orch_get "$ORCH_ROOT" BASE_BRANCH)" "$ORCH_STATE"',
      "orch",
      library,
    ],
  });
  const [root, main, worktrees, base, state] = resolved.split("\0");
  if (!base) throw new Error("Missing BASE_BRANCH in .orch");
  const git = (args: string[], dir = main) =>
    checked(execute, { cwd: dir, argv: ["git", ...args] });
  const origin = await git(["config", "--get", "remote.origin.url"]);
  const repository = repositoryFromOrigin(origin);
  const worktree = resolve(worktrees, ticket),
    runs = join(state || join(root, ".agents/orchestration"), "runs");
  return {
    root,
    ...repository,
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
      const ref = `refs/heads/${ticket}`;
      const leaseRef = `refs/orchestration/publish/${ticket}`;
      const observed = await git(
        ["ls-remote", "--refs", "origin", ref],
        worktree,
      );
      const previousHead = observed.split(/\s+/)[0];
      if (previousHead) {
        await git(["fetch", "origin", ref], worktree);
        const savedHead = await git(
          ["for-each-ref", "--format=%(objectname)", leaseRef],
          worktree,
        );
        // A failed push may leave HEAD rebased. Retain the approved old head
        // across retries, but never authorize replacing a different remote head.
        if (savedHead !== previousHead)
          await git(
            ["merge-base", "--is-ancestor", previousHead, "HEAD"],
            worktree,
          );
        await git(["update-ref", leaseRef, previousHead], worktree);
      }
      await git(["fetch", "origin", base], worktree);
      await git(["rebase", `origin/${base}`], worktree);
      await git(
        [
          "push",
          `--force-with-lease=${ref}:${previousHead}`,
          "--set-upstream",
          "origin",
          `HEAD:${ref}`,
        ],
        worktree,
      );
      await git(["update-ref", "-d", leaseRef], worktree);
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
