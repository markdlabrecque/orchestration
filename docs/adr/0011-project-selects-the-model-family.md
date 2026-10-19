---
status: accepted
date: 2026-10-19
---

# A project selects the model family; Claude through Pi is the default

Each runner maps tiers to models for several model families, and the workflow setting `model-family` picks which family every runner uses. The shipped default is `claude`, served by Pi's `pi-claude-subscription` provider; `openai` is the shipped alternative. Because settings merge by name (ADR 0004), a project switches family with one line in its committed patch and never copies the runner tables:

```yaml
version: 1
settings:
  model-family: openai
```

The global workflow declares the tables once, under each runner's `families`, and names the family by setting reference:

```yaml
settings:
  model-family: claude
runners:
  pi:
    family: $settings.model-family
    families:
      claude:
        light:    { provider: pi-claude-subscription, model: claude-haiku-5-5 }
        standard: { provider: pi-claude-subscription, model: claude-sonnet-5-5 }
        heavy:    { provider: pi-claude-subscription, model: claude-opus-5-5 }
        frontier: { provider: pi-claude-subscription, model: claude-fable-5-1 }
      openai:
        light:    { provider: openai, model: gpt-6-luna }
        standard: { provider: openai, model: gpt-6.1-sol }
        heavy:    { provider: openai, model: gpt-6-astra }
        frontier: { provider: openai, model: gpt-6-astra }
  shell:
    family: $settings.model-family
    families: { ... same tables ... }
```

## Considered options

- One tier-to-model map per runner, overridden per project. Rejected: a project that wants another provider must restate every tier of every runner, and the global file can only hold one family.
- A `family` field per runner with no setting. Rejected: a project would have to patch each runner separately to switch, and the two runners could drift onto different families by accident.
- Default to OpenAI, as v1 did on Pi. Rejected: the owner's default is the Claude subscription through Pi.

## Consequences

- Load fails when `model-family` names a family a runner used by the effective workflow does not declare, or when a declared family lacks any of the four tiers. Checking happens in preflight, before pickup.
- Each tier entry carries `provider` and `model`. The Pi runner passes both to its subagent. The shell runner exports `ORCH_MODEL_PROVIDER`, `ORCH_MODEL` and `ORCH_MODEL_EFFORT` alongside the existing `ORCH_RESULT_FILE`, `ORCH_RESULT_SCHEMA` and `ORCH_ROLE_FILE`.
- The shipped shell command runs Pi (`pi -p --provider ... --model ... --thinking ...`), not Codex, so both built-in runners work for either family. Other commands remain possible because the shell runner only runs the configured command.
- A tier is a routing choice, not a claim of equal capability across families (ADR 0009). `ranOn` records the provider and model that actually ran.
- Adding a family, such as a local model, means adding a block under each runner's `families`; the setting accepts any declared family name.
