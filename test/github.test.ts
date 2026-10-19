import { expect, test } from "vitest";
import type { CommandRequest, Exec } from "../src/command.ts";
import { createGitHubTracker } from "../src/tracker/github.ts";

test("reconciles a comment on a later page and pins squash merge to the approved SHA", async () => {
  const requests: CommandRequest[] = [];
  const execute: Exec = async (r) => {
    requests.push(r);
    const path = r.argv[2];
    let data: unknown = {};
    if (path?.includes("/comments"))
      data = [
        [{ id: 1, body: "other", html_url: "other" }],
        [
          {
            id: 2,
            body: "done <!-- orch:run:comment -->",
            html_url: "https://github.com/a/b/issues/3#issuecomment-2",
          },
        ],
      ];
    if (path === "repos/a/b/pulls/4")
      data = { number: 4, html_url: "pr", head: { sha: "abc" }, merged: false };
    if (path?.endsWith("/merge")) data = { merged: true };
    return {
      code: 0,
      status: "done",
      stdout: JSON.stringify(data),
      stderr: "",
    };
  };
  const tracker = createGitHubTracker("a/b", "/tmp", execute);
  expect(
    await tracker.comment("3", "done", "<!-- orch:run:comment -->"),
  ).toEqual({ id: "2", url: "https://github.com/a/b/issues/3#issuecomment-2" });
  expect(requests.some((r) => r.argv.includes("POST"))).toBe(false);
  await tracker.merge("4", "abc");
  expect(JSON.parse(requests.at(-1)?.input ?? "")).toEqual({
    merge_method: "squash",
    sha: "abc",
  });
  await expect(tracker.merge("4", "stale")).rejects.toThrow(/head/);
});

test("an ambiguous marker lookup never attempts a write", async () => {
  const execute: Exec = async () => {
    throw new Error("network unavailable");
  };
  await expect(
    createGitHubTracker("a/b", "/tmp", execute).comment("3", "text", "marker"),
  ).rejects.toThrow(/network unavailable/);
});

test.each([
  "comment",
  "followUp",
  "pullRequest",
] as const)("reconciles %s after a successful remote write loses its response", async (operation) => {
  let remote: unknown = null;
  let writes = 0;
  const execute: Exec = async (request) => {
    if (request.argv.includes("POST")) {
      writes++;
      const body = JSON.parse(request.input ?? "");
      remote = {
        id: 20,
        number: operation === "comment" ? undefined : 20,
        html_url: "https://github.com/a/b/20",
        body: body.body,
      };
      throw new Error("response lost");
    }
    return {
      code: 0,
      status: "done",
      stderr: "",
      stdout: JSON.stringify([[], remote ? [remote] : []]),
    };
  };
  const tracker = createGitHubTracker("a/b", "/tmp", execute);
  const retry = () =>
    operation === "comment"
      ? tracker.comment("3", "body", "<!-- orch:stable -->")
      : operation === "followUp"
        ? tracker.followUp("title", "body", "<!-- orch:stable -->")
        : tracker.pullRequest(
            "title",
            "body",
            "branch",
            "main",
            "<!-- orch:stable -->",
          );
  await expect(retry()).rejects.toThrow("response lost");
  expect(await retry()).toEqual({ id: "20", url: "https://github.com/a/b/20" });
  expect(writes).toBe(1);
});

test("no required checks cannot authorize a merge", async () => {
  const execute: Exec = async (request) => ({
    code: 0,
    status: "done",
    stderr: "",
    stdout: JSON.stringify(
      request.argv[1] === "pr"
        ? []
        : { number: 4, html_url: "pr", head: { sha: "abc" }, merged: false },
    ),
  });
  await expect(
    createGitHubTracker("a/b", "/tmp", execute).ci("4", "abc"),
  ).rejects.toThrow("No required CI");
});

test("ticket reads retain lane labels for engine selection", async () => {
  const tracker = createGitHubTracker(
    "owner/repo",
    process.cwd(),
    async () => ({
      code: 0,
      status: "done",
      stderr: "",
      stdout: JSON.stringify({
        number: 141,
        html_url: "ticket",
        title: "change",
        body: "",
        labels: [{ name: "lane:trivial" }, { name: "other" }],
      }),
    }),
  );
  expect(await tracker.readTicket("141")).toMatchObject({
    labels: ["lane:trivial", "other"],
  });
});
