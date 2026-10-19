---
status: accepted
date: 2026-10-18
---

# The spec selects the implementation tier; other steps use static assignments

The spec step selects the implementation tier for each ticket according to the size and difficulty of the work. All other agent steps use static tier and effort assignments in the workflow, including repairs. Phase 1 does not automatically escalate models after repeated repairs. This concentrates model selection where the ticket is understood without bringing back v1's routing floors and escalation ladder.

Keep the four tiers `light`, `standard`, `heavy` and `frontier`. A tier names a routing choice, not a claim that models from different providers have equal capability. As settled in ADR 0003, each runner maps tiers to models in the workflow's `runners:` block, overridable per project.

The existing assignments are the starting table:

| Tier | Claude alias | GPT model |
|---|---|---|
| light | haiku | gpt-6-luna |
| standard | sonnet | gpt-6.1-sol |
| heavy | opus | gpt-6-astra |
| frontier | fable | gpt-6-astra |

Heavy and frontier currently map to the same GPT model. The table is configuration, not a permanent list of supported models. The spec chooses a tier rather than a provider-specific model identifier; implementation effort remains a static workflow assignment.

Decision: [Model routing per step](https://github.com/markdlabrecque/orchestration/issues/135).
