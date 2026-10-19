---
status: accepted
date: 2026-10-18
---

# The spec selects the implementation tier; other steps use static assignments

The spec step selects the implementation tier for each ticket according to the size and difficulty of the work. All other agent steps use static tier and effort assignments in the workflow, including repairs. Phase 1 does not automatically escalate models after repeated repairs. This concentrates model selection where the ticket is understood without bringing back v1's routing floors and escalation ladder.

Keep the four tiers `light`, `standard`, `heavy` and `frontier`. A tier names a routing choice, not a claim that models from different providers have equal capability. As settled in ADR 0003, each runner maps tiers to models in the workflow's `runners:` block, overridable per project.

The existing assignments are the starting table:

| Tier | `claude` family (`pi-claude-subscription`) | `openai` family (`openai`) |
|---|---|---|
| light | claude-haiku-5-5 | gpt-6-luna |
| standard | claude-sonnet-5-5 | gpt-6.1-sol |
| heavy | claude-opus-5-5 | gpt-6-astra |
| frontier | claude-fable-5-1 | gpt-6-astra |

Heavy and frontier currently map to the same OpenAI model. Which family runs is the `model-family` setting, `claude` by default and switchable per project ([ADR 0011](0011-project-selects-the-model-family.md)). The table is configuration, not a permanent list of supported models. The spec chooses a tier rather than a provider-specific model identifier; implementation effort remains a static workflow assignment.

Decision: [Model routing per step](https://github.com/markdlabrecque/orchestration/issues/135).
