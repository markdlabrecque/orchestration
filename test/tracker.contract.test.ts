import { describe, expect, test } from "vitest";
import type { Exec } from "../src/command.ts";
import { createGitHubTracker } from "../src/tracker/github.ts";
import { createGitLabTracker } from "../src/tracker/gitlab.ts";
import { fakeForge } from "./fixtures/forge.ts";

for (const forge of ["github", "gitlab"] as const) {
  describe(`${forge} tracker contract`, () => {
    test("assigns the ticket to the authenticated operator", async () => {
      const fake = fakeForge(forge);
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await tracker.assign("3");
      expect(fake.state.assigned).toBe(true);
    });
    test("reconciles a comment on a later page after its create response is lost", async () => {
      const fake = fakeForge(forge);
      fake.state.comments.push(
        ...Array.from({ length: 100 }, (_, i) => fake.note(i + 100, "other")),
      );
      fake.state.loseResponse = true;
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      const post = () => tracker.comment("3", "Done", "<!-- orch:comment -->");
      await expect(post()).rejects.toThrow("response lost");
      expect(await post()).toEqual({
        id: "20",
        url: "https://forge.test/team/repo/issues/3#note_20",
      });
      expect(fake.state.writes).toBe(1);
    });
    test("reconciles a follow-up on a later page after its create response is lost", async () => {
      const fake = fakeForge(forge);
      fake.state.issues.push(
        ...Array.from({ length: 100 }, (_, i) => fake.row(i + 100, "other")),
      );
      fake.state.loseResponse = true;
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      const post = () =>
        tracker.followUp("Follow up", "Details", "<!-- orch:followup -->");
      await expect(post()).rejects.toThrow("response lost");
      expect(await post()).toEqual({
        id: "20",
        url: "https://forge.test/team/repo/issues/20",
      });
      expect(fake.state.writes).toBe(1);
    });
    test("reconciles MR creation after a lost response", async () => {
      const fake = fakeForge(forge);
      fake.state.loseResponse = true;
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      const post = () =>
        tracker.pullRequest(
          "Change",
          "Details",
          "143",
          "main",
          "<!-- orch:pr -->",
        );
      await expect(post()).rejects.toThrow("response lost");
      expect(await post()).toMatchObject({ id: "7" });
      expect(fake.state.writes).toBe(1);
    });
    test("parking updates the marked MR to draft with open findings", async () => {
      const fake = fakeForge(forge);
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await tracker.pullRequest(
        "Change",
        "Details",
        "143",
        "main",
        "<!-- orch:pr -->",
      );
      await tracker.pullRequest(
        "Change",
        "F1: open",
        "143",
        "main",
        "<!-- orch:pr -->",
        { draft: true },
      );
      expect(fake.state.writes).toBe(1);
      const pr = fake.state.prs[0];
      expect(
        forge === "gitlab"
          ? String(pr.title).startsWith("Draft: ")
          : fake.state.draft,
      ).toBe(true);
      expect(pr[forge === "gitlab" ? "description" : "body"]).toContain(
        "F1: open",
      );
    });
    test("abort is a reconciled comment and leaves the ticket readable", async () => {
      const fake = fakeForge(forge);
      fake.state.loseResponse = true;
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await expect(tracker.abort("3", "<!-- orch:abort -->")).rejects.toThrow(
        "response lost",
      );
      await tracker.abort("3", "<!-- orch:abort -->");
      expect(fake.state.writes).toBe(1);
      expect(await tracker.readTicket("3")).toMatchObject({ id: "3" });
    });
    test.each([
      "passed",
      "pending",
      "failed",
    ] as const)("CI reports %s only for the requested head", async (status) => {
      const fake = fakeForge(forge);
      fake.state.ci = status;
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      expect(await tracker.ci("7", "abc")).toBe(status);
      await expect(tracker.ci("7", "stale")).rejects.toThrow(/head/);
      fake.state.changeHeadDuringCi = true;
      await expect(tracker.ci("7", "abc")).rejects.toThrow(/head/);
    });
    test("missing CI cannot authorize merge", async () => {
      const fake = fakeForge(forge);
      fake.state.ci = "missing";
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await expect(tracker.ci("7", "abc")).rejects.toThrow(/CI/);
    });
    test("squash merge pins the approved SHA, exposes conflicts and reconciles completed merges", async () => {
      const fake = fakeForge(forge);
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await expect(tracker.merge("7", "stale")).rejects.toThrow(/head/);
      expect(fake.state.mergeBody).toBeUndefined();
      fake.state.conflict = true;
      expect(await tracker.merge("7", "abc")).toBe("conflict");
      expect(fake.state.mergeBody).toBeUndefined();
      fake.state.conflict = false;
      await tracker.merge("7", "abc");
      expect(fake.state.mergeBody).toEqual(
        forge === "github"
          ? { merge_method: "squash", sha: "abc" }
          : { squash: true, sha: "abc" },
      );
      expect(await tracker.readPullRequest("7")).toMatchObject({
        head: "abc",
        merged: true,
      });
      fake.state.conflict = true;
      await tracker.merge("7", "abc");
    });
    test.each([
      "malformed",
      "unavailable",
      "duplicate",
    ])("%s reconciliation pauses without creating", async (failure) => {
      const fake = fakeForge(forge);
      fake.state.malformed = failure === "malformed";
      fake.state.unavailable = failure === "unavailable";
      if (failure === "duplicate") {
        fake.state.issues.push(
          fake.row(20, "<!-- orch:stable -->"),
          fake.row(21, "<!-- orch:stable -->"),
        );
        fake.state.comments.push(
          fake.note(20, "<!-- orch:stable -->"),
          fake.note(21, "<!-- orch:stable -->"),
        );
        fake.state.prs.push(
          fake.row(20, "<!-- orch:stable -->"),
          fake.row(21, "<!-- orch:stable -->"),
        );
      }
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", fake.execute)
          : createGitLabTracker("team/repo", "/tmp", fake.execute);
      await expect(
        tracker.followUp("Title", "Body", "<!-- orch:stable -->"),
      ).rejects.toThrow();
      await expect(
        tracker.comment("3", "Body", "<!-- orch:stable -->"),
      ).rejects.toThrow();
      await expect(
        tracker.pullRequest(
          "Title",
          "Body",
          "143",
          "main",
          "<!-- orch:stable -->",
        ),
      ).rejects.toThrow();
      expect(fake.state.writes).toBe(0);
    });
    test("a malformed write identity never establishes completion", async () => {
      const fake = fakeForge(forge);
      const execute: Exec = async (r) => {
        const result = await fake.execute(r);
        return r.argv.includes("POST")
          ? {
              ...result,
              stdout: JSON.stringify({
                id: 0,
                number: 0,
                iid: 0,
                html_url: "url",
                web_url: "url",
              }),
            }
          : result;
      };
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", execute)
          : createGitLabTracker("team/repo", "/tmp", execute);
      await expect(
        tracker.followUp("Title", "Body", "<!-- orch:stable -->"),
      ).rejects.toThrow();
      expect(
        await tracker.followUp("Title", "Body", "<!-- orch:stable -->"),
      ).toMatchObject({ id: "20" });
      expect(fake.state.writes).toBe(1);
    });
    test("reads the ticket identity, content and lane labels", async () => {
      const execute: Exec = async () => ({
        status: "done",
        code: 0,
        stderr: "",
        stdout: JSON.stringify(
          forge === "github"
            ? {
                number: 3,
                html_url: "https://forge.test/team/repo/issues/3",
                title: "Change",
                body: "Details",
                labels: [{ name: "lane:trivial" }],
              }
            : {
                id: 999,
                iid: 3,
                web_url: "https://forge.test/team/repo/issues/3",
                title: "Change",
                description: "Details",
                labels: ["lane:trivial"],
              },
        ),
      });
      const tracker =
        forge === "github"
          ? createGitHubTracker("team/repo", "/tmp", execute)
          : createGitLabTracker("team/repo", "/tmp", execute);
      expect(await tracker.readTicket("3")).toEqual({
        id: "3",
        url: "https://forge.test/team/repo/issues/3",
        title: "Change",
        body: "Details",
        labels: ["lane:trivial"],
      });
    });
  });
}

for (const forge of ["github", "gitlab"] as const) {
  test.each([
    "transport",
    "ambiguous-success",
    "unknown-mergeability",
  ])(`${forge} %s is never a confirmed conflict`, async (failure) => {
    const fake = fakeForge(forge);
    const execute: Exec = async (request) => {
      if (request.argv[2]?.endsWith("/merge")) {
        if (failure === "transport")
          throw new Error("409 conflict: response lost");
        return {
          status: "done",
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ message: "conflict" }),
        };
      }
      const response = await fake.execute(request);
      if (failure === "unknown-mergeability") {
        const data = JSON.parse(response.stdout);
        data.mergeable = null;
        data.has_conflicts = false;
        data.detailed_merge_status = "checking";
        return { ...response, stdout: JSON.stringify(data) };
      }
      return response;
    };
    const tracker =
      forge === "github"
        ? createGitHubTracker("team/repo", "/tmp", execute)
        : createGitLabTracker("team/repo", "/tmp", execute);
    await expect(tracker.merge("7", "abc")).rejects.toThrow();
  });
}

for (const forge of ["github", "gitlab"] as const) {
  test(`${forge} a lost successful merge response throws and retry confirms without another write`, async () => {
    const fake = fakeForge(forge);
    let writes = 0;
    const execute: Exec = async (request) => {
      const response = await fake.execute(request);
      if (request.argv[2]?.endsWith("/merge")) {
        writes++;
        throw new Error("response lost");
      }
      return response;
    };
    const tracker =
      forge === "github"
        ? createGitHubTracker("team/repo", "/tmp", execute)
        : createGitLabTracker("team/repo", "/tmp", execute);
    await expect(tracker.merge("7", "abc")).rejects.toThrow("response lost");
    fake.state.conflict = true;
    expect(await tracker.merge("7", "abc")).toBe("merged");
    expect(writes).toBe(1);
  });
}
