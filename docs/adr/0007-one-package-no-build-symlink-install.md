---
status: accepted
date: 2026-10-18
---

# One TypeScript package, no build step, installed by symlink, shipping only the `orch` command

v2 is one npm package at the repository root: `src/` the engine, `bin/orch` the CLI, `roles/` the role prompts, `workflow.default.yaml` the shipped default, `scripts/worktree/` the kept shell engines with their bash tests, `test/` the engine tests. Node 22.19 or newer runs the `.ts` files directly, so there is no build; `tsc --noEmit` checks types, Biome lints and formats, pnpm installs, vitest runs the tests, and Pi Durable is pinned to an exact version because its API changes often. `scripts/install-local` links the package globally with `pnpm link --global`, so the checkout is the program and updating it is `git pull` plus `pnpm install`; it refuses to link from a ticket worktree. Nothing ships as a Claude Code plugin, a Codex plugin or a Pi package manifest: in phase 1 a person runs `orch run <ticket>` in a terminal and the engine starts the agents itself.

## Considered options

- A monorepo with engine, CLI and runner packages. Rejected: one owner, one deliverable; the seams are modules, not packages.
- A compiled `dist/` published to npm. Rejected for phase 1: a symlinked checkout updates with a pull and shows its commit in `orch --version`.
- Keeping a thin Claude Code or Pi skill that starts runs from a chat. Deferred: it is a wrapper around the same command and belongs to a later phase.

## Consequences

- The first build ticket clears v1 from `v2`: the Python `orch` and its tests, `hooks/`, `pi/`, both plugin folders, the v1 skill and references, `docker/`, old reports, the cleanup and Codex scripts. Kept: the worktree shell engines and their bash tests, `scripts/orch-project.sh`, `.orch` handling, the role prompts, the glossary and ADRs.
- Engine tests use `MemoryStorage`, a fake clock, a fake runner, a fake `exec`, and Pi's fake model provider; no network. One tagged end-to-end run on a fixture repository with fake models.
- A GitHub Actions workflow on `v2` runs the type check, Biome, vitest and the bash suites, and this repository's own override later requires it before merge.
