import { checked, type Exec, exec } from "../command.ts";
import type { Identity, Tracker } from "./types.ts";

type Remote = {
  id: number;
  number: number;
  html_url: string;
  body: string;
  title: string;
  labels?: { name: string }[];
  head: { sha: string };
  merged: boolean;
};
const identity = (r: Remote): Identity => ({
  id: String(r.number ?? r.id),
  url: r.html_url,
});
export function createGitHubTracker(
  repo: string,
  cwd: string,
  execute: Exec = exec,
): Tracker {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Invalid GitHub repository");
  const api = async (path: string, method?: string, data?: unknown) =>
    JSON.parse(
      await checked(execute, {
        cwd,
        argv: [
          "gh",
          "api",
          `repos/${repo}/${path}`,
          ...(method ? ["--method", method, "--input", "-"] : []),
        ],
        ...(method ? { input: JSON.stringify(data) } : {}),
      }),
    );
  const pages = async (path: string): Promise<Remote[]> => {
    const value = JSON.parse(
      await checked(execute, {
        cwd,
        argv: ["gh", "api", `repos/${repo}/${path}`, "--paginate", "--slurp"],
      }),
    );
    if (!Array.isArray(value) || value.some((p) => !Array.isArray(p)))
      throw new Error("Ambiguous GitHub listing");
    return value.flat();
  };
  const reconcile = async (
    path: string,
    marker: string,
    create: () => Promise<Remote>,
  ) => {
    const matches = (await pages(path)).filter(
      (r) => typeof r.body === "string" && r.body.includes(marker),
    );
    if (matches.length > 1)
      throw new Error("Ambiguous GitHub operation marker");
    const result = identity(matches[0] ?? (await create()));
    if (!result.url || result.id === "undefined")
      throw new Error("GitHub write returned no identity");
    return result;
  };
  const readPullRequest: Tracker["readPullRequest"] = async (id) => {
    const r: Remote = await api(`pulls/${id}`);
    return { ...identity(r), head: r.head.sha, merged: r.merged };
  };
  return {
    async readTicket(id) {
      const r: Remote = await api(`issues/${id}`);
      return {
        ...identity(r),
        title: r.title,
        body: r.body ?? "",
        labels: (r.labels ?? []).map((l) => l.name),
      };
    },
    async assign(id) {
      const user = JSON.parse(
        await checked(execute, { cwd, argv: ["gh", "api", "user"] }),
      );
      await api(`issues/${id}/assignees`, "POST", { assignees: [user.login] });
    },
    comment: (id, body, marker) =>
      reconcile(`issues/${id}/comments?per_page=100`, marker, () =>
        api(`issues/${id}/comments`, "POST", { body: `${body}\n\n${marker}` }),
      ),
    followUp: (title, body, marker) =>
      reconcile("issues?state=all&per_page=100", marker, () =>
        api("issues", "POST", { title, body: `${body}\n\n${marker}` }),
      ),
    pullRequest: (title, body, head, base, marker) =>
      reconcile("pulls?state=all&per_page=100", marker, () =>
        api("pulls", "POST", {
          title,
          body: `${body}\n\n${marker}`,
          head,
          base,
        }),
      ),
    readPullRequest,
    async ci(id, sha) {
      if ((await readPullRequest(id)).head !== sha)
        throw new Error("PR head changed before CI");
      const result = await execute({
        cwd,
        argv: [
          "gh",
          "pr",
          "checks",
          id,
          "--repo",
          repo,
          "--required",
          "--json",
          "name,bucket",
        ],
      });
      if (![0, 1, 8].includes(result.code) || result.status !== "done")
        throw new Error(`Cannot read required CI: ${result.stderr}`);
      let checks: { name: string; bucket: string }[];
      try {
        checks = JSON.parse(result.stdout);
      } catch {
        throw new Error(`Cannot establish required CI: ${result.stderr}`);
      }
      if (!Array.isArray(checks) || checks.length === 0)
        throw new Error("No required CI checks reported");
      if ((await readPullRequest(id)).head !== sha)
        throw new Error("PR head changed during CI");
      if (checks.every((c) => c.bucket === "pass")) return "passed";
      if (checks.some((c) => ["fail", "cancel"].includes(c.bucket)))
        return "failed";
      return "pending";
    },
    async merge(id, sha) {
      const pr = await readPullRequest(id);
      if (pr.head !== sha)
        throw new Error("PR head differs from CI-passed SHA");
      if (pr.merged) return;
      const result = await api(`pulls/${id}/merge`, "PUT", {
        merge_method: "squash",
        sha,
      });
      if (result.merged !== true)
        throw new Error("GitHub did not confirm merge");
    },
  };
}
