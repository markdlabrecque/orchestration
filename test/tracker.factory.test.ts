import { expect, test } from "vitest";
import {
  createTracker,
  repositoryFromOrigin,
  selectForge,
} from "../src/tracker/index.ts";

test.each([
  [
    "https://gitlab.example.com:8443/team/repo.git",
    "gitlab.example.com:8443",
    "team/repo",
    "gitlab",
  ],
  ["git@github.com:team/repo.git", "github.com", "team/repo", "github"],
  [
    "https://gitlab.com/team/sub/repo.git",
    "gitlab.com",
    "team/sub/repo",
    "gitlab",
  ],
  [
    "ssh://git@gitlab.example.com:2222/team/sub/repo.git",
    "gitlab.example.com",
    "team/sub/repo",
    "gitlab",
  ],
  [
    "git@git.affinitybridge.com:team/sub/repo",
    "git.affinitybridge.com",
    "team/sub/repo",
    undefined,
  ],
  [
    "https://github.enterprise.test/team/repo",
    "github.enterprise.test",
    "team/repo",
    "github",
  ],
])("parses origin %s without losing subgroups", (origin, host, repo, forge) => {
  expect(repositoryFromOrigin(String(origin))).toEqual({ host, repo, forge });
});
test("explicit forge overrides detection and permits custom hosts", async () => {
  const project = repositoryFromOrigin(
    "git@code.example.com:team/sub/repo.git",
  );
  expect(() => selectForge(project)).toThrow(/settings.forge/);
  expect(selectForge(project, "gitlab")).toBe("gitlab");
  expect(selectForge({ forge: "github" }, "gitlab")).toBe("gitlab");
  expect(() => selectForge(project, "other")).toThrow(/settings.forge/);
  const tracker = createTracker(
    project,
    "/tmp",
    async (r) => {
      expect(r.argv).toEqual([
        "glab",
        "api",
        "projects/team%2Fsub%2Frepo/issues/3",
        "--hostname",
        "code.example.com",
      ]);
      return {
        status: "done",
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          iid: 3,
          web_url: "ticket",
          title: "Change",
          description: "",
        }),
      };
    },
    "gitlab",
  );
  expect(await tracker.readTicket("3")).toMatchObject({ id: "3" });
});
test.each([
  "/local/repo",
  "file:///tmp/repo",
  "https://host/a/../repo",
  "git@host:repo",
  "https://host/a/b?x=1",
])("rejects unsupported origin %s", (origin) => {
  expect(() => repositoryFromOrigin(origin)).toThrow(/origin/);
});
