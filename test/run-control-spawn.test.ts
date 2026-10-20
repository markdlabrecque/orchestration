// #164: the owner is host-bound, so launchRun must not put it in its own session/process group.
import { expect, test } from "vitest";
import { ownerSpawnOptions } from "../src/run-control.ts";

test("owner spawn is not detached, so it shares the host's process group and dies with it", () => {
  const options = ownerSpawnOptions("/tmp");
  expect((options as { detached?: boolean }).detached).toBeFalsy();
  expect(options.stdio).toBe("ignore");
  expect(options.cwd).toBe("/tmp");
});
