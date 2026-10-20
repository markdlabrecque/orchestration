// Herdr adapter (#173): snapshot polling and state reporting with the adapter's own seq.
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAdapter } from "../src/adapters/herdr/adapter.ts";
import { createHerdr } from "../src/adapters/herdr/herdr.ts";
import type { Orch, Snapshot } from "../src/adapters/herdr/orch.ts";
import { mapState } from "../src/adapters/herdr/state.ts";
import { createFakeHerdr, type FakeHerdr } from "./fixtures/fake-herdr.ts";

let fake: FakeHerdr;
let snap: Snapshot | null;
beforeEach(() => {
  fake = createFakeHerdr();
  snap = null;
});
afterEach(() => fake.cleanup());

const orch = (): Orch =>
  ({
    capabilities: async () => ({ supportedMajors: [1] }),
    snapshot: async () => snap,
    receipt: async () => null,
  }) as unknown as Orch;

const make = () =>
  createAdapter({
    herdr: createHerdr({ bin: fake.bin, env: fake.env }),
    orch: orch(),
    ticket: "7",
    branch: "ticket-7",
  });
const status = (pane: string) =>
  fake.exec(["pane", "get", pane]).json.result.pane.agent_status;

test("orch snapshot states map to idle, working, blocked or unknown", () => {
  const cases: [Snapshot | null, string][] = [
    [{ state: "running" }, "working"],
    [{ state: "pausing" }, "working"],
    [{ state: "paused" }, "idle"],
    [{ state: "completed" }, "idle"],
    [{ state: "merged" }, "idle"],
    [{ state: "aborted" }, "idle"],
    [{ state: "blocked" }, "blocked"],
    [{ state: "parked" }, "blocked"],
    [{ state: "recovery-needed" }, "blocked"],
    [{ state: "something-new" }, "unknown"],
    [null, "unknown"],
  ];
  for (const [s, expected] of cases) expect(mapState(s)).toBe(expected);
});

test("poll reports the mapped state to Herdr with an increasing seq", async () => {
  const adapter = make();
  const { paneId } = await adapter.start();
  snap = { state: "running", owner: "live" };
  await adapter.poll();
  expect(status(paneId)).toBe("working");
  snap = { state: "blocked", owner: "absent" };
  await adapter.poll();
  expect(status(paneId)).toBe("blocked");
  const seqs = fake
    .log()
    .filter((e) => e.args[1] === "report-agent")
    .map((e) => Number(e.args[e.args.indexOf("--seq") + 1]));
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test("after a Herdr restore the state is re-reported and seq stays monotonic", async () => {
  const adapter = make();
  const { paneId } = await adapter.start();
  snap = { state: "running", owner: "live" };
  await adapter.poll();
  fake.restart();
  expect(status(paneId)).toBe("unknown");
  await adapter.poll();
  expect(status(paneId)).toBe("working");
  const seqs = fake
    .log()
    .filter((e) => e.args[1] === "report-agent")
    .map((e) => Number(e.args[e.args.indexOf("--seq") + 1]));
  expect(seqs.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < seqs.length; i++)
    expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
});
