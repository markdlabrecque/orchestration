import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const request = {
  contract: "orch.control/1",
  requestId: "request-167",
  op: "capabilities",
};

async function invoke(args: string[], stdin: string, cwd?: string) {
  const out: string[] = [];
  // Keep the input on an options variable until CliOptions gains stdin.
  const options = { stdin, cwd, output: (text: string) => out.push(text) };
  const code = await runCli(args, options);
  expect(code).toBe(0);
  const text = out.join("").trim();
  const json = JSON.parse(text);
  expect(json).not.toBeNull();
  expect(typeof json).toBe("object");
  expect(Array.isArray(json)).toBe(false);
  return json;
}

async function control(stdin: string, cwd?: string) {
  const json = await invoke(["control", "--json"], stdin, cwd);
  expect(json).toMatchObject({
    contract: "orch.control/1",
    receipt: null,
    snapshot: null,
  });
  expect(["accepted", "rejected", "already-recorded"]).toContain(json.outcome);
  expect(json.code === null || typeof json.code === "string").toBe(true);
  return json;
}

function expectRejection(json: Record<string, unknown>, code: string) {
  expect(json).toMatchObject({ outcome: "rejected", code });
  expect(typeof json.message).toBe("string");
  expect(String(json.message).trim().length).toBeGreaterThan(0);
}

test("control answers one request with one JSON envelope and legacy capabilities", async () => {
  const json = await control(JSON.stringify(request));
  const legacy = await invoke(["capabilities", "--json"], "");
  expect(json).toMatchObject({
    outcome: "accepted",
    code: null,
    supportedMajors: [1],
    capabilities: { "owner-lifetime": "host-bound", durability: "unqualified" },
  });
  expect(json.capabilities).toEqual(legacy.capabilities);
});

test("control rejects unsupported contract majors with the supported majors", async () => {
  const json = await control(
    JSON.stringify({ ...request, contract: "orch.control/2" }),
  );
  expectRejection(json, "unsupported-version");
  expect(json.supportedMajors).toEqual([1]);
});

const invalidRequests: [string, unknown][] = [
  ["missing contract", { requestId: "r", op: "capabilities" }],
  ["null contract", { ...request, contract: null }],
  ["numeric contract", { ...request, contract: 1 }],
  ["empty contract", { ...request, contract: "" }],
  ["wrong contract name", { ...request, contract: "other/1" }],
  ["malformed major", { ...request, contract: "orch.control/nope" }],
  ["missing major", { ...request, contract: "orch.control/" }],
  ["missing requestId", { contract: request.contract, op: request.op }],
  ["empty requestId", { ...request, requestId: "" }],
  ["non-string requestId", { ...request, requestId: 1 }],
  ["missing op", { contract: request.contract, requestId: request.requestId }],
  ["empty op", { ...request, op: "" }],
  ["non-string op", { ...request, op: 1 }],
  ["null params", { ...request, params: null }],
  ["array params", { ...request, params: [] }],
  ["string params", { ...request, params: "params" }],
  ["numeric params", { ...request, params: 1 }],
  ["boolean params", { ...request, params: false }],
];
for (const [name, value] of invalidRequests) {
  test(`control rejects invalid-request: ${name}`, async () => {
    expectRejection(await control(JSON.stringify(value)), "invalid-request");
  });
}

for (const stdin of [
  "",
  "  \n",
  "not JSON",
  "{",
  "null",
  "[]",
  '"text"',
  "1",
  "true",
]) {
  test(`control rejects malformed or non-object stdin ${JSON.stringify(stdin)}`, async () => {
    expectRejection(await control(stdin), "invalid-request");
  });
}

for (const op of [
  "unknown-operation",
  "start",
  "resume",
  "snapshot",
  "events",
  "request",
  "answer",
  "pause",
  "abort",
  "retire",
]) {
  test(`control rejects unsupported op ${op}`, async () => {
    const json = await control(JSON.stringify({ ...request, op }));
    expectRejection(json, "unsupported-op");
    expect(json.message).toContain(op);
  });
}

test("control ignores unknown request fields and accepts object params", async () => {
  const json = await control(
    JSON.stringify({ ...request, params: {}, futureField: { nested: true } }),
  );
  expect(json.outcome).toBe("accepted");
});

test("control needs no project or state directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orch-control-"));
  try {
    const json = await control(JSON.stringify(request), cwd);
    expect(json.outcome).toBe("accepted");
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const command of ["capabilities", "control"]) {
  for (const args of [
    ["--json", command],
    [command, "--json"],
  ]) {
    test(`${args.join(" ")} prints one JSON response`, async () => {
      const json = await invoke(args, JSON.stringify(request));
      expect(json.contract).toBe("orch.control/1");
      expect(json.outcome).toBe(
        command === "control" ? "accepted" : "answered",
      );
    });
  }
}

for (const command of ["show", "snapshot", "tail", "validate"]) {
  const positional = command === "validate" ? [] : ["167"];
  for (const args of [
    ["--json", command, ...positional],
    [command, ...positional, "--json"],
  ]) {
    test(`${args.join(" ")} does not reject the JSON flag as usage`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "orch-json-flag-"));
      try {
        let failure: unknown;
        try {
          await runCli(args, { cwd, output: () => {} });
        } catch (error) {
          failure = error;
        }
        if (failure !== undefined) {
          expect(String(failure)).not.toMatch(/usage:/i);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}
