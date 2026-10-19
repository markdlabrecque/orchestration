import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const driver = fileURLToPath(
  new URL("./fixtures/crash-run.ts", import.meta.url),
);
function child(dir: string, mode: string, retry = "") {
  return new Promise<{
    code: number | null;
    signal: string | null;
    stderr: string;
  }>((resolve, reject) => {
    const p = spawn(process.execPath, [driver, dir, mode, retry]);
    let stderr = "";
    p.stderr.on("data", (b) => {
      stderr += b;
    });
    p.on("error", reject);
    p.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
for (const mode of ["pi", "pi-mid", "shell"])
  test(`SIGKILL during ${mode} resumes durable work without replaying completed steps`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `orch-crash-${mode}-`));
    try {
      expect(await child(dir, mode)).toMatchObject({ signal: "SIGKILL" });
      const second = await child(dir, mode);
      expect(second.code, second.stderr).toBe(0);
      expect(
        JSON.parse(await readFile(join(dir, "result.json"), "utf8")),
      ).toMatchObject({ status: "merged", handoffs: { plan: "planned" } });
      expect(await readFile(join(dir, "model-calls"), "utf8")).toBe(
        mode === "pi-mid" ? "request\nrequest\n" : "request\n",
      );
      expect(await readFile(join(dir, "pickups"), "utf8")).toBe("pickup\n");
      expect(await readFile(join(dir, "dirty"), "utf8")).toBe("saved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

test("three actual crashes block the same step until an explicit retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-crash-limit-"));
  try {
    for (let i = 0; i < 3; i++)
      expect(await child(dir, "shell-limit")).toMatchObject({
        signal: "SIGKILL",
      });
    const blocked = await child(dir, "shell-limit");
    expect(blocked, blocked.stderr).toMatchObject({ code: 0, signal: null });
    expect(
      JSON.parse(await readFile(join(dir, "result.json"), "utf8")),
    ).toMatchObject({
      status: "blocked",
      crashes: { implement: 3 },
      reason: expect.stringMatching(/--retry/),
    });
    expect(await child(dir, "shell-limit")).toMatchObject({ code: 0 });
    expect(await child(dir, "shell-limit", "retry-crash")).toMatchObject({
      signal: "SIGKILL",
    });
    expect(await child(dir, "shell-limit")).toMatchObject({ code: 0 });
    expect(
      JSON.parse(await readFile(join(dir, "result.json"), "utf8")),
    ).toMatchObject({ status: "blocked", crashes: { implement: 4 } });
    expect(await child(dir, "shell-limit", "retry")).toMatchObject({ code: 0 });
    expect(
      JSON.parse(await readFile(join(dir, "result.json"), "utf8")),
    ).toMatchObject({ status: "merged", crashes: { implement: 4 } });
    expect(await readFile(join(dir, "pickups"), "utf8")).toBe("pickup\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
