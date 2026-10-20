import type { AgentState } from "./herdr.ts";
import type { Snapshot } from "./orch.ts";

// Herdr state is display only; this maps orch snapshot states onto what Herdr can show.
const MAP: Record<string, AgentState> = {
  running: "working",
  pausing: "working",
  paused: "idle",
  completed: "idle",
  merged: "idle",
  aborted: "idle",
  blocked: "blocked",
  parked: "blocked",
  "recovery-needed": "blocked",
};

export function mapState(snapshot: Pick<Snapshot, "state"> | null): AgentState {
  return (snapshot && MAP[snapshot.state]) || "unknown";
}
