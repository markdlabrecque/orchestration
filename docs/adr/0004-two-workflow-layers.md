---
status: accepted
date: 2026-10-18
---

# Two workflow layers: an editable global file and a committed project patch

A machine has one global workflow, a full file at `~/.config/orchestration/workflow.yaml` that install writes from the shipped default and the owner may edit; `orch workflow reset` restores the shipped default and `orch workflow diff` shows the drift. A project has at most one override, committed at `<repo>/.orchestration/workflow.yaml`, and it is always a patch over the global workflow: an ordered list of ops addressed by step id, plus settings, budgets, repairs and runner entries merged by name. There is no third layer and no way to start from scratch.

## Considered options

- A shipped built-in layer under the user's global file, each layer patching the one below. Rejected: one more place to look for the same answer; a reset command covers upgrades.
- `from: scratch` for a project that wants nothing from the global workflow. Rejected: an unlikely case, and every step kind and runner is still registered globally, so the saving is small.
- A private override in the wrapper folder for repos that cannot carry a committed file. Rejected: overrides are part of the project and belong in its repo.

## Consequences

- A project whose settings match the global defaults commits no file.
- Settings are named values; `when:` lines and step options reference them, and step code never reads them directly.
- Any op that names a missing step, inserts a duplicate id, names an unregistered kind or an undeclared repair rejects the whole file at load. A repair no step uses any more is allowed and reported as unused.
- `orch explain` renders the effective workflow as an HTML page by default and as terminal text with `--simple`; `orch run` writes the same page into the run folder.
