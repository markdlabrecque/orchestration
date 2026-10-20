import { expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

async function caps(args: string[]) {
  const out: string[] = [];
  const code = await runCli(["capabilities", ...args], {
    output: (t) => out.push(t),
  });
  return { code, json: JSON.parse(out.join("")) };
}
test("capabilities reports owner-lifetime host-bound and unqualified durability", async () => {
  const { code, json } = await caps(["--json"]);
  expect(code).toBe(0);
  expect(json).toMatchObject({
    contract: "orch.control/1",
    outcome: "answered",
    supportedMajors: [1],
    capabilities: { "owner-lifetime": "host-bound", durability: "unqualified" },
  });
});
test("requesting an undeclared detached owner is unsupported-capability", async () => {
  const { code, json } = await caps(["--json", "--owner-lifetime", "detached"]);
  expect(code).toBe(0);
  expect(json).toMatchObject({
    outcome: "rejected",
    code: "unsupported-capability",
  });
  expect(
    (await caps(["--json", "--owner-lifetime", "host-bound"])).json.outcome,
  ).toBe("answered");
});
