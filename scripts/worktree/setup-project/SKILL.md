---
name: setup-project
description: Set up a project folder for orchestration by writing its `.orch` config with every default filled in. Use when asked to set up, initialize or onboard a project for orchestration, or when another orchestration skill reports that `.orch` is missing.
---

# Set up a project

Projects live in `~/Projects/<project-name>/`. Setup accepts an existing checkout inside `code/`, or a checkout at the project root that the user explicitly approves moving into `code/main`:

```
~/Projects/<project-name>/
├── .orch                    # written by this skill
├── .agents/orchestration/   # orch state, created by this skill
└── code/
    └── <main checkout>/
```

## Consent and setup

1. Inspect the layout without changing it. If the project root has a `.git` directory, explain that setup will move the checkout, including `.git`, hidden and untracked files, into `code/main`. The outer folder keeps its name, `.orch` and `.agents` stay there, and Git history and the current branch move with the checkout.
2. Ask for explicit confirmation of that move **before invoking the script or creating any directories**. A general request to set up the project is not relocation approval. If the user declines or has not confirmed, stop with the filesystem unchanged.
3. If `.orch` exists, obtain separate overwrite approval. `--force` grants only that permission, never relocation permission.
4. Run from the project root with `--relocate-checkout` only after move approval. For an already arranged `code/` layout, run from anywhere inside the project without that flag. The script refuses any existing `code` entry during relocation, symlinked Git metadata, and `.git`-file linked worktrees. Resolve conflicts with the user rather than moving or deleting them yourself.

```
${CLAUDE_PLUGIN_ROOT}/skills/setup-project/scripts/setup-project.sh [--force] [--relocate-checkout]
```

The script finds the project root directly under `ORCH_PROJECTS_DIR`, discovers the main checkout in `code/`, and writes `.orch`:

| Key | Default |
|---|---|
| `PROJECT_NAME` | The project folder's name. DDEV names are `<PROJECT_NAME>` for the main checkout and `<id>-<PROJECT_NAME>` for each worktree. |
| `MAIN_CHECKOUT` | `code/<the one git checkout in code/>` |
| `WORKTREE_ROOT` | `code` |
| `BASE_BRANCH` | The main checkout's `origin/HEAD` branch. Empty when that can't be read. |
| `ACCESSIBILITY_TESTS` | `false` |
| `DB_DUMP`, `PROVISION_HOOK`, `RETIRE_HOOK` | Written commented out. No default. |

Relative paths in `.orch` resolve against the project folder.

- Never clone the repository yourself. If neither starting layout has a checkout, tell the user to clone it into `code/`.
- The script refuses when `.orch` exists. Pass `--force` only when the user asked to overwrite it.
- If the script says `BASE_BRANCH` is empty, ask the user which branch to use and set it in `.orch`.

Report the path written and any warning. Show the `.orch` contents.
