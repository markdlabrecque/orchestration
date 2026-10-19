import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checked, type Exec, exec } from "../src/command.ts";
import { discoverProject } from "../src/project.ts";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "orch-publish-"));
  const remote = join(root, "remote.git"),
    main = join(root, "main"),
    ticket = join(root, "3");
  const execute: Exec = (request) =>
    exec({
      ...request,
      argv:
        request.argv[0] === "git"
          ? [
              "git",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              ...request.argv.slice(1),
            ]
          : request.argv,
    });
  const git = (cwd: string, ...args: string[]) =>
    checked(execute, { cwd, argv: ["git", ...args] });
  await git(root, "init", "--bare", remote);
  await git(root, "init", "-b", "main", main);
  await writeFile(join(main, "base"), "base");
  await git(main, "add", ".");
  await git(main, "commit", "-m", "base");
  await git(main, "remote", "add", "origin", remote);
  await git(main, "push", "origin", "main");
  await git(root, "clone", "-b", "main", remote, ticket);
  const discover: Exec = async (request) =>
    request.argv[0] === "bash"
      ? {
          status: "done",
          code: 0,
          stderr: "",
          stdout: [root, main, root, "main", ""].join("\0"),
        }
      : request.argv.includes("remote.origin.url")
        ? {
            status: "done",
            code: 0,
            stderr: "",
            stdout: "git@github.com:team/repo.git",
          }
        : execute(request);
  return { root, main, ticket, git, discover };
}

test("publishes initially and republishes rewritten ticket commits after base advances", async () => {
  const f = await repository();
  try {
    const project = await discoverProject(f.main, "3", f.discover);
    await writeFile(join(f.ticket, "change"), "ticket");
    const first = await project.publish("ticket");
    expect(
      await f.git(f.main, "ls-remote", "origin", "refs/heads/3"),
    ).toContain(first);
    await writeFile(join(f.main, "base"), "advanced");
    await f.git(f.main, "commit", "-am", "advance");
    await f.git(f.main, "push", "origin", "main");
    const second = await project.publish("repair");
    expect(second).not.toBe(first);
    expect(
      await f.git(f.main, "ls-remote", "origin", "refs/heads/3"),
    ).toContain(second);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([
  false,
  true,
])("a remote edit %s during publish is never overwritten", async (initial) => {
  const f = await repository();
  try {
    await writeFile(join(f.ticket, "change"), "ticket");
    if (!initial)
      await (await discoverProject(f.main, "3", f.discover)).publish("ticket");
    let raced = false;
    const project = await discoverProject(f.main, "3", async (request) => {
      if (request.argv.includes("push") && !raced) {
        raced = true;
        await f.git(f.main, "push", "--force", "origin", "HEAD:refs/heads/3");
      }
      return f.discover(request);
    });
    await expect(project.publish("repair")).rejects.toThrow(/stale info/);
    expect(
      await f.git(f.main, "ls-remote", "origin", "refs/heads/3"),
    ).toContain(await f.git(f.main, "rev-parse", "HEAD"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each([
  false,
  true,
])("an interrupted publish retries safely with a subsequent remote edit: %s", async (remoteEdit) => {
  const f = await repository();
  try {
    const project = await discoverProject(f.main, "3", f.discover);
    await writeFile(join(f.ticket, "change"), "ticket");
    await project.publish("ticket");
    await writeFile(join(f.main, "base"), "advanced");
    await f.git(f.main, "commit", "-am", "advance");
    await f.git(f.main, "push", "origin", "main");
    const interrupted = await discoverProject(f.main, "3", async (request) => {
      if (request.argv.includes("push")) throw new Error("offline");
      return f.discover(request);
    });
    await expect(interrupted.publish("repair")).rejects.toThrow("offline");
    if (remoteEdit) {
      await writeFile(join(f.main, "remote-only"), "another author");
      await f.git(f.main, "add", ".");
      await f.git(f.main, "commit", "-m", "concurrent edit");
      await f.git(f.main, "push", "--force", "origin", "HEAD:refs/heads/3");
      await expect(project.publish("repair")).rejects.toThrow();
      expect(
        await f.git(f.main, "ls-remote", "origin", "refs/heads/3"),
      ).toContain(await f.git(f.main, "rev-parse", "HEAD"));
      return;
    }
    const sha = await project.publish("repair");
    expect(
      await f.git(f.main, "ls-remote", "origin", "refs/heads/3"),
    ).toContain(sha);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
