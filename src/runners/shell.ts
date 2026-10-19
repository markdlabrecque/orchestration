import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, exec } from "../command.ts";
import { type Runner, type RunnerResult, validateResult } from "./types.ts";

export function createShellRunner(
  command: string,
  execute: Exec = exec,
  models?: Record<string, string>,
): Runner {
  return {
    resumable: false,
    async run(request) {
      if (request.session)
        throw new Error("Shell runner does not support sessions");
      if (
        request.tools.some(
          (tool) => !/^(read|edit|shell|web|mcp:[\w-]+)$/.test(tool),
        )
      )
        throw new Error("Shell: unsupported tool permission");
      const model = models ? models[request.model.tier] : command;
      if (!model) throw new Error("Shell: missing model tier mapping");
      const base: RunnerResult = {
        status: "failed",
        handoff: "",
        artifacts: [],
        ranOn: {
          provider: "shell",
          model,
          effort: request.model.effort,
        },
        usage: null,
      };
      if (request.signal.aborted) return { ...base, status: "aborted" };
      const dir = await mkdtemp(join(tmpdir(), "orch-runner-"));
      try {
        const role = join(dir, "role.md"),
          resultFile = join(dir, "result.json");
        await writeFile(role, request.role);
        const output = await execute({
          argv: ["bash", "-c", command],
          cwd: request.cwd,
          input: `${request.role}\n\n${request.prompt}`,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          env: {
            ORCH_ROLE_FILE: role,
            ORCH_RESULT_FILE: resultFile,
            ORCH_RESULT_SCHEMA: JSON.stringify(request.resultSchema),
            ORCH_TOOLS: JSON.stringify(request.tools),
            ORCH_MODEL: model,
            ORCH_MODEL_TIER: request.model.tier,
            ORCH_MODEL_EFFORT: request.model.effort,
          },
          onOutput: (text, stream) =>
            request.onEvent({
              type: stream === "stdout" ? "text" : "status",
              data: text,
            }),
        });
        base.handoff = output.stdout;
        if (output.status !== "done") return { ...base, status: output.status };
        if (output.code !== 0) return base;
        return {
          ...base,
          status: "done",
          result: validateResult(
            request.resultSchema,
            JSON.parse(await readFile(resultFile, "utf8")),
          ),
        };
      } catch (error) {
        request.onEvent({ type: "status", data: String(error) });
        return base;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
