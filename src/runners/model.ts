import type { JsonValue } from "../workflow.ts";
export const tiers = ["light", "standard", "heavy", "frontier"];
export function piModel(
  config: Record<string, JsonValue>,
  tier: string,
): { provider: string; model: string } {
  const mappings = config?.models;
  const mapping =
    mappings && typeof mappings === "object" && !Array.isArray(mappings)
      ? mappings[tier]
      : config;
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    typeof mapping.provider !== "string" ||
    typeof mapping.model !== "string"
  )
    throw new Error(`runners.pi: missing Pi model mapping for ${tier}`);
  return { provider: mapping.provider, model: mapping.model };
}
