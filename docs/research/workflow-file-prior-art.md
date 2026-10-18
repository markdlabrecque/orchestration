# Prior art: step lists with loops and overrides in data files

Ticket: [#127](https://github.com/markdlabrecque/orchestration/issues/127) (wayfinder map #125). Date: 2026-10-17.

v2 will run a Ticket through a Workflow: a data file of ordered Steps, each naming a Step kind, a Runner and options, walked by a deterministic Engine that holds the Gates. A Global workflow applies per machine; a Project override patches it (insert, drop, reorder, re-run a step) or starts from scratch. This note surveys how established systems express (a) ordered steps with loops and conditionals in data and (b) layered overrides, measured against what v1 actually did, and ends with three candidate shapes for the v2 file and a recommendation for the prototype session. Every claim links to a primary source (official docs, specs or source code); the link keys resolve in the Sources section at the end.

## What v2 has to express

From v1's `skills/orchestration/references/ticket-pipeline.md` (sections "Phases", "Skip lanes", "Review history and durable repair budgets"):

- The ordered Steps: spec, tests, implement, review, fix, verify, report, mr, ci, then the merge.
- Two repair loops with caps. review -> fix -> review and verify -> fix -> verify share one budget, `bounces`, capped at three successful transitions combined. ci -> fix -> ci has its own budget, `ci_repairs`, capped at two. Review entries themselves are unlimited history. Entering `fix` consumes the slot even if the dispatch or the agent then fails. When a budget is spent the Engine stops dispatching and blocks the ticket for a human; nothing replenishes a budget except an explicit human grant.
- Skip lanes: trivial is spec -> implement; no-code is spec -> implement -> review -> report; a `local-tests` verification environment drops verify.
- Gates: no handoff with any red test; CI green on the exact head commit before merge; a project's `AGENTS.md` can say merges wait for a human.
- Layers: a Global workflow per machine and a Project override that inserts, drops, reorders or re-runs steps, or starts from scratch.

Each system below is measured against those five things.

## Systems

### 1. GitHub Actions

**Ordered steps.** A workflow file has `jobs`: "A workflow run is made up of one or more `jobs`, which run in parallel by default", and "To run jobs sequentially, you can define dependencies on other jobs using the `jobs.<job_id>.needs` keyword" [gha-syntax]. Inside a job, "A job contains a sequence of tasks called `steps`" [gha-syntax] and "Steps are executed in order and are dependent on each other" [gha-understanding]. Order is positional inside a job and graph-shaped (`needs`) between jobs.

**Bounded loop.** It cannot. Neither jobs nor steps can transition backwards; the syntax reference has no loop or goto construct [gha-syntax]. Reusable workflows cannot form a cycle either: "Loops in the workflow tree are not permitted", and "You can connect a maximum of ten levels of workflows" [gha-reuse]. review -> fix -> review (cap 3) is written by unrolling (`review-1`, `fix-1` with `if`, `review-2`, ...), by looping inside one step's shell script, or inside a composite action, where it has to be unrolled again because composite `runs.steps` are also a plain sequence with `if` [gha-metadata]. Matrix is a fan-out, not a loop: "A matrix will generate a maximum of 256 jobs per workflow run", in parallel [gha-syntax].

**Conditionals and skips.** `jobs.<job_id>.if` and `steps[*].if` prevent a job or step from running unless a condition is met; a job whose condition is false "will be marked as skipped" [gha-syntax]. "A default status check of `success()` is applied unless you include one of these functions"; `failure()` "Returns `true` when any previous step of a job fails"; `always()` "Causes the step to always execute" [gha-expressions]. Downstream: "If a job fails or is skipped, all jobs that need it are skipped unless the jobs use a conditional expression" such as `if: ${{ always() }}` [gha-syntax]. `continue-on-error` lets a job pass when a step fails and `timeout-minutes` caps a step at 360 minutes [gha-syntax]. There is no retry keyword; `strategy.fail-fast` (default `true`) cancels the rest of a matrix when one job fails [gha-syntax].

**Second layer.** Two mechanisms, both "call", neither "patch". A job can `uses` a reusable workflow and pass only `with` inputs and `secrets`; "You cannot use contexts or expressions in this keyword" [gha-syntax] [gha-reuse]. A step can `uses` a composite action whose `runs.steps` are fixed by the action's author [gha-metadata]. The caller decides whether to call and what to pass; it cannot insert, drop or reorder steps inside the callee. Steps are addressed by `id` ("A unique identifier for the step. You can use the `id` to reference the step in contexts") and jobs by `job_id`, which "must start with a letter or `_` and contain only alphanumeric characters, `-`, or `_`" [gha-syntax]. There is no file-level include or override.

**Failure modes.** `needs` naming a job that does not exist fails at parse time: the parser reports "Job 'x' depends on unknown job 'y'." and a cycle "creates a cycle in the dependency graph." [gha-parser]. Skips propagate quietly through `needs` unless a job opts out with `always()` [gha-syntax]. The reference says a step `id` is unique but does not say what a duplicate does [gha-syntax].

### 2. GitLab CI

**Ordered steps.** Jobs are top-level keys ordered by `stages`: "The order of the items in `stages` defines the execution order for jobs", "Jobs in the same stage run in parallel", "Jobs in the next stage run after the jobs from the previous stage complete successfully"; default stages are `.pre`, `build`, `test`, `deploy`, `.post` [gl-yaml]. `needs` starts a job earlier than its stage, and "Relationships between jobs that use `needs` can be visualized as a directed acyclic graph", with at most 50 needs per job [gl-yaml]. Inside a job, `script` is an ordered array of shell lines.

**Bounded loop.** It cannot loop between jobs. The nearest primitive is `retry`, which re-runs the same job: `retry:max` is "`0` (default), `1`, or `2`", narrowed by `retry:when` and `retry:exit_codes` [gl-yaml]. review -> fix -> review is therefore (a) one job whose `script` loops in shell, (b) three unrolled job pairs gated by `rules`, or (c) a child pipeline (`trigger:include`) that the parent re-triggers [gl-yaml]. `retry` re-runs the same job with nothing in between, so it covers flakiness, not repair.

**Conditionals and skips.** `rules` is ordered: "Rules are evaluated when the pipeline is created, and evaluated in order. When a match is found, no more rules are checked"; a match with `when: never`, or no match at all, means "the job is not added to the pipeline" [gl-yaml]. Conditions are `rules:if`, `rules:exists` and `rules:changes`, each capped at 50 patterns [gl-yaml]. `when` takes `on_success` (default), `on_failure`, `always`, `never`, `manual`, `delayed` [gl-yaml]. `needs:optional: true` tolerates a needed job that sometimes does not exist; without it "the pipeline fails to start" [gl-yaml].

**Second layer.** Three mechanisms, all merges.

- `include` pulls local, project, remote, template or component files. "Included files are read in the order defined in the configuration file", nested includes merge first, and "the configuration in the `.gitlab-ci.yml` file takes precedence over the included configuration" [gl-yaml] [gl-includes]. "If parameters overlap, the last included file takes precedence" [gl-includes]. Limits: 150 includes per pipeline including nested, 30 seconds to resolve [gl-yaml]. `include:rules` makes an include conditional [gl-yaml].
- `extends` makes a job inherit from one or more (usually hidden `.name`) jobs. It "Performs a reverse deep merge based on the keys" and "Doesn't merge the values of the keys" [gl-yaml]; hashes merge, arrays such as `script` and `tags` are replaced, and "Keys from the last member always override anything defined on other levels" [gl-opt]. It "supports up to eleven levels of inheritance, but you should avoid using more than three levels" [gl-yaml]. To drop an inherited key "you must assign it to `null`" [gl-opt].
- `!reference` is a custom YAML tag that copies a value from any job, included ones too, into `script`, `rules`, `before_script` and similar arrays, nested up to 10 levels; other keywords raise a "config should be an array of" validation error [gl-opt].

Addressing is by job name and keyword path. Nothing addresses one element of an array: merging "cannot add or modify individual items in an array", so to add one line to an included `script` you repeat the whole array (the docs' `notify_owner` example) [gl-includes].

**Failure modes.** A missing `extends` target is a hard error from the config layer, "<job>: unknown keys in extends (...)"; more than ten ancestors raises "nesting too deep in extends"; a cycle raises "circular dependency detected in extends" [gl-extends-src]. A typo in an overriding job name silently defines a new job instead of overriding the intended one, because includes merge by key [gl-includes]. Including a file twice is not an error: "The last time the configuration is included overrides any previous times the file was included" [gl-includes]. Array replacement is the common quiet surprise: overriding `rules` or `script` in the main file drops every included entry [gl-includes].

### 3. Argo Workflows

**Ordered steps.** A `steps` template is a list of lists: the outer list runs in order, the inner list in parallel ("double dash => run after previous step", "single dash => run in parallel with previous step") [argo-steps]. A `dag` template lists tasks with `dependencies` or `depends`; "By default, DAGs fail fast" [argo-dag]. `depends` can test results: `.Succeeded`, `.Failed`, `.Errored`, `.Skipped`, `.Omitted`, `.Daemoned`; a bare task name means `(task.Succeeded || task.Skipped || task.Daemoned)` [argo-depends].

**Bounded loop.** Argo is the one CI-style YAML system that expresses review -> fix -> review in data, through recursion: "Templates can recursively invoke each other!" The `coinflip` template calls itself from a step guarded by `when: "{{steps.flip-coin.outputs.result}} == tails"` [argo-rec]. The docs state no recursion limit; the loop ends when its `when` stops matching [argo-rec]. The cap is the author's job: pass a `round` parameter into the recursive call, increment it with an expression tag (`{{=...}}`, evaluated by expr with Sprig functions) and guard the recursive step on it [argo-vars] [argo-cond]. The docs warn that "many Sprig functions don't raise errors"; an invalid `int` input returns `0` [argo-vars]. Sketch, with the counter arithmetic as the docs' `asInt` example suggests:

```yaml
- name: review-fix
  inputs: { parameters: [{ name: round }] }
  steps:
    - - name: review
        template: review
    - - name: fix
        template: fix
        when: "{{steps.review.outputs.result}} == findings"
    - - name: again
        template: review-fix
        when: "{{steps.review.outputs.result}} == findings && {{inputs.parameters.round}} < 3"
        arguments:
          parameters:
            - { name: round, value: "{{=asInt(inputs.parameters['round']) + 1}}" }
```

Argo's own `retryStrategy` repeats the same node with nothing in between: `limit` "is the maximum number of retry attempts when retrying a container. It does not include the original container; the maximum number of total attempts will be `limit + 1`" [argo-types]; `retryPolicy` is `Always`, `OnFailure` (default), `OnError` or `OnTransientError`, and `expression` can inspect `lastRetry.exitCode`, `.status`, `.duration` and `.message` [argo-retries]. `withItems`, `withParam` and `withSequence` are fan-outs ("invoke print-message once for each item in parallel"), not sequential loops [argo-loops].

**Conditionals and skips.** `when` on a step or task is a govaluate expression over outputs, for example `when: "{{steps.flip-coin.outputs.result}} == heads"`, with `&&`, `||` and `=~` [argo-cond]. A skipped task has status `.Skipped`, which dependents can test [argo-depends].

**Second layer.** A `WorkflowTemplate` is run through `workflowTemplateRef`; the caller passes `arguments` ("it will be merged with workflow template arguments") and may set `entrypoint` [argo-wt]. A step can call into another template with `templateRef: { name, template }` plus `arguments` [argo-wt]. The caller supplies parameters; the docs show no way to insert, drop or reorder the referenced template's steps [argo-wt]. Steps are addressed by `name` within a template, templates by `name` within a WorkflowTemplate.

**Failure modes.** Validation is loud: a reference to a missing template fails with `template name '%s' undefined`; duplicate step names with `templates.%s.steps[%d].name '%s' is not unique`; a DAG cycle with `templates.%s.tasks dependency cycle detected` [argo-validate]. Recursion is unbounded unless the author bounds it, and an expression bug can quietly coerce to `0` [argo-vars]. Parameter values containing quotes can break a govaluate `when` [argo-cond].

### 4. Tekton

**Ordered steps.** A `Pipeline` lists `tasks`; order comes from `runAfter` ("Indicates that a `Task` should execute after one or more other `Tasks` without output linking") or from consuming another task's result [tekton-pipelines]. A `Task` holds ordered `steps` (containers). Each pipeline task has a `name`.

**Bounded loop.** It cannot. The pipeline is a DAG and the graph builder rejects cycles ("cycle detected") [tekton-dag]. `retries` re-runs the same task: "you can specify the number of times Tekton should retry its execution when it fails" [tekton-pipelines]. A real loop needs a custom task: the experimental `TaskLoop` "allows users to run a `Task` in a loop with varying parameter values", iterates a fixed list, stops at the first failure, and its repository was archived on 5 December 2024 [tekton-taskloop]; "Pipeline Loops" appears in the list of known custom tasks [tekton-pipelines]. review -> fix -> review is unrolled or scripted inside one task.

**Conditionals and skips.** `when` expressions have `input`, `operator` (`in` or `notin`) and a non-empty `values` list; when false "the `Task` is not run and the `Task` is listed in the" skipped tasks [tekton-pipelines]. Dependents: "The ordering-dependent `Tasks` will be executed" and "The resource-dependent `Tasks` (and their dependencies) will be skipped because of missing `Results`" [tekton-pipelines]. `finally` tasks "are guaranteed to be executed in parallel after all `PipelineTasks` under `tasks` have completed", may carry `when` on `$(tasks.<name>.status)`, and "no `runAfter` can be specified in `finally` tasks" [tekton-pipelines]. `onError: continue` keeps the run going, and "Setting `Retry` and `OnError:continue` at the same time is **NOT** allowed" [tekton-pipelines].

**Second layer.** `taskRef` and `pipelineRef` with resolvers (git, bundles, cluster) fetch definitions from elsewhere; the caller passes `params` and `workspaces` and cannot edit the referenced steps [tekton-pipelines]. There is no patch facility; a project that wants a different order writes a different Pipeline.

**Failure modes.** Duplicate task names are rejected at admission (`ErrMultipleOneOf("name")` over the `tasks` list) [tekton-validate]; a `runAfter` naming a missing task fails with `task %s depends on %s but %s wasn't present in Pipeline` [tekton-dag]; `finally` with `runAfter` is rejected [tekton-validate]. A skipped task's resource-dependents are skipped quietly, which reads like a silent no-op [tekton-pipelines].

### 5. Temporal

**Ordered steps.** Steps are code. "A Workflow Definition is the code that defines your Workflow" in Go, Java, TypeScript or Python [tmp-workflows]; "Workflow Definitions are _just functions_, which can store state and orchestrate Activity Functions" [tmp-basics]. Order is the order of awaits. The constraint is determinism: the code must make "the same Workflow API calls in the same sequence, given the same input", and non-deterministic work goes in Activities ("put them in Activities") [tmp-def].

**Bounded loop.** An ordinary loop with an ordinary counter. It is deterministic because the branch inputs are Activity results recorded in the Event History, which is "the source of truth for everything that happens in the Workflow" [tmp-workflows] [tmp-def]:

```ts
for (let round = 1; round <= 3; round++) {
  const verdict = await review();
  if (verdict === "pass") break;
  await fix(verdict);
}
```

Activities retry by default: "Temporal's default behavior is to automatically retry an Activity" under a policy of Initial Interval, Backoff Coefficient, Maximum Interval, Maximum Attempts and Non-Retryable Errors, where "Setting the value to 0 also means unlimited"; "Workflow Executions do not retry by default" [tmp-retry] [tmp-failure]. Long loops checkpoint with Continue-As-New: "the latest relevant state is passed to a new Workflow Execution, with a fresh Event History" [tmp-can].

**Conditionals and skips.** Plain `if`, as long as the inputs are replay-safe: "a re-executed Workflow Function will issue the same sequence of Commands, even if there is branching involved" [tmp-def].

**Second layer.** None in data. Changing behaviour means changing code, and changing code under running executions needs `patched()`: "Using `patched` inserts a marker into the Event History", old executions keep the old branch, and `deprecatePatch` retires it later; Worker Versioning is "the recommended way to handle versioning" [tmp-versioning] [tmp-def]. Steps are addressed by position in the replay sequence, which is why "adding, removing, or reordering `await` calls on Command-producing APIs such as Activities and timers" causes a nondeterminism error [tmp-versioning].

**Failure modes.** Reordering is loud: a nondeterminism error on replay [tmp-versioning]. Workflow Type names are scoped by Task Queue, and "It is acceptable to have the same Workflow Type name map to different Workflow Definitions" on different Workers [tmp-def], so collisions are a deployment matter, not a validation one.

### 6. Inngest

**Ordered steps.** Code again, but each step is a named, memoised call: `step.run(id, handler)`, where `id` "is used to memoize step state across function versions" [inn-run]. "Inngest saves the result of each completed step"; "When the handler runs again, the SDK returns the saved `order` without calling `getOrder` again"; "Code outside steps can run again" [inn-steps].

**Bounded loop.** An ordinary loop, and repeated IDs are allowed: "The SDK counts repeated calls to the same step ID, so each iteration has its own saved result", with the rule "Keep step IDs and the order of iterations stable for in-progress runs" [inn-loops]. Retries are per step: "The `retries` setting applies independently to each `step.run()`", "The default is four retries after the initial attempt", `retries: 0` disables them, and `NonRetriableError` and `RetryAfterError` steer them [inn-retries] [inn-run].

```ts
for (let round = 1; round <= 3; round++) {
  const verdict = await step.run("review", () => review(round));
  if (verdict === "pass") break;
  await step.run("fix", () => fix(verdict));
}
```

**Conditionals and skips.** Plain code.

**Second layer.** None in data. A step's identity is its ID: "If you need an active run to execute changed step logic, changing the ID makes it new work" [inn-steps]. The docs point at versioning before changing IDs in a deployed function [inn-steps].

**Failure modes.** The quiet one is renaming an ID: an in-flight run treats it as a new step and runs it again [inn-steps]. The counter format for repeated IDs is not documented, only its existence [inn-loops].

### 7. Kustomize and strategic merge patch

**Ordered steps.** Not a step system; it is the reference for layered overrides of structured data. A `kustomization.yaml` has `resources` (the base) and `patches`: "The `patches` field contains a list of patches to be applied in the order they are specified" [kz-patches]. Each patch is a strategic merge patch or a JSON 6902 patch, inline (`patch:`) or from a file (`path:`), optionally with a `target` selector over `group`, `version`, `kind`, `name`, `namespace`, `labelSelector` and `annotationSelector`; "Any resource which matches all the **specified** fields has the patch applied to it", and `name` and `namespace` are anchored regular expressions [kz-patches]. A JSON 6902 patch requires `target` [kz-patches] [kz-pt].

**Bounded loop.** Not applicable.

**Conditionals and skips.** None in the format. Components let an overlay opt in to "reusable pieces of configuration logic" declared with `kind: Component` [kz-components].

**Second layer and list addressing.** Strategic merge patch is the part that matters for a list of steps. Lists are merged by a merge key declared on the Go type: "the `patchStrategy` metadata for the `containers` field would be `merge` and the `patchMergeKey` would be `name`" [smp]. Directives: `$patch: delete` on a list item removes the items with that key ("Delete operation will delete all entries in the list that match the merge key"); `$patch: replace` replaces instead of merging; `$setElementOrder/<key>` fixes the resulting order ("The relative order specified in this directive will be retained"); `$deleteFromPrimitiveList` and `$retainKeys` cover primitives and unions [smp]. Lists with the default strategy are replaced whole, and merged lists are "treated as an unordered set" unless `$setElementOrder` says otherwise [smp]. The document is marked "old and probably obsolete" with a pointer to Server-side Apply [smp]. JSON 6902 patches address list items by index (section 8).

**Failure modes.** From the current source: a strategic merge patch without `target` is matched by its own group, version, kind and name, and a miss is an error, "no resource matches strategic merge patch" [kz-pt]. A patch with a `target` selector goes through `Select`, which returns an empty list and no error when nothing matches, and the transformer then applies the patch to zero resources: a silent no-op for selector-targeted JSON 6902 and strategic merge patches alike [kz-pt] [kz-rw]. A patch that parses as both kinds is rejected ("illegally qualifies as both an SM and JSON patch") [kz-pt]. Order among merged list items is defined only when `$setElementOrder` is given [smp].

### 8. JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396)

**JSON Patch.** A patch is an ordered array of operations, `add`, `remove`, `replace`, `move`, `copy`, `test`, and "Operations are applied sequentially in the order they appear in the array" [rfc6902]. Arrays are addressed by index: `add` at an index inserts and "Any elements at or above the specified index are shifted one position to the right", `-` appends, and "The specified index MUST NOT be greater than the number of elements in the array" [rfc6902]. For `remove` and `replace`, "The target location MUST exist for the operation to be successful"; for `move`, "The "from" location MUST exist" and it "MUST NOT be a proper prefix of the "path" location" [rfc6902]. `test` guards: "The target location MUST be equal to the "value" value for the operation to be considered successful" [rfc6902]. On any failure evaluation "SHOULD terminate" and application of the entire patch "SHALL NOT be deemed successful"; over HTTP PATCH the whole thing is atomic [rfc6902].

For a step list: insert-after-review is `{op: add, path: /steps/4, value: ...}`, right only while review sits at index 3; drop is `remove` by index; reorder is `move`. A missing target fails loudly, but a wrong index quietly hits the wrong step. `test` can guard against that (`{op: test, path: /steps/3/id, value: review}`), at the cost of two ops per edit.

**JSON Merge Patch.** RFC 7396 obsoletes 7386 ("Obsoletes: 7386") with the same algorithm [rfc7396]. The patch is a document shaped like the target: objects merge recursively, "Null values in the merge patch are given special meaning to indicate the removal of existing values in the target", and "it is not possible to patch part of a target that is not an object, such as to replace just some of the values in an array" [rfc7396]. A merge patch cannot insert, drop or reorder one step in a list; it can only replace the list, and it cannot store a null. It fits step options (a map), not step order.

### 9. Helm values

**Second layer only.** Values are layered by precedence: "`values.yaml` is the default, which can be overridden by a parent chart's `values.yaml`, which can in turn be overridden by a user-supplied values file, which can in turn be overridden by `--set` parameters" [helm-values]. With several `-f` files, "The priority will be given to the last (right-most) file specified", and likewise for `--set` [helm-install]. Deletion is by null: "you may override the value of the key to be `null`, in which case Helm will remove the key from the overridden values merge" [helm-values]. The merge rule, from the source: "Scalar values and arrays are replaced, maps are merged" [helm-coalesce]. Subcharts see their own scoped section, and `global` values are visible to every chart by the same name [helm-sub].

**Failure modes.** Replacing arrays is the same trap as GitLab: a values file that touches one element of a list replaces the list [helm-coalesce]. A misspelled key creates a new key instead of overriding one, and the layering itself reports nothing. Lists have no addressing.

### 10. Pi Durable

**Ordered steps.** Pi Durable is the v2 Engine's substrate (ADR 0001), not a workflow format, so what matters is its task model and its own layering. A Task is "a durable state machine that saves a checkpoint at every step, so a restarted process continues from the last one" [pi-readme]. A definition has `name`, `version`, `initial` and `phases`; "a phase reruns from its top after a restart, so work after the wait goes in the next phase, and what it needs goes in the checkpoint" [pi-readme]. Task states are `pending`, `running`, `waiting` on owned tasks with a `JoinPolicy` of `failFast` or `allSettled`, `sleeping` until a time, `completing` and `terminal` [pi-spec]. A crash-looping task is parked once it hits `settings.restartLimit` (default 5) and `retryTask(id)` runs it again [pi-readme].

**Bounded loop.** A loop lives in the checkpoint: a state such as `{ phase: "review", round: 2, bounces: 1 }` that the phase code reads and advances, re-entering the same phase name. The task model names phases, not steps; naming steps is the Engine's job.

**Second layer.** An Extension is "a named bundle of tools, system prompt sections, hooks, wrappers, and tasks" [pi-readme]. The rules:

- Install replaces by name. `install(extension)` "Installs `extension`, or replaces the installed extension with its name in place. Publishes at once"; `uninstall(extension)` "Removes the installed extension with `extension.name`, whichever object it is. A later install appends" [pi-spec] [pi-readme].
- Selection is per conversation. `configure({ extensions: { add, remove } })` "edits the host default; an array selects exactly these, in order", and `null` clears a field back to the host default [pi-readme]. Resolution: "base = settings.extensions ?? every installed extension; in that order", "array: exactly these, in array order; { add, remove }: base, then add appended, minus remove", and "duplicates keep their first position; names not installed are skipped" [pi-spec].
- Tools layer by name: "the selected extensions' tools in extension order; a later same-name tool replaces an earlier one in place", then wrappers; "`wrapTool()` decorates whichever tool won" [pi-spec] [pi-readme].
- Install validates: "Task names are unique across the built-in tasks and every installed extension. `install()` validates the registry as it would be after the replacement, including the rules above, and throws without publishing anything when it is invalid"; "Tool names and section keys are unique within one extension; across extensions they may repeat" [pi-spec].
- Running work keeps old code: "a running tool call finishes under its old implementation, and each task phase resolves hooks and the agent once, from the registry at the phase's start" [pi-readme].

**Failure modes.** Replace-by-name is the only merge: there is no partial patch of an extension, so a project that wants one different tool installs an extension whose same-named tool wins. Selecting a name that is not installed is skipped without error [pi-spec], and conversations that select an uninstalled extension "just stop getting it until it is installed again" [pi-readme]: stored names outlive code with no complaint. Whether `uninstall` of an unknown name errors is not stated.

### 11. Amazon States Language (added)

Why: it is the most used data-only workflow language whose loop is a first-class transition, and its validation rules are exactly the failure modes the ticket asks about.

**Ordered steps.** A state machine is a JSON object of named `States`. Execution starts at `StartAt`, which "MUST match exactly the name of one of the "States" fields", and each non-terminal state names its successor in `Next`, whose value "MUST exactly and case-sensitively match the name of another state", or sets `End: true` [asl]. Order is a graph of names, not a list.

**Bounded loop.** A `Choice` state ("MUST have a "Choices" field whose value is a non-empty array") with a rule whose `Next` points at an earlier state; "States can have multiple incoming transitions from other states" [asl]. The cap is a counter in the state data that a Choice rule compares; there is no loop keyword. Same-state retries are `Retry` with `ErrorEquals` and `MaxAttempts` ("default: 3"), then `Catch` with `Next` [asl]. `Map` fans out under `MaxConcurrency` [asl]. Sketch:

```json
"Review":   { "Type": "Task", "Resource": "review", "ResultPath": "$.verdict", "Next": "Verdict" },
"Verdict":  { "Type": "Choice",
              "Choices": [
                { "Variable": "$.verdict", "StringEquals": "pass",  "Next": "Report" },
                { "Variable": "$.bounces", "NumericLessThan": 3,    "Next": "Fix" } ],
              "Default": "BlockForHuman" },
"Fix":      { "Type": "Task", "Resource": "fix", "Next": "CountBounce" },
"CountBounce": { "Type": "Pass", "Next": "Review" }
```

**Conditionals and skips.** `Choice` rules match in order; with no match and no `Default`, "The interpreter will throw a runtime States.NoChoiceMatched error" [asl]. `Pass` "passes its input to its output, performing no work" [asl].

**Second layer.** None; a definition is whole.

**Failure modes.** "The state name MUST be unique within the scope of the entire state machine", and `Next` and `StartAt` must name existing states, so a dangling transition is invalid at definition time [asl]. A Choice with no match and no Default fails at run time, not at validation [asl].

### 12. Ansible (added)

Why: a YAML list of ordered tasks with a bounded retry loop on one task is the closest existing thing to the v2 file, and it shows where that form stops.

**Ordered steps.** A play is a list of tasks run in order. `block` groups tasks under shared directives, `rescue` tasks run "when an earlier task in a block fails", and `always` tasks run regardless [ans-blocks].

**Bounded loop.** `until` on one task: "You can use the `until` keyword to retry a task until a certain condition is met", with `retries` and `delay`; "The default value for "retries" is 3 and "delay" is 5"; the registered result records `attempts` [ans-loops]. The docs call `loop` and `with_*` "for loops" and `until` "a while/until loop" [ans-loops]. The limit: `until` repeats a single task, and a block accepts most task directives "with the exception of loops" [ans-blocks]. review -> fix -> review as two tasks cannot be looped in data; you fold fix into the same task, or loop over `include_tasks`, which is file-level recursion rather than a construct.

**Conditionals and skips.** `when` on a task or block; "a `when` statement is applied to the tasks within a block, not to the block itself" [ans-blocks].

**Second layer.** Roles and variable precedence; a role's task list is included whole, not patched.

**Failure modes.** A loop on a block is unsupported rather than a quiet no-op [ans-blocks].

## Comparison

| System | Steps written as | review -> fix -> review, cap 3 | Conditional / skip | Second layer | Step addressing | Missing target | Order ambiguity | Collisions |
|---|---|---|---|---|---|---|---|---|
| GitHub Actions | positional `steps`; `needs` DAG of jobs | cannot; unroll or script | `if` + status functions | call (`uses` reusable workflow or composite); no patch | `id`, `job_id` | unknown `needs` job: parse error | none inside a job | duplicate step id not documented |
| GitLab CI | job map + `stages`; `needs` DAG; `script` array | cannot; `retry` re-runs the same job; unroll or child pipeline | ordered `rules`, first match wins | `include` deep merge, `extends` reverse deep merge, `!reference` | job name + keyword path | `extends` unknown key: error; override typo: new job, no error | arrays replaced, never merged | last include wins |
| Argo | steps list of lists; DAG `depends` | yes, by recursion plus a hand-kept counter; no built-in cap | `when` expressions | `workflowTemplateRef`, `templateRef` with arguments; no patch | `name` | undefined template: error | none | duplicate step name: error |
| Tekton | DAG `tasks` + `runAfter`; `finally` | cannot; `retries` same task; custom task (archived) | `when` in/notin; skips propagate | `taskRef` resolvers; no patch | `name` | missing `runAfter` target: error | none | duplicate name: error |
| Temporal | code, order of awaits | plain `for`, deterministic | plain `if` | code plus `patched()` | replay position | n/a | reorder = nondeterminism error | type names per task queue |
| Inngest | code, `step.run(id)` | plain `for`; repeated ids counted | plain `if` | code; id change = new step | step `id` plus count | n/a | stable ids required | repeated id counted |
| Kustomize / SMP | n/a (overlay of data) | n/a | components opt in | ordered `patches`; SMP merge key, `$patch: delete`, `$setElementOrder` | merge key, 6902 path, `target` selector | SMP by identity: error; selector miss: silent no-op | merged lists unordered without `$setElementOrder` | n/a |
| RFC 6902 | n/a | n/a | `test` guard | ordered ops | JSON Pointer, array index | `remove`, `replace`, `move` on missing: error | index drift after insert | n/a |
| RFC 7396 | n/a | n/a | n/a | shaped merge, null deletes | object keys only | silent (adds a key) | arrays replaced | n/a |
| Helm values | n/a | n/a | n/a | precedence chain, last wins, null deletes | map keys | silent (adds a key) | arrays replaced | n/a |
| Pi Durable | task phases + checkpoint | counter in the checkpoint | code | install replaces by name; `configure` add/remove; later tool wins; `wrapTool` | extension, tool, task `name` | install validates and throws; selecting an unknown name: skipped | install order | task names unique; tools later-wins |
| ASL | named states, `Next` graph | `Choice` back-edge plus counter | `Choice` ordered rules | none | state name | dangling `Next`: invalid | n/a | unique names required |
| Ansible | task list; blocks | `until` and `retries` on one task only | `when` | roles, includes | n/a for patching | n/a | n/a | n/a |

## What this says for v2

1. Nobody patches a step list well with merge semantics. Every merge-based layer (GitLab `include` and `extends`, Helm, RFC 7396, strategic merge) either replaces arrays whole or needs a merge key plus an order directive, and every one of them turns a typo into a new key without complaint. Ordered operations (RFC 6902, Kustomize `patches`) fail loudly on a missing target; their weakness is positional addressing, which Kustomize mitigates with selectors and Argo, Tekton and ASL avoid with unique names.
2. Loops in data come in two forms only: a back-edge in a named graph (ASL `Choice`, Argo recursion) with a counter the author keeps, or a retry attribute on one node (GitLab `retry`, Argo `retryStrategy`, Tekton `retries`, Ansible `until`). The first is general but the format does not enforce the cap; the second enforces a cap but repeats one node with nothing in between. v1's loops are "run a repair step, then run me again", with a budget shared by several senders, which neither form says directly. A step-level repair edge with a named budget is the smallest construct that does.
3. Code-defined systems (Temporal, Inngest, Pi Durable) get loops for free and pay in override: the only layering is replace-by-name, and step identity across versions is a known pain (Temporal patches, Inngest stable ids).
4. The loud validators all make the same four checks at load time: unique names, every reference resolves, no cycles outside declared loops, no unknown kinds (Argo, Tekton, ASL, GitLab `extends`, GitHub `needs`).
5. Pi Durable fixes some Engine facts: steps will run as task phases or owned tasks keyed by name, so a step that runs three times needs three distinct keys (Inngest's counting), and budgets belong in the checkpoint.

## Candidate shapes for v2

Shared by all three sketches: a file is `version`, `budgets`, `steps`; a step has `id`, `kind`, `runner`, `options`, optional `when` and `gate`; a step kind declares its outcome names (an agent review step yields `pass` or `findings`, a ci step `passed` or `failed`); `pass` falls through to the next step, and any outcome without a mapping blocks the ticket, so the default fails closed. Kind and runner names are illustrative. Each sketch shows the Global workflow, then a Project override that inserts a verify step after review and drops nothing. To keep the sketches short the Global workflow carries no verify step and the project adds one; v1 carried verify in the global pipeline gated by preflight, and all three shapes could do that with a `when`.

### Shape A: flat list, ids, repair edges, named budgets, op-list override

```yaml
# Global workflow: ~/.config/orchestration/workflow.yaml
version: 1
budgets:
  bounces:    { max: 3, exhausted: block }   # review -> fix and verify -> fix, combined (v1 `bounces`)
  ci_repairs: { max: 2, exhausted: block }   # ci -> fix (v1 `ci_repairs`)
steps:
  - id: spec
    kind: agent
    runner: pi
    options: { agent: spec-writer }
  - id: tests
    kind: agent
    runner: claude-code
    options: { agent: test-writer }
    when: lane not in [trivial, no-code]
    gate: tests-red
  - id: implement
    kind: agent
    runner: claude-code
    options: { agent: implementor }
    gate: tests-green
  - id: review
    kind: agent
    runner: claude-code
    options: { agent: reviewer }
    when: lane != trivial
    on:
      findings: { repair: fix, budget: bounces }   # run fix, then run review again
  - id: fix
    kind: agent
    runner: claude-code
    options: { agent: implementor, fresh: true }
    trigger: repair                                 # never runs in the plain walk
    gate: tests-green
  - id: report
    kind: agent
    runner: claude-code
    options: { agent: reporter }
  - id: mr
    kind: shell
    runner: shell
    options: { script: orch-open-mr }
  - id: ci
    kind: ci
    runner: shell
    gate: ci-green-on-head
    on:
      failed: { repair: fix, budget: ci_repairs }
  - id: merge
    kind: merge
    runner: shell
    when: project.merge == auto
    else: { block: awaiting human merge }
```

```yaml
# Project override: <repo>/.orchestration/workflow.yaml
version: 1
extends: global            # or `from: scratch` with a full `steps:` list
patch:
  - op: insert_after
    step: review
    value:
      id: verify
      kind: agent
      runner: claude-code
      options: { agent: verifier, env: docker, a11y: on }
      on:
        findings: { repair: fix, budget: bounces }   # shares v1's combined budget
```

Patch ops: `insert_before`, `insert_after`, `drop`, `replace`, `move_before`, `move_after`, `set` (merge one step's fields RFC 7396 style, null deletes), each addressed by `step: <id>`; `from: scratch` replaces the list. Loader rules: every `step:` names an existing id (else error, as RFC 6902 `remove` and `replace`); every inserted id is new (else error, as Argo and Tekton); every `repair:` target exists and carries `trigger: repair` (else error, as Tekton's missing `runAfter` target); every `budget:` is declared with a finite `max`; every `kind` is registered (else error, as Argo's undefined template); ops apply in order and the whole file is rejected at the first failure (RFC 6902 section 5).

Trade-offs:

- Readability: the list is the order; one line on the detecting step says what happens on findings. The cost is that `fix` sits in the list but only runs through a repair edge, so a reader has to notice `trigger: repair`.
- Determinism: the Engine walks the list; the only backward edge is `repair`, which consumes a budget every time it is taken, so termination follows from the budget declarations and can be checked statically.
- Loops read the way v1 describes them: "review -> fix consumes a bounce", and two senders share `bounces` by naming it. ci -> fix -> ci is the same construct on another budget.
- Patches fail loudly: id addressing has no index drift; unknown ids, duplicate ids, dangling repair targets and unknown kinds are load-time errors; there is no list merge, so no quiet array replacement.
- Custom step kind: `registry.install(defineExtension({ name: "a11y", steps: [defineStepKind({ name: "a11y-scan", run })] }))` mirrors Pi Durable's by-name registry; the file says `kind: a11y-scan`; install replaces by name and validates; the Engine resolves kinds at load, not per run.
- Weak spot: a loop body longer than one step (review, fix, re-test, review) needs a composite step kind or a second construct; `repair` deliberately does not generalise to `goto`.

### Shape B: nested loop blocks

```yaml
# Global workflow
version: 1
budgets:
  bounces:    { max: 3, exhausted: block }
  ci_repairs: { max: 2, exhausted: block }
steps:
  - id: spec
    kind: agent
    runner: pi
    options: { agent: spec-writer }
  - id: tests
    kind: agent
    runner: claude-code
    options: { agent: test-writer }
    when: lane not in [trivial, no-code]
    gate: tests-red
  - id: implement
    kind: agent
    runner: claude-code
    options: { agent: implementor }
    gate: tests-green
  - id: review-loop
    kind: loop
    budget: bounces                  # every pass that reaches `fix` consumes one
    when: lane != trivial
    body:
      - id: review
        kind: agent
        runner: claude-code
        options: { agent: reviewer }
        exit_when: outcome == pass   # leaves the loop
      - id: fix
        kind: agent
        runner: claude-code
        options: { agent: implementor, fresh: true }
        gate: tests-green
  - id: report
    kind: agent
    runner: claude-code
    options: { agent: reporter }
  - id: mr
    kind: shell
    runner: shell
    options: { script: orch-open-mr }
  - id: ci-loop
    kind: loop
    budget: ci_repairs
    body:
      - id: ci
        kind: ci
        runner: shell
        gate: ci-green-on-head
        exit_when: outcome == passed
      - id: fix-ci
        kind: agent
        runner: claude-code
        options: { agent: implementor, fresh: true }
        gate: tests-green
  - id: merge
    kind: merge
    runner: shell
    when: project.merge == auto
    else: { block: awaiting human merge }
```

```yaml
# Project override
version: 1
extends: global
patch:
  - op: insert_after
    step: review-loop          # not `review`: that would run verify on every round
    value:
      id: verify-loop
      kind: loop
      budget: bounces          # shares the counter with review-loop
      body:
        - id: verify
          kind: agent
          runner: claude-code
          options: { agent: verifier, env: docker }
          exit_when: outcome == pass
        - id: fix-verify
          kind: agent
          runner: claude-code
          options: { agent: implementor, fresh: true }
          gate: tests-green
```

Trade-offs:

- Readability: the loop is a visible block; good when a loop body has several steps.
- Determinism: the same walk with a stack; fine.
- Loops read well, but v1's shared budget across the review and verify loops needs a named counter anyway (`budget: bounces` on both blocks), so a per-block `max` would be a second way to say the same thing.
- Patches: id addressing still works, but "insert after review" is now ambiguous: inside the body (after every review, findings or not) or after the block (after review passes). The override above has to say `review-loop`; a project author who writes `review` gets a verify run on every round, a correct application of a wrong patch, which is the ordering ambiguity the ticket asks about. Nested paths (`/steps/3/body/1`) would bring back RFC 6902 index drift if ever allowed.
- Custom step kind: as in A; `loop` is a built-in kind.

### Shape C: named-step map, `after:` edges, merge-by-name override

```yaml
# Global workflow
version: 1
budgets:
  bounces:    { max: 3, exhausted: block }
  ci_repairs: { max: 2, exhausted: block }
steps:
  spec:      { kind: agent, runner: pi, options: { agent: spec-writer } }
  tests:     { kind: agent, runner: claude-code, options: { agent: test-writer },
               after: spec, when: lane not in [trivial, no-code], gate: tests-red }
  implement: { kind: agent, runner: claude-code, options: { agent: implementor },
               after: tests, gate: tests-green }
  review:    { kind: agent, runner: claude-code, options: { agent: reviewer },
               after: implement, when: lane != trivial,
               on: { findings: { repair: fix, budget: bounces } } }
  fix:       { kind: agent, runner: claude-code, options: { agent: implementor, fresh: true },
               trigger: repair, gate: tests-green }
  report:    { kind: agent, runner: claude-code, options: { agent: reporter }, after: review }
  mr:        { kind: shell, runner: shell, options: { script: orch-open-mr }, after: report }
  ci:        { kind: ci, runner: shell, after: mr, gate: ci-green-on-head,
               on: { failed: { repair: fix, budget: ci_repairs } } }
  merge:     { kind: merge, runner: shell, after: ci, when: project.merge == auto,
               else: { block: awaiting human merge } }
```

```yaml
# Project override: same shape as the base, merged by step name
version: 1
extends: global
steps:
  verify:
    kind: agent
    runner: claude-code
    options: { agent: verifier, env: docker }
    after: review
    on: { findings: { repair: fix, budget: bounces } }
  report:
    after: verify          # forget this line and report and verify both follow review
```

Trade-offs:

- Readability: familiar to anyone who has written GitLab CI; override files look like the base.
- Determinism: the Engine must sort `after:` edges; with one `after` per step this is a list in disguise, with several it is a DAG and the order of independent steps is undefined unless the Engine adds a tie-break such as map order, which parsers preserve but YAML does not promise.
- Loops: `repair` works as in A. There is no other loop form because a DAG has no back-edges.
- Patches fail quietly: a typo (`reveiw:`) adds a new, unreachable step; inserting `verify` requires re-pointing `report.after`, and forgetting it leaves two steps `after: review` with an undefined order; dropping a step with `tests: null` leaves `implement.after` dangling. Each can be caught with an extra rule (reject unreachable steps, reject fan-out without `parallel: true`, reject dangling `after`), but the format invites the mistakes the rules then police. Array-valued options replace whole, as in Helm and GitLab.
- Custom step kind: as in A.

## Recommendation (input to the prototype, not a decision)

Shape A. It keeps the loud parts of the surveyed systems (RFC 6902's ordered ops that fail on a missing target and reject the whole patch; the unique-names and resolve-every-reference validation of Argo, Tekton and ASL; Pi Durable's register-by-name for kinds) and drops the quiet parts (merge-by-key of lists, positional indexes, back-edges without a budget). It also matches v1's own words: a repair edge is the `review -> fix` transition and a named budget is `bounces`. Against B: the inside/outside ambiguity of insertion and the duplicated cap. Against C: the three quiet failures above.

What the prototype should check before treating this as settled:

1. Express every v1 edge in Shape A without adding a `goto`: verify -> fix sharing `bounces`, ci -> fix on `ci_repairs`, the three skip lanes, and "merges wait for a human".
2. Make the four loader errors real and test them: unknown `step:` in a patch, duplicate id on insert, `repair` pointing at a dropped step, unknown `kind`.
3. Map steps onto Pi Durable: one owned task per step run with a key such as `review#2`, budgets and the current step id in the Engine task's checkpoint, and confirm that a restart mid-review re-attaches instead of re-dispatching.
4. Write the same override for three real projects and read the results back; if `trigger: repair` and the repair edges are what readers trip over, revisit B's block for the review/fix pair only.

## What the sources did not answer

- GitHub Actions: the syntax reference does not say what a duplicate step `id` does, and the unknown-`needs` error text comes from the open-source parser, not the docs. The metadata page gives no nesting limit for composite actions calling composite actions.
- GitLab: the YAML reference does not say what a missing `extends` target does; the source does (error). The docs do not describe `!reference` inside `extends`.
- Argo: no documented bound on recursion depth; the `limit + 1` semantics of `retryStrategy.limit` are in a source comment, not the retries page.
- Tekton: the pipelines page does not state that task names must be unique; the validation source does.
- Temporal: no page states outright that loops are allowed; it follows from "Workflow Definitions are just functions" plus the determinism rules.
- Inngest: the counter format for repeated step IDs is undocumented, only its existence.
- Kustomize: the `patches` reference does not say what a `target` that matches nothing does; the source shows a silent no-op for selector-targeted patches and an error for identity-matched strategic merge patches.
- Helm: array replacement is stated only in a source comment.
- Pi Durable: nothing says whether `uninstall` of an unknown name errors; resolution skips names that are not installed; the package has no notion of an ordered step list, only tasks and phases, so the step-to-task mapping is v2's to define.
- None of the systems surveyed has a step-level "run X then run me again" edge with a budget shared across senders; that construct in Shape A is v2's own, modelled on v1's `bounces`.

## Sources

[gha-syntax]: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
[gha-understanding]: https://docs.github.com/en/actions/get-started/understanding-github-actions
[gha-expressions]: https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
[gha-reuse]: https://docs.github.com/en/actions/how-tos/sharing-automations/reuse-workflows
[gha-metadata]: https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
[gha-parser]: https://github.com/actions/languageservices/blob/main/workflow-parser/src/model/converter/jobs.ts
[gl-yaml]: https://docs.gitlab.com/ci/yaml/
[gl-includes]: https://docs.gitlab.com/ci/yaml/includes/
[gl-opt]: https://docs.gitlab.com/ci/yaml/yaml_optimization/
[gl-extends-src]: https://gitlab.com/gitlab-org/gitlab/-/blob/master/lib/gitlab/ci/config/extendable/entry.rb
[argo-steps]: https://argo-workflows.readthedocs.io/en/latest/walk-through/steps/
[argo-dag]: https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/
[argo-depends]: https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/
[argo-cond]: https://argo-workflows.readthedocs.io/en/latest/walk-through/conditionals/
[argo-rec]: https://argo-workflows.readthedocs.io/en/latest/walk-through/recursion/
[argo-loops]: https://argo-workflows.readthedocs.io/en/latest/walk-through/loops/
[argo-retries]: https://argo-workflows.readthedocs.io/en/latest/retries/
[argo-types]: https://github.com/argoproj/argo-workflows/blob/main/pkg/apis/workflow/v1alpha1/workflow_types.go
[argo-wt]: https://argo-workflows.readthedocs.io/en/latest/workflow-templates/
[argo-vars]: https://argo-workflows.readthedocs.io/en/latest/variables/
[argo-validate]: https://github.com/argoproj/argo-workflows/blob/main/workflow/validate/validate.go
[tekton-pipelines]: https://tekton.dev/docs/pipelines/pipelines/
[tekton-validate]: https://github.com/tektoncd/pipeline/blob/main/pkg/apis/pipeline/v1/pipeline_validation.go
[tekton-dag]: https://github.com/tektoncd/pipeline/blob/main/pkg/reconciler/pipeline/dag/dag.go
[tekton-taskloop]: https://github.com/tektoncd/experimental/tree/main/task-loops
[tmp-workflows]: https://docs.temporal.io/workflows
[tmp-def]: https://docs.temporal.io/workflow-definition
[tmp-basics]: https://docs.temporal.io/develop/typescript/workflows/basics
[tmp-retry]: https://docs.temporal.io/encyclopedia/retry-policies
[tmp-failure]: https://docs.temporal.io/develop/typescript/failure-detection
[tmp-versioning]: https://docs.temporal.io/develop/typescript/versioning
[tmp-can]: https://docs.temporal.io/workflow-execution/continue-as-new
[inn-steps]: https://www.inngest.com/docs/features/inngest-functions/steps-workflows
[inn-run]: https://www.inngest.com/docs/reference/functions/step-run
[inn-retries]: https://www.inngest.com/docs/features/inngest-functions/error-retries/retries
[inn-loops]: https://www.inngest.com/docs/guides/working-with-loops
[kz-patches]: https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/patches/
[kz-components]: https://kubectl.docs.kubernetes.io/guides/config_management/components/
[kz-pt]: https://github.com/kubernetes-sigs/kustomize/blob/master/api/internal/builtins/PatchTransformer.go
[kz-rw]: https://github.com/kubernetes-sigs/kustomize/blob/master/api/resmap/reswrangler.go
[smp]: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-api-machinery/strategic-merge-patch.md
[rfc6902]: https://www.rfc-editor.org/rfc/rfc6902
[rfc7396]: https://www.rfc-editor.org/rfc/rfc7396
[helm-values]: https://helm.sh/docs/chart_template_guide/values_files/
[helm-install]: https://helm.sh/docs/helm/helm_install/
[helm-sub]: https://helm.sh/docs/chart_template_guide/subcharts_and_globals/
[helm-coalesce]: https://github.com/helm/helm/blob/dev-v3/pkg/chartutil/coalesce.go
[pi-readme]: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
[pi-spec]: https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md
[asl]: https://states-language.net/spec.html
[ans-loops]: https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_loops.html
[ans-blocks]: https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_blocks.html
