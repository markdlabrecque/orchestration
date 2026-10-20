import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterError } from "./errors.ts";
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
  // Where the request file the pane feeds to `orch control` is written.
  requestDir?: string;
  // Wait after an uncertain pane run before querying the receipt, so orch can record it.
  settleMs?: number;
};

// Host-bound adapter: `orch run` is a foreground process in a Herdr pane. Herdr state is
// display only; orch snapshots are the source of truth and the owner never calls Herdr.
export function createAdapter(options: AdapterOptions) {
  const { herdr, orch, ticket, branch } = options;
  const requestDir = options.requestDir ?? join(tmpdir(), "orch-herdr");
  let command: string[] = [];
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
      // A foreground start through the control op, so orch records a receipt. The request
      // goes via a file redirect, which works in any pane shell.
      mkdirSync(requestDir, { recursive: true });
      const file = join(requestDir, `${requestId}.json`);
      writeFileSync(
        file,
        `${JSON.stringify({
          contract: "orch.control/1",
          requestId,
          op: "start",
          params: { ticket, foreground: true },
        })}\n`,
      );
      // One shell-string argument, so herdr never parses `--json` as its own flag.
      command = [`${options.orchBin ?? "orch"} control --json < ${file}`];
      try {
        await herdr.paneRun(paneId, command);
      } catch (error) {
        // Delivery is uncertain after a timeout: resend() checks the receipt first.
        if ((error as AdapterError).code !== "timeout") throw error;
        await new Promise((r) => setTimeout(r, options.settleMs ?? 1000));
        await this.resend();
      }
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
