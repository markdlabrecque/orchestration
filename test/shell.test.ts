import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createShellRunner } from "../src/runners/shell.ts";
import { type RunnerRequest, resultSchema } from "../src/runners/types.ts";

test("shell receives role and brief, returns validated JSON and preserves dirty files on restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orch-shell-"));
  try {
    const runner = createShellRunner(
      `cat > received; printf dirty > work; printf '{"outcome":"pass","summary":"implemented"}' > "$ORCH_RESULT_FILE"; printf handoff`,
    );
    const request: RunnerRequest = {
      prompt: "ticket brief",
      role: "implement carefully",
      cwd,
      model: { tier: "standard", effort: "medium" },
      tools: ["read", "edit", "shell"],
      timeoutMs: 1000,
      resultSchema,
      signal: new AbortController().signal,
      onEvent: () => {},
    };
    expect(await runner.run(request)).toMatchObject({
      status: "done",
      handoff: "handoff",
      result: { outcome: "pass", summary: "implemented" },
    });
    expect(await readFile(join(cwd, "received"), "utf8")).toBe(
      "implement carefully\n\nticket brief",
    );
    expect(
      await createShellRunner('test "$(cat work)" = dirty; exit 0').run(
        request,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      await createShellRunner("sleep 10").run({ ...request, timeoutMs: 20 }),
    ).toMatchObject({ status: "timeout" });
    const abort = new AbortController();
    abort.abort();
    expect(
      await runner.run({ ...request, signal: abort.signal }),
    ).toMatchObject({ status: "aborted" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
