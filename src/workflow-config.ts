import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "./command.ts";
import { packageRoot } from "./project.ts";

export function globalWorkflowPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "orchestration/workflow.yaml",
  );
}
export async function workflowConfig(
  argv: string[],
  file: string,
  execute: Exec,
  output: (text: string) => void,
): Promise<number> {
  const shipped = join(packageRoot, "workflow.default.yaml");
  if (argv[0] === "diff" && argv.length === 1) {
    const result = await execute({
      cwd: packageRoot,
      argv: ["git", "diff", "--no-index", "--no-ext-diff", "--", shipped, file],
    });
    if (result.status !== "done" || result.code > 1)
      throw new Error(result.stderr || "Cannot compare global workflow");
    output(result.stdout || "Global workflow matches shipped default");
    return 0;
  }
  if (
    argv[0] !== "reset" ||
    argv.length > 2 ||
    (argv[1] !== undefined && argv[1] !== "--force")
  )
    throw new Error(
      "Usage: orch workflow diff | orch workflow reset [--force]",
    );
  let current: string | undefined;
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== undefined) {
    if (current !== (await readFile(shipped, "utf8")) && argv[1] !== "--force")
      throw new Error(
        "Global workflow has edits. Use orch workflow diff, then reset --force to back up and replace it.",
      );
    // Never overwrite an earlier backup, including after repeated resets.
    for (let suffix = 0; ; suffix++) {
      const backup = `${file}${suffix ? `.${suffix}` : ""}.bak`;
      try {
        await copyFile(file, backup, constants.COPYFILE_EXCL);
        output(`Backup: ${backup}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
  await mkdir(dirname(file), { recursive: true });
  await copyFile(shipped, file);
  output(`Reset: ${file}`);
  return 0;
}
