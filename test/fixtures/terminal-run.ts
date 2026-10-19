import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import { type Exec, exec } from "../../src/command.ts";

const [dir, ...rawArgs] = process.argv.slice(2);
const crashAbort = rawArgs.includes("--fixture-crash-abort");
const crashRetire = rawArgs.includes("--fixture-crash-retire");
const args = rawArgs.filter((arg) => !arg.startsWith("--fixture-"));
const execute: Exec = async (request) => {
  const { argv } = request;
  const done = (value: unknown) => ({
    status: "done" as const,
    code: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  });
  if (argv[0] === "bash" && argv[2]?.startsWith('source "$1"'))
    return done(`${dir}\0${dir}\0${dir}/code\0main\0`);
  if (argv[0] === "git") return done("https://github.com/a/b.git");
  if (argv[0] === "bash" && argv[1]?.endsWith("setup-worktree.sh"))
    return done("");
  if (argv[0] === "bash" && argv[1]?.endsWith("retire-worktree.sh")) {
    if (!existsSync(join(dir, "retired")))
      appendFileSync(join(dir, "retired"), "retired\n");
    if (crashRetire) process.kill(process.pid, "SIGKILL");
    return done("");
  }
  if (argv[0] === "gh") {
    if (argv[1] === "--version") return done("fixture");
    if (argv[2] === "user") return done({ login: "fixture" });
    if (argv[2]?.includes("/comments")) {
      if (argv.includes("POST")) {
        appendFileSync(join(dir, "abort-comments"), `${request.input}\n`);
        if (crashAbort) process.kill(process.pid, "SIGKILL");
        return done({ id: 1, html_url: "comment" });
      }
      const file = join(dir, "abort-comments");
      const comments = existsSync(file)
        ? readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => ({
              id: 1,
              html_url: "comment",
              body: JSON.parse(line).body,
            }))
        : [];
      return done([comments]);
    }
    if (argv[2]?.endsWith("/assignees")) return done({});
    return done({
      number: 144,
      title: "Terminal controls",
      body: "work",
      html_url: "ticket",
      labels: [],
    });
  }
  return exec(request);
};
process.exitCode = await runCli(args, {
  cwd: dir,
  execute,
  workflowPath: join(dir, "workflow.yaml"),
});
