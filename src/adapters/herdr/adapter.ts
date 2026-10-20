import { randomUUID } from "node:crypto";
import type { Herdr } from "./herdr.ts";
import type { Orch } from "./orch.ts";
import { mapState } from "./state.ts";

export type AdapterOptions = {
  herdr: Herdr;
  orch: Orch;
  ticket: string;
  branch: string;
  // The resolved orch binary to run in the pane; defaults to `orch` on the pane's PATH.
  orchBin?: string;
  // Test hook: called with the requestId whenever a receipt is queried before a re-send.
  onReceiptQuery?: (requestId: string) => void;
};

// Host-bound adapter: `orch run` is a foreground process in a Herdr pane. Herdr state is
// display only; orch snapshots are the source of truth and the owner never calls Herdr.
export function createAdapter(options: AdapterOptions) {
  const { herdr, orch, ticket, branch } = options;
  const command = [options.orchBin ?? "orch", "run", ticket];
  let paneId: string | undefined;
  let requestId: string | undefined;
  // The adapter's own monotonic seq; it never resets, even if Herdr restarts.
  let seq = 0;

  return {
    // List before create: open the worktree if it exists, never create twice.
    async start(): Promise<{ paneId: string; requestId: string }> {
      const existing = (await herdr.worktreeList()).find(
        (w) => w.branch === branch,
      );
      const placement = existing
        ? await herdr.worktreeOpen(branch)
        : await herdr.worktreeCreate(branch);
      paneId = placement.pane_id;
      requestId = `herdr-${ticket}-${randomUUID()}`;
      await herdr.paneRun(paneId, command);
      return { paneId, requestId };
    },

    // Herdr gives no delivery guarantee, so query the receipt before any re-send.
    async resend(): Promise<{ sent: boolean }> {
      if (!paneId || !requestId) throw new Error("start() has not run");
      options.onReceiptQuery?.(requestId);
      if (await orch.receipt(requestId, ticket)) return { sent: false };
      await herdr.paneRun(paneId, command);
      return { sent: true };
    },

    // Reads orch's snapshot and reports it to Herdr. Herdr's state is display only, so when
    // it differs from what orch says (for example `unknown` after a restore) we re-report.
    async poll(): Promise<{ state: string; reported: boolean }> {
      if (!paneId) throw new Error("start() has not run");
      const state = mapState(await orch.snapshot(ticket));
      if (
        (await herdr.paneAgentStatus(paneId)) === state &&
        state !== "unknown"
      )
        return { state, reported: false };
      await herdr.reportAgent(paneId, state, ++seq);
      return { state, reported: true };
    },

    // Never forces: a dirty worktree surfaces dirty_worktree_requires_force.
    async release(): Promise<void> {
      await herdr.worktreeRemove(branch);
    },
  };
}
