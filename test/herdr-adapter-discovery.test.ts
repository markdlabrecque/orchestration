// Herdr adapter (#173): binary discovery, orch client shell-outs and the capability declaration.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  declaration,
  requireCapability,
} from "../src/adapters/herdr/declaration.ts";
import { resolveBin } from "../src/adapters/herdr/discovery.ts";
import { checkContract, createOrch } from "../src/adapters/herdr/orch.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-adapter-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function script(where: string, majors = "[1]") {
  mkdirSync(where, { recursive: true });
  const file = join(where, "orch");
  writeFileSync(
    file,
    `#!/bin/sh
echo "$@" >> "$0.log"
case "$1" in
  capabilities) echo '{"contract":"orch.control/1","supportedMajors":${majors},"outcome":"answered"}';;
  control) cat >/dev/null; echo '{"contract":"orch.control/1","outcome":"answered","snapshot":{"runId":"r","state":"running","owner":"live"}}';;
  request) echo '{"contract":"orch.control/1","outcome":"rejected","code":"request-not-found","receipt":null}';;
esac
`,
  );
  chmodSync(file, 0o755);
  return file;
}
const log = (file: string) => readFileSync(`${file}.log`, "utf8");

test("ORCH_BIN wins over PATH", () => {
  const chosen = script(join(dir, "a"));
  script(join(dir, "b"));
  expect(
    resolveBin("orch", "ORCH_BIN", {
      ORCH_BIN: chosen,
      PATH: join(dir, "b"),
    }),
  ).toBe(chosen);
});

test("falls back to PATH, and HERDR_BIN works the same way", () => {
  const onPath = script(join(dir, "b"));
  expect(resolveBin("orch", "ORCH_BIN", { PATH: join(dir, "b") })).toBe(onPath);
  expect(
    resolveBin("herdr", "HERDR_BIN", { HERDR_BIN: "/x/herdr", PATH: "" }),
  ).toBe("/x/herdr");
});

test("a missing binary is binary-not-found naming the variable", () => {
  expect(() => resolveBin("orch", "ORCH_BIN", { PATH: dir })).toThrowError(
    expect.objectContaining({
      code: "binary-not-found",
      message: expect.stringContaining("ORCH_BIN"),
    }),
  );
});

test("orch client shells out to capabilities, control and request", async () => {
  const bin = script(join(dir, "a"));
  const orch = createOrch({ bin, cwd: dir });
  expect((await orch.capabilities()).supportedMajors).toEqual([1]);
  expect(await orch.snapshot("7")).toMatchObject({
    state: "running",
    owner: "live",
  });
  expect(await orch.receipt("a", "7")).toBeNull();
  const calls = log(bin);
  expect(calls).toContain("capabilities --json");
  expect(calls).toContain("control --json");
  expect(calls).toContain("request a --run 7 --json");
});

test("checkContract refuses an orch that does not support major 1", async () => {
  const bin = script(join(dir, "a"), "[2]");
  await expect(
    checkContract(createOrch({ bin, cwd: dir })),
  ).rejects.toMatchObject({ code: "contract-unsupported" });
  const ok = script(join(dir, "b"));
  await expect(
    checkContract(createOrch({ bin: ok, cwd: dir })),
  ).resolves.toBeUndefined();
});

test("declares host-bound; detached, question presentation and notifications are unsupported-capability", () => {
  expect(declaration.ownerLifetime).toEqual(["host-bound"]);
  expect(() =>
    requireCapability({ ownerLifetime: "host-bound" }),
  ).not.toThrow();
  expect(() => requireCapability({ ownerLifetime: "detached" })).toThrowError(
    expect.objectContaining({
      code: "unsupported-capability",
      message: expect.stringContaining("detached"),
    }),
  );
  for (const feature of ["question-presentation", "notifications"])
    expect(() => requireCapability({ features: [feature] })).toThrowError(
      expect.objectContaining({
        code: "unsupported-capability",
        message: expect.stringContaining(feature),
      }),
    );
});
