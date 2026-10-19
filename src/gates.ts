import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Exec } from "./command.ts";
import type { AgentResult } from "./runners/types.ts";

const reportSchema = Type.Object(
  {
    passed: Type.Integer({ minimum: 0 }),
    failures: Type.Array(
      Type.Object(
        {
          test: Type.String({ minLength: 1 }),
          message: Type.String({ minLength: 1 }),
          kind: Type.Literal("assertion"),
        },
        { additionalProperties: false },
      ),
    ),
    errors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** A fresh engine-owned report prevents setup failures and stale evidence passing red. */
export async function testGate(
  gate: string,
  command: string,
  cwd: string,
  execute: Exec,
  signal: AbortSignal,
  result?: AgentResult,
) {
  const dir = await mkdtemp(join(tmpdir(), "orch-tests-"));
  try {
    const file = join(dir, "report.json");
    const output = await execute({
      argv: ["bash", "-c", command],
      cwd,
      signal,
      timeoutMs: 60 * 60 * 1000,
      env: { ORCH_TEST_REPORT_FILE: file },
    });
    if (output.status !== "done") throw new Error(output.status);
    if (gate === "tests-green") {
      if (output.code !== 0)
        throw new Error(output.stderr || output.stdout || "suite failed");
      return;
    }
    if (output.code !== 1)
      throw new Error("red requires assertion failure exit 1");
    const report: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Value.Check(reportSchema, report))
      throw new Error("missing or invalid assertion report");
    const expected = result?.expectedFailures;
    if (
      !expected?.length ||
      report.errors.length ||
      report.failures.length !== expected.length ||
      new Set(expected.map((f) => f.test)).size !== expected.length ||
      !expected.every((f) =>
        report.failures.some(
          (actual) => actual.test === f.test && actual.message === f.message,
        ),
      )
    )
      throw new Error("failures do not match declared behavior");
  } catch (error) {
    throw new Error(`${gate}: ${String(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
