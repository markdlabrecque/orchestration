// Herdr adapter (#173): a hung `pane run` surfaces as a timeout so resend() can take over.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createHerdr } from "../src/adapters/herdr/herdr.ts";

test("pane run that hangs past paneRunTimeoutMs is a timeout AdapterError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-timeout-"));
  try {
    const bin = join(dir, "herdr");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(bin, 0o755);
    const herdr = createHerdr({ bin, paneRunTimeoutMs: 100 });
    await expect(herdr.paneRun("p", ["x"])).rejects.toMatchObject({
      code: "timeout",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
