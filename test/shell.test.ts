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

test("shell maps the requested tier and rejects unknown permissions or sessions before starting", async () => {
  const request: RunnerRequest = {
    prompt: "brief",
    role: "role",
    cwd: process.cwd(),
    model: { tier: "heavy", effort: "high" },
    tools: ["read", "web", "mcp:browser"],
    timeoutMs: 1000,
    resultSchema,
    signal: new AbortController().signal,
    onEvent: () => {},
  };
  const runner = createShellRunner(
    `printf '%s' "$ORCH_MODEL"; printf '{"outcome":"pass","summary":"done"}' > "$ORCH_RESULT_FILE"`,
    undefined,
    { heavy: "chosen-model" },
  );
  expect(await runner.run(request)).toMatchObject({
    status: "done",
    handoff: "chosen-model",
    ranOn: { model: "chosen-model", effort: "high" },
  });
  await expect(runner.run({ ...request, tools: ["unknown"] })).rejects.toThrow(
    /permission/,
  );
  await expect(runner.run({ ...request, session: "lost" })).rejects.toThrow(
    /session/,
  );
});

test.each([
  "timeout",
  "abort",
])("shell %s kills descendants even when the process group leader exits", async (mode) => {
  const cwd = await mkdtemp(join(tmpdir(), "orch-group-"));
  try {
    const controller = new AbortController();
    const runner = createShellRunner(
      `trap 'exit 0' TERM; (trap '' TERM; sleep 0.5; printf survived > survived) >/dev/null 2>&1 & printf ready; wait`,
    );
    const result = await runner.run({
      prompt: "",
      role: "",
      cwd,
      model: { tier: "light", effort: "low" },
      tools: ["shell"],
      timeoutMs: mode === "timeout" ? 30 : 2000,
      resultSchema,
      signal: controller.signal,
      onEvent: (event) => {
        if (mode === "abort" && event.data === "ready") controller.abort();
      },
    });
    expect(result.status).toBe(mode === "timeout" ? "timeout" : "aborted");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(readFile(join(cwd, "survived"))).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
