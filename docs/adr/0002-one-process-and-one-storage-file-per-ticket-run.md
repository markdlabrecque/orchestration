---
status: accepted
date: 2026-10-17
---

# One engine process and one storage file per ticket run, with no lock

Pi Durable lets exactly one process own a storage at a time, and it ships no lock, daemon or attach protocol: opening a storage that another process owns rewrites that process's running tasks. Phase 1 therefore makes the run the unit of ownership: `orch run <ticket>` is a foreground process that owns `<ticket>.sqlite` in the project's wrapper folder for as long as it runs, and the same command resumes a stopped run. There is no long-lived engine per project and no lock file: worktrees already keep one ticket in one place, so the rule "one terminal per ticket" is documented, not enforced.

## Considered options

- One long-lived engine per project taking many tickets. Rejected for phase 1: needs a daemon and a control channel Pi Durable does not provide. Many tickets at once is left for later.
- One storage file per project. Rejected: per-ticket files make ownership trivial and let later parallel runs never share a file.
- A PID lock file beside the storage. Rejected by the owner: no file locks in this workflow; the risk is accepted.

## Consequences

- Watching from another terminal never opens the SQLite. The engine keeps `<ticket>.status.json` and `<ticket>.events.jsonl` up to date and `orch show` / `orch tail` read those.
- A human step asks on the running terminal's stdin; there is no answer, steer or control command in phase 1. Abort is a separate command run after the engine has stopped.
- Starting the same ticket twice at once corrupts the first run silently.
