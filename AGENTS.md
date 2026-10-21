# Agent instructions

## Pushing to GitHub

Pushing over SSH is denied on this machine: the default SSH key belongs to the `marklabrecque-ab` work account, not `markdlabrecque`. Fetching over SSH still works. `gh` is logged in as `markdlabrecque`.

Always push over HTTPS with the `gh` credential helper. Do not change the remote or any git config:

```sh
git -c 'credential.helper=!gh auth git-credential' push https://github.com/markdlabrecque/orchestration.git <branch>
```

- Replace `<branch>` with the branch to push (for example `v2` or `main`).
- Do not use plain `git push` or `git push origin ...`; it fails with "Permission denied to marklabrecque-ab".
- After pushing, run `git fetch -q origin` and `git status -sb` to confirm the local branch matches `origin`.

## Checks

- Run Biome as `node_modules/.bin/biome check .`. `pnpm exec biome` hides real diagnostics behind a misleading "possibly out of memory" message.
- Run `pnpm exec tsc --noEmit` and `pnpm exec vitest run` before pushing.
