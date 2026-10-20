import { randomUUID } from "node:crypto";
import { AdapterError } from "./errors.ts";
import { run } from "./process.ts";

const CONTRACT = "orch.control/1";
export const SUPPORTED_MAJOR = 1;

export type Snapshot = {
  runId?: string;
  state: string;
  owner?: string;
  [key: string]: unknown;
};
export type Receipt = {
  requestId: string;
  state: string;
  [key: string]: unknown;
};

export type Orch = ReturnType<typeof createOrch>;

// The only way the adapter reaches orch: its CLI, JSON in and out. Never imports the engine.
export function createOrch(options: {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
}) {
  const call = async (args: string[], input?: string) => {
    const r = await run(options.bin, args, { ...options, input });
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new AdapterError(
        "orch-failed",
        `orch ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  };
  return {
    capabilities: (): Promise<{ supportedMajors: number[] }> =>
      call(["capabilities", "--json"]),
    // Returns null when orch has no run for the ticket yet.
    async snapshot(ticket: string): Promise<Snapshot | null> {
      const r = await call(
        ["control", "--json"],
        JSON.stringify({
          contract: CONTRACT,
          requestId: `snapshot-${randomUUID()}`,
          op: "snapshot",
          params: { ticket },
        }),
      );
      return r.outcome === "answered" ? (r.snapshot ?? null) : null;
    },
    // The receipt for a requestId, or null if orch never recorded it.
    async receipt(requestId: string, ticket: string): Promise<Receipt | null> {
      const r = await call(["request", requestId, "--run", ticket, "--json"]);
      return r.outcome === "answered" ? r.receipt : null;
    },
  };
}

export async function checkContract(orch: Orch): Promise<void> {
  const { supportedMajors } = await orch.capabilities();
  if (!supportedMajors?.includes(SUPPORTED_MAJOR))
    throw new AdapterError(
      "contract-unsupported",
      `orch supports majors ${JSON.stringify(supportedMajors)}; adapter needs ${SUPPORTED_MAJOR}`,
    );
}
