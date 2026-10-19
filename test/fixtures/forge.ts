import type { Exec } from "../../src/command.ts";

// Stateful external forge boundary. Unknown requests fail instead of returning
// a success-shaped default, so wire-format mistakes cannot silently pass.
export function fakeForge(forge: "github" | "gitlab") {
  const gitlab = forge === "gitlab";
  const url = "https://forge.test/team/repo/issues/3";
  type Row = Record<string, unknown>;
  const state = {
    comments: [] as Row[],
    issues: [] as Row[],
    prs: [] as Row[],
    writes: 0,
    loseResponse: false,
    unavailable: false,
    malformed: false,
    assigned: false,
    head: "abc",
    merged: false,
    draft: false,
    ci: "passed",
    changeHeadDuringCi: false,
    conflict: false,
    mergeBody: undefined as Row | undefined,
  };
  const row = (id: number, body: string): Row =>
    gitlab
      ? {
          id: id + 1000,
          iid: id,
          web_url: `https://forge.test/team/repo/issues/${id}`,
          description: body,
        }
      : {
          id,
          number: id,
          html_url: `https://forge.test/team/repo/issues/${id}`,
          body,
        };
  const note = (id: number, body: string): Row =>
    gitlab ? { id, body } : { id, body, html_url: `${url}#note_${id}` };
  const execute: Exec = async (request) => {
    if (state.unavailable) throw new Error("network unavailable");
    const args = request.argv;
    if (args[0] !== (gitlab ? "glab" : "gh"))
      throw new Error("Wrong forge CLI");
    const method = args[args.indexOf("--method") + 1];
    const write = args.includes("--method");
    const data = request.input ? JSON.parse(request.input) : {};
    const path = args[2]?.replace(
      /^(repos\/team\/repo|projects\/team%2Frepo)\//,
      "",
    );
    const result = (value: unknown) => ({
      status: "done" as const,
      code: 0,
      stderr: "",
      stdout: JSON.stringify(value),
    });
    if (args[1] === "pr" && args[2] === "ready") {
      state.draft = true;
      return result({});
    }
    if (args[1] === "pr" && args[2] === "checks") {
      if (state.changeHeadDuringCi) state.head = "new";
      return result(
        state.ci === "missing"
          ? []
          : [
              {
                name: "test",
                bucket: { passed: "pass", failed: "fail", pending: "pending" }[
                  state.ci
                ],
              },
            ],
      );
    }
    if (path === "user") return result({ id: 17, login: "operator" });
    if (path === "issues/3/assignees" || (path === "issues/3" && write)) {
      if (
        gitlab
          ? JSON.stringify(data.assignee_ids) !== "[17]"
          : JSON.stringify(data.assignees) !== '["operator"]'
      )
        throw new Error("Wrong assignment");
      state.assigned = true;
      return result({});
    }
    if (path === "issues/3")
      return result({
        ...row(3, "Details"),
        title: "Change",
        labels: gitlab ? ["lane:trivial"] : [{ name: "lane:trivial" }],
      });
    if (path === (gitlab ? "merge_requests/7" : "pulls/7")) {
      if (write) {
        state.prs[0] = { ...state.prs[0], ...data };
        return result(state.prs[0]);
      }
      return result({
        ...row(7, "body"),
        ...(gitlab
          ? {
              sha: state.head,
              state: state.merged ? "merged" : "opened",
              head_pipeline:
                state.ci === "missing"
                  ? null
                  : {
                      id: 9,
                      sha: state.head,
                      status: {
                        passed: "success",
                        failed: "failed",
                        pending: "running",
                      }[state.ci],
                    },
            }
          : { head: { sha: state.head }, merged: state.merged, state: "open" }),
        draft: state.draft,
      });
    }
    if (path === "pipelines/9") {
      const sha = state.head;
      if (state.changeHeadDuringCi) state.head = "new";
      return result({
        id: 9,
        sha,
        status: { passed: "success", failed: "failed", pending: "running" }[
          state.ci
        ],
      });
    }
    if (path === (gitlab ? "merge_requests/7/merge" : "pulls/7/merge")) {
      if (state.conflict || data.sha !== state.head)
        throw new Error("409 merge conflict");
      state.mergeBody = data;
      state.merged = true;
      return result(
        gitlab
          ? { ...row(7, "body"), sha: state.head, state: "merged" }
          : { merged: true },
      );
    }
    const collection = path?.startsWith("issues/3/")
      ? state.comments
      : path?.startsWith("issues")
        ? state.issues
        : path?.startsWith(gitlab ? "merge_requests" : "pulls")
          ? state.prs
          : undefined;
    if (!collection)
      throw new Error(`Unexpected forge request: ${args.join(" ")}`);
    if (write) {
      if (method !== "POST") throw new Error("Unexpected write");
      state.writes++;
      const created =
        collection === state.comments
          ? note(20, data.body)
          : {
              ...row(
                collection === state.prs ? 7 : 20,
                gitlab ? data.description : data.body,
              ),
              ...data,
            };
      collection.push(created);
      if (state.loseResponse) {
        state.loseResponse = false;
        throw new Error("response lost");
      }
      return result(created);
    }
    if (state.malformed) return result(gitlab ? [{}] : [[{}]]);
    if (!gitlab) {
      if (!args.includes("--paginate") || !args.includes("--slurp"))
        throw new Error("Incomplete listing");
      return result([collection.slice(0, 100), collection.slice(100)]);
    }
    const query = new URLSearchParams(path?.split("?")[1]);
    if (query.get("per_page") !== "100") throw new Error("Missing page size");
    const page = Number(query.get("page"));
    if (!page) throw new Error("Missing page");
    return result(collection.slice((page - 1) * 100, page * 100));
  };
  return { state, execute, row, note };
}
