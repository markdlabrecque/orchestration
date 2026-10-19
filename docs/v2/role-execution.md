# Role execution

The shipped workflow runs spec, tests, implementation, review, optional site
verification, report, MR, CI, optional human approval and pinned merge.
Standard runs red and green gates. Trivial skips tests and review. No-code skips
tests and retains review. Both use the conditional implement-without-tests copy
of the implementor step, so neither can accidentally inherit the standard gate.
Browser verification runs only for standard with verification other than
local-tests. A project may insert a verifier with local-tests to assess automated
evidence explicitly. DDEV and Docker options are passed in the brief.

Set settings.tests to the project's full test command. The shipped starting
command is pnpm test. Set settings.verification to local-tests, ddev or docker,
and settings.merge-approval to true to ask before merge. Unknown verifier modes
and duplicate human choices fail workflow validation.

Only a spec-writer result selects lane and implementationTier. Labels
lane:standard, lane:trivial and lane:no-code force a lane; conflicting or invalid
lane labels block before pickup. The spec must still return a valid selection.
Implementation effort remains the step's configured effort. Other roles use
their static model settings.

Pi's runners.pi.models maps each tier to {provider, model}. The older
{provider, model} configuration still selects one model for every tier.
Shell's runners.shell.models maps tiers to model identifiers supplied in
ORCH_MODEL; ORCH_MODEL_TIER and ORCH_MODEL_EFFORT are also supplied. The configured
shell command must honor those values. The shell adapter reports its configured
model and effort; it cannot independently attest to the external agent's routing
or enforce the supplied tool permissions. Pi reports the responding model and
usage from its conversation. Pi supports read, edit and shell. Shell accepts
read, edit, shell, web and mcp:<name>. Unknown words fail validation.

## Results

Every role returns outcome (pass, findings or failed) and summary. Spec additionally
requires lane and implementationTier. Test-writer requires expectedFailures,
an array of {test, message}. Reviewer and verifier require findings, an array of
{summary, evidence, classification}; classification is must-fix or follow-up.
A passing result with any must-fix blocks. Other roles cannot add lane or tier.
Unknown fields fail schema validation.

Pi exposes the role's exact schema as submit_result and fails if it finishes
without submitting. Shell receives the schema in ORCH_RESULT_SCHEMA and must write
valid JSON to ORCH_RESULT_FILE before exiting zero. Its stdout is the handoff.
Role text precedes the brief on stdin and is also in ORCH_ROLE_FILE.
Typed results, handoffs and session handles are persisted by the engine; runner
events retain artifacts, routing and usage. Models never perform tracker writes.

## Red gate reporter contract

The engine runs settings.tests in the ticket worktree with a fresh
ORCH_TEST_REPORT_FILE path. For tests-red the command must exit 1 and its reporter
must write JSON derived from actual framework results:

```json
{
  "passed": 3,
  "failures": [
    { "test": "saves an item", "message": "expected saved", "kind": "assertion" }
  ],
  "errors": []
}
```

Every failure must exactly match one test-writer expectedFailures entry, with no
extra failures or setup errors. Test names in expectedFailures must be unique.
Unavailable commands, syntax/import/collection failures, missing reports, green
tests and unrelated assertions cannot pass red. A framework reporter or a project
test wrapper must classify errors faithfully; do not generate static evidence.
The test-writer configures that reporter as part of the test changes when needed.
There is no framework-independent way to infer the intent of a nonzero exit.

Tests-green reruns the full configured command and requires a normal zero exit.
Both gates stop on cancellation or a one-hour timeout. Gate failure never advances
the workflow, including when an agent claimed pass.

## Humans and sessions

Human steps ask on stdin without a timeout. The first listed choice advances as
pass. Other choices retain their named outcome and block pending repair support.
Invalid responses are asked again. Pausing while unanswered does not record an
answer; resuming asks again.

Fresh agent conversations are the default. session: <earlier-step-id> requires
a session-capable runner on that source step and a saved handle. Pi continues
that conversation with the new role, schema, model and tool permissions and
clears the preceding result. A missing source or lost conversation blocks rather
than creating a new one. Shell rejects session continuation.

Pi resumes its owned conversation after a process crash. Shell reruns on the
existing dirty worktree. Cancellation and timeout stop the Pi conversation or
shell process group, including surviving descendants. Repairs, findings-ledger
management and GitLab execution remain the later tickets' responsibility.

## Validation evidence and test changes

The execution tests use the approved workflow, execution/CLI, runner and tracker
interfaces. Red-green slices cover lane selection, unauthorized selections, gates,
human pause/resume, sessions and tier routing. CLI fixtures exercise each shipped
lane through real Pi/shell adapters and local worktrees with fake model/forge
responses. The standard fixture tests the actual presence and contents of the
file written by its shell agent, producing red before implementation and green
afterward. Crash fixtures retain the earlier fixed slice as a compatibility test.

The two tests asserting human/test-gate execution was unsupported were retired
because that behavior was replaced. Their positive and failure-path replacements
cover the new contract. No difficult or failing behavioral tests were simplified
or removed. The shipped-preflight fixture's fake provider now registers the new
default model identifiers. No live provider, DDEV site or Docker site was used in
automated validation; those modes are tested at the execution boundary.

Final validation: pnpm check passed 101 TypeScript tests, 412 retained bash
assertions and 15 Python tests, plus TypeScript and Biome checks.
