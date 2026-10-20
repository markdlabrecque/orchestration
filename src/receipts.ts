import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Receipts live beside the run's status file, in the run's existing storage directory.
export type ReceiptStorage = { runs: string; ticket: string };

export type ReceiptState =
  | "accepted"
  | "in-progress"
  | "completed"
  | "failed"
  | "superseded";

export type Receipt = {
  version: 1;
  requestId: string;
  op: string;
  runId: string | null;
  params: Record<string, unknown>;
  state: ReceiptState;
  acceptedAt: string;
  updatedAt: string;
  result?: unknown;
};

export type ReceiptRequest = {
  requestId: string;
  op: string;
  runId?: string | null;
  params?: Record<string, unknown>;
  // Client metadata is accepted and ignored: it is not part of request identity.
  metadata?: unknown;
};

export type RecordOutcome =
  | { outcome: "accepted" | "already-recorded"; receipt: Receipt }
  | {
      outcome: "rejected";
      code: "request-id-conflict";
      message: string;
      receipt: null;
    };

const NEXT: Record<ReceiptState, ReceiptState[]> = {
  accepted: ["in-progress", "completed", "failed", "superseded"],
  "in-progress": ["completed", "failed", "superseded"],
  completed: [],
  failed: [],
  superseded: [],
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

const identity = (r: {
  op: string;
  runId?: string | null;
  params?: Record<string, unknown>;
}) =>
  JSON.stringify(
    canonical({ op: r.op, runId: r.runId ?? null, params: r.params ?? {} }),
  );

export function openReceipts(storage: ReceiptStorage) {
  const dir = join(storage.runs, `${storage.ticket}.requests`);
  const file = (requestId: string) =>
    join(dir, `${encodeURIComponent(requestId)}.json`);

  async function get(requestId: string): Promise<Receipt | null> {
    try {
      return JSON.parse(await readFile(file(requestId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function replace(receipt: Receipt) {
    const target = file(receipt.requestId);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(receipt)}\n`);
    await rename(temp, target);
  }

  return {
    get,
    async record(request: ReceiptRequest): Promise<RecordOutcome> {
      await mkdir(dir, { recursive: true });
      const now = new Date().toISOString();
      const receipt: Receipt = {
        version: 1,
        requestId: request.requestId,
        op: request.op,
        runId: request.runId ?? null,
        params: request.params ?? {},
        state: "accepted",
        acceptedAt: now,
        updatedAt: now,
      };
      try {
        // "wx" makes first-writer-wins atomic across processes.
        await writeFile(
          file(request.requestId),
          `${JSON.stringify(receipt)}\n`,
          {
            flag: "wx",
          },
        );
        return { outcome: "accepted", receipt };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const recorded = await get(request.requestId);
      if (!recorded) throw new Error("Receipt vanished while recording");
      if (identity(recorded) !== identity(request))
        return {
          outcome: "rejected",
          code: "request-id-conflict",
          message: `requestId ${request.requestId} was recorded with different parameters`,
          receipt: null,
        };
      return { outcome: "already-recorded", receipt: recorded };
    },
    async transition(
      requestId: string,
      state: ReceiptState,
      result?: unknown,
    ): Promise<Receipt> {
      const receipt = await get(requestId);
      if (!receipt) throw new Error(`Unknown requestId ${requestId}`);
      if (!NEXT[receipt.state].includes(state))
        throw new Error(`Cannot move receipt ${receipt.state} -> ${state}`);
      const next: Receipt = {
        ...receipt,
        state,
        updatedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result }),
      };
      await replace(next);
      return next;
    },
  };
}
