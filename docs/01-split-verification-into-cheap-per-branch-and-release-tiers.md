# Workplan: Split verification into cheap per-branch and release tiers

> System of record: **Filesystem**

## Objective

Run only cheap checks (typecheck, Biome, Vitest) on each branch. Defer the Bash and Python suites to a release tier run by the human or release CI, outside the orch workflow.

## Action Plan

1. [ ] Make pnpm check the cheap tier (typecheck, lint, test) in package.json
2. [ ] Add pnpm check:release running pnpm check plus test:bash and test:worktree
3. [ ] Document the two tiers in README.md, AGENTS.md and docs/v2/usage.md
4. [ ] Document settings.tests as the per-project overridable per-branch command
5. [ ] Run tsc, Biome and Vitest to confirm the cheap tier passes
6. [ ] Commit referencing #178 and push to a branch over HTTPS

## Completion Checks

- [ ] Each action-plan item is complete or explicitly deferred.
- [ ] Targeted validation or tests have been run and recorded.
- [ ] Any remaining follow-up is linked to the system of record.
