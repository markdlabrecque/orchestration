export type Identity = { id: string; url: string };
export type Ticket = Identity & { title: string; body: string };
export type PullRequest = Identity & { head: string; merged: boolean };
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
  ): Promise<Identity>;
  readPullRequest(id: string): Promise<PullRequest>;
  ci(id: string, sha: string): Promise<"passed" | "pending" | "failed">;
  merge(id: string, sha: string): Promise<void>;
}
