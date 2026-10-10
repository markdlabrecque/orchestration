# Orchestration Lite for T3 Code

Status: proposed implementation plan. The direction and local-test policy reflect Mark's decisions in this conversation. Implementation, GitHub changes and installation are not authorized by this document.

Date: 2026-10-09

## Purpose

Add a lightweight, supervised orchestration workflow for use inside T3 Code. Keep the existing Orchestration project and full `orch` CLI intact as the durable, multi-platform option.

Lite uses T3's native agent execution, worktrees, task history and PR monitoring. It adds the coding workflow and the project preparation that T3 does not provide itself. Durability, automatic recovery and unattended batches are not priorities.

Start in the same repository with a separate skill and entry point. Share useful scripts and instructions where their contracts fit. Do not fork the project or promise feature parity with full Orchestration.

## Ownership boundaries

| Responsibility | Owner |
| --- | --- |
| Create Git worktrees and bind threads to them | T3 |
| Choose the worktree storage location | T3, retaining its configured location such as `~/.t3/worktrees` |
| Invoke worktree setup actions | T3 |
| Provider/model discovery, agent launch, cancellation and result delivery | T3 native tools |
| Conversations, task history and PR watches | T3 |
| Ticket scope, stage order, prompts and handoffs | Lite skill |
| Independent review, repair decisions and completion criteria | Lite skill |
| DDEV setup, dependencies, database preparation and project-specific startup | Project scripts and shared Lite CLI helpers |
| Cheap local checks before review | Project test command, selected by the Lite workflow |
| Full and expensive automated test suites | Remote CI |
| Read current-commit CI evidence before an authorized merge | Small CLI helper called by the Lite workflow |
| DDEV teardown and project resource checks before worktree removal | Project scripts and shared Lite CLI helpers |
| Git worktree removal | T3, coordinated with project teardown |

The skill decides what work to perform. Helpers execute narrow operations and return evidence. They do not become another agent supervisor.

Lite must work without initializing the `orch` workflow database or calling its ticket lifecycle commands. Exact helper command names and packaging will be chosen after checking the existing scripts; this plan does not require a new CLI framework.

## Coding workflow

Use the current, correctly bound ticket thread as coordinator. Begin with one ticket at a time.

1. Read the ticket, project instructions, branch and checkout state. Define scope and acceptance criteria.
2. Confirm required project startup has succeeded.
3. Delegate test writing when appropriate. Use unit tests or other cheap tests to establish missing behavior.
4. Delegate implementation. Require the selected cheap local checks to pass before review.
5. Delegate independent, read-only review with the specification, diff, test evidence and prior findings.
6. Repair concrete defects and request a fresh review task. Each round receives the original brief, findings, responses and unresolved objections.
7. Perform additional verification only when the project explicitly requires it. Do not introduce an expensive local automated test gate under a different stage name.
8. Produce a concise report, create or update the PR when authorized, and register it with T3.
9. Let T3 watch remote CI. On wake, inspect the current PR state and evidence before any authorized merge.

Writing stages run serially within a checkout. A completed provider turn does not justify starting another writer while nested or later child work remains active. A wait timeout is not cancellation and does not justify a duplicate task.

Stage prompts must be self-contained. Include the worktree path, scope, file ownership, required outputs and relevant previous evidence. T3's generic role field does not load the existing role files or enforce their tool restrictions.

Use the live provider/model catalog. Keep selection and escalation policy short and explicit. Do not silently substitute an unavailable requested model. A role or model selection is not proof of the child's actual behavior.

### Repair limits and interruptions

Use a small, stated repair limit during the supervised run. A proposed initial default is two repair attempts after the first review; the exact default remains to be confirmed. Review attempts and provider failures are different: an invocation failure without defect findings is not a review rejection.

Never approve unresolved must-fix findings merely because the repair limit has been reached. Stop and report the remaining findings. Do not copy the existing reviewer's two-round autoapproval rule into Lite.

After interruption, inspect T3 history, known task status, commits, uncommitted work and handoff evidence. Continue only when the remaining work and active writers are understood. If the history or outcome is unclear, stop for a supervised decision. There is no automatic coordinator replacement, durable budget enforcement or promise to restore the exact stage.

## Local tests and remote CI

Mark's requirement: **only unit tests or other cheap, relevant checks are required locally before review.**

- Each project identifies a fast local command or small set of commands. The command can include focused unit tests, linting or other inexpensive checks.
- Full suites and expensive integration or end-to-end tests run in remote CI.
- Reviewers inspect the diff and available test evidence. They may run cheap targeted checks, but must not repeat the full suite locally.
- Missing or failed remote evidence must not trigger a full local suite as a fallback.
- If project instructions conflict with the Lite policy, resolve the conflict explicitly before adoption. Do not silently ignore project requirements.

The orchestration repository already skips separate browser and accessibility verification. Its Lite workflow goes from review to report after the required cheap local checks; required remote CI remains a merge gate.

The CI-readiness helper is read-only. It queries the host rather than running tests. It must:

1. Read the current PR head commit and applicable required checks.
2. Verify that passing results apply to that commit.
3. Refuse failed, pending, missing or indeterminate required evidence.
4. Return the checked SHA, verdict and source links.

Immediately before an authorized merge, bind the operation to the checked head through the host's expected-head mechanism. If the candidate changes, reevaluate it. A squash merge commit is distinct from the source commit whose checks passed.

Passing CI is necessary evidence, not authorization to merge. A missing CI configuration requires an explicit project policy or decision; do not treat an empty result as success or invent a local full-suite fallback.

T3 owns PR monitoring. The coordinator links every relevant PR, handles existing feedback, starts the native watch and yields. A wake triggers fresh inspection. Stop watches when handing control back to the user.

## Project startup

T3 already supports setup actions globally within an environment and as project-specific overrides. A repository can declare actions in `t3.json`; project actions can be imported from that file. Confirm the effective action after configuration, since project overrides take precedence over environment defaults.

Example project declaration:

```json
{
  "scripts": [
    {
      "name": "Prepare development environment",
      "command": "bash scripts/setup-worktree.sh",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}
```

`async: false` is essential for required preparation. T3 otherwise defaults to starting the agent while setup runs. Blocking setup waits for the command and prevents agent startup on a nonzero exit.

The setup command runs in the existing worktree. T3 supplies `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH`. The helper must not create a second worktree or relocate T3's checkout.

For DDEV projects, startup should:

1. Resolve the project configuration and exact worktree.
2. Assign or reuse a DDEV identity without collisions.
3. Start DDEV.
4. Install dependencies, such as `ddev composer install`, when configured.
5. Inspect the database. Import the configured dump only when the database is empty.
6. Run the project's required preparation, such as Drupal deployment after a fresh import.
7. Return success only when required preparation has completed.

Project-specific commands belong in a script committed with that project. Shared helpers can implement reusable DDEV behavior. A global T3 action can invoke a convention, but plain repositories must be able to skip DDEV cleanly.

Reuse the existing provision-only engine where practical. Check its project-root resolution and `.orch` assumptions against T3 worktree locations before adopting it. Keep reusable provisioning independent of the full workflow database.

### Startup safety and repeatability

- Setup is safe to rerun and preserves existing databases.
- A failed database inspection is an error, not evidence that the database is empty.
- Database dumps come from an explicitly configured local source. Setup must not fetch data from production or resolve 1Password credentials.
- Reuse a saved DDEV name, including after a branch rename. Naming is an internal concern; uniqueness matters more than readable prefixes.
- Check that an existing DDEV name belongs to the intended checkout before operating on it.
- Report a failed required step clearly and leave enough information for a supervised rerun.

## Cleanup

Reuse project teardown helpers for DDEV and other local resources. T3 continues to own the Git worktree lifecycle.

Before teardown, establish that owned tasks and other writers have stopped, verify the exact checkout/resource identity, and inspect dirty work. Cancellation requests, thread interruption and archival are not interchangeable with proof that all work has stopped.

Run project teardown from a safe context before T3 removes the worktree. Preserve resources if identity, activity or ownership is uncertain. Never delete the checkout of a still-active coordinator.

**An appropriate pre-removal integration has not yet been established.** Do not assume T3's automatic cleanup invokes DDEV teardown. Its settle action is not equivalent to a deletion hook and can run while a terminal command remains active. Begin with explicit, supervised teardown; enable automatic removal for DDEV worktrees only after the ordering is supported and validated.

Small saved resource identities and existing teardown progress records are acceptable. They must not expand into a ticket-stage database or a recovery supervisor.

## Initial deliverables

### A. Separate Lite skill and one serial workflow

- Add a distinct Lite entry point in the existing repository.
- Provide concise stage instructions, native T3 tool usage and the cheap-local-tests policy.
- Remove contradictory review-cap wording from Lite's prompts without changing the full workflow's behavior as an incidental side effect.
- Demonstrate handoffs, independent review, one controlled repair and supervised interruption handling.
- Do not require `orch init`, `spawn`, `run`, `phase` or a separate ordinary coordinator thread.

### B. Current-commit CI-readiness helper

- Implement or reuse a narrow host-facing check with explicit SHA and evidence output.
- Test stale green results, changed PR heads, failed/pending checks and missing evidence using inexpensive fixtures.
- Connect it to native T3 PR watching and an authorized merge path.
- Use this helper as the first real development ticket run through Lite, so the pilot produces retained, useful code.

### C. T3 startup integration and DDEV lifecycle support

- Connect T3 setup actions to the existing project provisioner or a small extracted helper.
- Validate plain-repository startup and a representative DDEV project's configuration.
- Cover repeat setup, preservation of an existing database, failed database inspection, wrong resource identity and required-step failure.
- Define explicit teardown ownership and ordering before enabling automatic cleanup.
- Keep this deliverable independent of the initial plain-repository pilot.

For Lite itself, run its unit and other cheap checks before review. Leave the full repository suite to CI. A source-only or fake-tool test does not prove that live T3 delegation or a real DDEV startup works; record focused pilot evidence separately, with project setup authorization where required.

## Existing project and backlog

Preserve full Orchestration and the version 1.0.0 baseline. Do not remove its SQLite state, hooks, existing platforms, installed plugin or cleanup services as part of establishing Lite.

The earlier T3 integration plan, stored in the project folder outside this repository, and GitHub issues [#72](https://github.com/markdlabrecque/orchestration/issues/72) through [#95](https://github.com/markdlabrecque/orchestration/issues/95) describe a durable T3 adapter for full Orchestration. They are not Lite implementation tickets.

Recommended backlog change, pending authorization: close that batch as superseded or not planned, preserve its history, and create focused Lite tickets from the three deliverables above. Link the replacements and explain the scope decision. Do not mark the unbuilt integration completed. Update the old plan's status only as part of that authorized change.

After a successful pilot, document the two entry points and their tradeoffs. Removing legacy components is a separate decision based on their remaining users, not a prerequisite for Lite.

## Explicitly out of scope

- A new workflow database or mirrored copy of T3 task state.
- Durable repair counters, event receipts or automatic stage restoration.
- Scheduled supervisors, stale-task scans and unattended batch recovery.
- Parallel-ticket capacity management and shared-baseline coordination.
- An external OAuth/MCP client for launching T3 from outside the app.
- A generic orchestration adapter framework.
- Feature parity with full Orchestration.
- Mandatory full local test suites.

## Remaining implementation decisions

- The Lite skill/package name and public helper command names.
- The default supervised repair limit; two repair attempts is the proposal above.
- Each project's cheap local check command and CI requirements.
- Whether each project uses an environment default startup action or its own override.
- The supported teardown connection to T3's worktree removal lifecycle.

These details can be resolved during ticket refinement without reopening the agreed ownership boundaries.
