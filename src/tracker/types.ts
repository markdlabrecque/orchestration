export type Identity = { id: string; url: string };
export type Ticket = Identity & {
  title: string;
  body: string;
  labels?: string[];
};
export type PullRequest = Identity & { head: string; merged: boolean };
// Marker-bearing writes reconcile across every page before creating. Return
// the existing identity on a match; throw on uncertain lookup/write outcomes.
// Absence must be established before retrying creation. Engine persists markers.
export interface Tracker {
  readTicket(ticket: string): Promise<Ticket>;
  assign(ticket: string): Promise<void>;
  comment(ticket: string, body: string, marker: string): Promise<Identity>;
  followUp(title: string, body: string, marker: string): Promise<Identity>;
  pullRequest(
    title: string,
    body: string,
    branch: string,
    base: string,
    marker: string,
    // Draft mode also updates an existing marked PR and converts it to draft.
    options?: { draft?: boolean },
  ): Promise<Identity>;
  readPullRequest(id: string): Promise<PullRequest>;
  ci(id: string, sha: string): Promise<"passed" | "pending" | "failed">;
  // Mark aborted without closing the ticket; repeat calls must be safe.
  abort(ticket: string, marker: string): Promise<void>;
  merge(id: string, sha: string): Promise<void>;
}
