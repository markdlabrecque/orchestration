// Herdr adapter (#173): the entry point behind bin/orch-herdr, driven through main().
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "../src/adapters/herdr/cli.ts";
import { createFakeHerdr, type FakeHerdr } from "./fixtures/fake-herdr.ts";

let fake: FakeHerdr;
let dir: string;
let orchBin: string;
beforeEach(() => {
  fake = createFakeHerdr();
  dir = mkdtempSync(join(tmpdir(), "herdr-cli-"));
  orchBin = join(dir, "my-orch");
  writeFileSync(
    orchBin,
    `#!/bin/sh
echo "$@" >> "$0.log"
case "$1" in
  capabilities) echo '{"contract":"orch.control/1","supportedMajors":[1],"outcome":"answered"}';;
  control) cat >/dev/null; echo '{"contract":"orch.control/1","outcome":"answered","snapshot":{"runId":"r","state":"running","owner":"live"}}';;
esac
`,
  );
  chmodSync(orchBin, 0o755);
});
afterEach(() => {
  fake.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const run = async (argv: string[], signal?: AbortSignal) => {
  const out: string[] = [];
  const code = await main(argv, {
    env: {
      ORCH_BIN: orchBin,
      HERDR_BIN: fake.bin,
      ...fake.env,
      PATH: process.env.PATH,
    },
    cwd: dir,
    output: (t) => out.push(t),
    signal,
  });
  return { code, out: out.map((l) => JSON.parse(l)) };
};

test("detached owner-lifetime is unsupported-capability and touches nothing", async () => {
  const r = await run(["run", "7", "--owner-lifetime", "detached"]);
  expect(r.code).toBe(1);
  expect(r.out[0].error.code).toBe("unsupported-capability");
  expect(r.out[0].error.message).toContain("detached");
  expect(fake.log()).toEqual([]);
});

test("question presentation and notifications are unsupported-capability naming them", async () => {
  for (const [flag, name] of [
    ["--question-presentation", "question-presentation"],
    ["--notifications", "notifications"],
  ]) {
    const r = await run(["run", "7", flag]);
    expect(r.code).toBe(1);
    expect(r.out[0].error.code).toBe("unsupported-capability");
    expect(r.out[0].error.message).toContain(name);
  }
  expect(fake.log()).toEqual([]);
});

test("ORCH_BIN is used for the contract check and snapshot polling; the run is started in a pane", async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 400);
  const r = await run(["run", "7", "--interval", "20"], abort.signal);
  expect(r.code).toBe(0);
  expect(r.out[0]).toMatchObject({ ok: true });
  const calls = readFileSync(`${orchBin}.log`, "utf8");
  expect(calls).toContain("capabilities --json");
  expect(calls).toContain("control --json");
  const ran = fake.ran(r.out[0].paneId);
  expect(ran).toHaveLength(1);
  expect(ran[0]).toMatch(
    new RegExp(`^${orchBin} control --json < .*${r.out[0].requestId}\\.json$`),
  );
});
