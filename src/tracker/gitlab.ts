import { checked, type Exec, exec } from "../command.ts";
import { remoteIdentity } from "./identity.ts";
import type { Identity, Tracker } from "./types.ts";

export function createGitLabTracker(
  repo: string,
  cwd: string,
  execute: Exec = exec,
  host = "gitlab.com",
): Tracker {
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(repo))
    throw new Error("Invalid GitLab repository");
  const api = async (path: string, method?: string, data?: unknown) =>
    JSON.parse(
      await checked(execute, {
        cwd,
        argv: [
          "glab",
          "api",
          path === "user"
            ? "user"
            : `projects/${encodeURIComponent(repo)}/${path}`,
          "--hostname",
          host,
          ...(method ? ["--method", method, "--input", "-"] : []),
        ],
        ...(method ? { input: JSON.stringify(data) } : {}),
      }),
    );
  type Remote = {
    id: number;
    iid?: number;
    web_url?: string;
    body?: string;
    description?: string | null;
  };
  const identity = (r: Remote, noteUrl?: string): Identity => {
    const id = noteUrl ? r?.id : r?.iid;
    const url = noteUrl ? `${noteUrl}#note_${id}` : r?.web_url;
    return remoteIdentity(id, url);
  };
  const pages = async (path: string, noteUrl?: string): Promise<Remote[]> => {
    const rows: Remote[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const value = await api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(value)) throw new Error("Ambiguous GitLab listing");
      for (const r of value) {
        const item = identity(r, noteUrl);
        const body = noteUrl ? r.body : r.description;
        if ((body !== null && typeof body !== "string") || seen.has(item.id))
          throw new Error("Ambiguous GitLab listing entry");
        seen.add(item.id);
        rows.push(r);
      }
      if (value.length < 100) return rows;
    }
  };
  const reconcile = async (
    path: string,
    marker: string,
    create: () => Promise<Remote>,
    noteUrl?: string,
  ) => {
    const matches = (await pages(path, noteUrl)).filter((r) =>
      (noteUrl ? r.body : r.description)?.includes(marker),
    );
    if (matches.length > 1)
      throw new Error("Ambiguous GitLab operation marker");
    return identity(matches[0] ?? (await create()), noteUrl);
  };
  const readTicket: Tracker["readTicket"] = async (id) => {
    const r = await api(`issues/${id}`);
    return {
      ...identity(r),
      title: r.title,
      body: r.description ?? "",
      labels: r.labels ?? [],
    };
  };
  const comment: Tracker["comment"] = async (id, body, marker) => {
    const ticket = await readTicket(id);
    return reconcile(
      `issues/${id}/notes?order_by=created_at&sort=asc`,
      marker,
      () => api(`issues/${id}/notes`, "POST", { body: `${body}\n\n${marker}` }),
      ticket.url,
    );
  };
  const readMR = async (id: string) => {
    const r = await api(`merge_requests/${id}`);
    identity(r);
    if (
      typeof r.sha !== "string" ||
      !r.sha ||
      !["opened", "closed", "merged", "locked"].includes(r.state)
    )
      throw new Error("Ambiguous GitLab MR head/state");
    return r;
  };
  const readPullRequest: Tracker["readPullRequest"] = async (id) => {
    const r = await readMR(id);
    return { ...identity(r), head: r.sha, merged: r.state === "merged" };
  };
  return {
    async assign(id) {
      const user = await api("user");
      if (!Number.isSafeInteger(user.id) || user.id <= 0)
        throw new Error("Invalid GitLab user");
      await api(`issues/${id}`, "PUT", { assignee_ids: [user.id] });
    },
    readTicket,
    comment,
    readPullRequest,
    async merge(id, sha) {
      const mr = await readPullRequest(id);
      if (mr.head !== sha)
        throw new Error("MR head differs from CI-passed SHA");
      if (mr.merged) return;
      const result = await api(`merge_requests/${id}/merge`, "PUT", {
        squash: true,
        sha,
      });
      if (
        result.state !== "merged" ||
        result.sha !== sha ||
        identity(result).id !== id
      )
        throw new Error("GitLab did not confirm merge");
    },
    async ci(id, sha) {
      const mr = await readMR(id);
      if (mr.sha !== sha) throw new Error("MR head changed before CI");
      const pipeline = mr.head_pipeline;
      if (!pipeline || !Number.isSafeInteger(pipeline.id) || pipeline.id <= 0)
        throw new Error("No required CI pipeline reported");
      if (pipeline.sha !== sha)
        throw new Error("CI pipeline differs from MR head");
      const result = await api(`pipelines/${pipeline.id}`);
      if (result.id !== pipeline.id || result.sha !== sha)
        throw new Error("CI pipeline differs from MR head");
      const current = await readMR(id);
      if (current.sha !== sha || current.head_pipeline?.id !== pipeline.id)
        throw new Error("MR head or pipeline changed during CI");
      if (result.status === "success") return "passed";
      if (["failed", "canceled"].includes(result.status)) return "failed";
      if (
        [
          "created",
          "waiting_for_resource",
          "preparing",
          "pending",
          "running",
          "manual",
          "scheduled",
        ].includes(result.status)
      )
        return "pending";
      throw new Error(`Cannot establish required CI: ${result.status}`);
    },
    async abort(id, marker) {
      await comment(id, "Orchestration run aborted.", marker);
    },
    async pullRequest(title, body, branch, base, marker, options) {
      const markedTitle =
        options?.draft && !/^(Draft:|\[Draft\]|\(Draft\))/i.test(title)
          ? `Draft: ${title}`
          : title;
      const description = `${body}\n\n${marker}`;
      const mr = await reconcile(
        "merge_requests?scope=all&state=all&order_by=created_at&sort=asc",
        marker,
        () =>
          api("merge_requests", "POST", {
            title: markedTitle,
            description,
            source_branch: branch,
            target_branch: base,
          }),
      );
      if (options?.draft) {
        const current = await api(`merge_requests/${mr.id}`);
        if (current.state !== "opened")
          throw new Error("Cannot park a closed MR");
        const updated = await api(`merge_requests/${mr.id}`, "PUT", {
          title: markedTitle,
          description,
        });
        identity(updated);
      }
      return mr;
    },
    followUp: (title, body, marker) =>
      reconcile(
        "issues?scope=all&state=all&order_by=created_at&sort=asc",
        marker,
        () =>
          api("issues", "POST", { title, description: `${body}\n\n${marker}` }),
      ),
  };
}
