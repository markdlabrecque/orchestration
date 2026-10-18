---
status: accepted
date: 2026-10-17
---

# Run the v2 engine on Pi Durable and drop home-grown durability

v1 built its own durability so a ticket survives a dead process: SQLite state behind `orch`, session hooks, liveness checks, stale/resume, STATE.md and per-platform launchers. That machinery is most of the code and the hardest part to keep right across harnesses. Pi Durable (`@earendil-works/pi-durable`) already provides checkpointed tasks, resume after a crash, timers, owned subagent conversations and storage. v2's engine is therefore a Pi Durable program in TypeScript: the workflow runs as Pi Durable tasks, and v2 ships no state database, hooks, liveness, stale/resume, STATE.md or platform launchers of its own. The project puts its effort into the deterministic workflow instead, and makes it pluggable (steps and runners) and overrideable (a global workflow with project overrides).

## Considered options

- Keep the Python `orch` and treat Pi Durable as one more runner. Rejected: keeps the durability burden and two state models.
- Orchestration Lite on T3 Code (plan of 2026-10-09). Superseded: bound to one host and without durability.

## Consequences

- The engine moves from Python to TypeScript. v1 stays on `main` unchanged.
- Pi Durable is marked experimental and its API may change. Pin the version and keep the engine's use of it behind a thin seam.
- Desktop, Orca and Herdr platform support is not carried over.
