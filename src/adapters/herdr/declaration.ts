import { AdapterError } from "./errors.ts";

// Static capability declaration. The foreground owner dies with its pane (#156), so only
// host-bound is declared. Question presentation and notifications belong to the adapter
// but are not built in this slice; they are listed so requests name them precisely.
export const declaration = {
  adapter: "herdr",
  ownerLifetime: ["host-bound"],
  features: [] as string[],
  planned: ["question-presentation", "notifications"],
} as const;

export function requireCapability(request: {
  ownerLifetime?: string;
  features?: string[];
}) {
  const lifetime = request.ownerLifetime;
  if (
    lifetime !== undefined &&
    !(declaration.ownerLifetime as readonly string[]).includes(lifetime)
  )
    throw new AdapterError(
      "unsupported-capability",
      `unsupported-capability: owner-lifetime ${lifetime}`,
    );
  for (const feature of request.features ?? [])
    if (!(declaration.features as readonly string[]).includes(feature))
      throw new AdapterError(
        "unsupported-capability",
        `unsupported-capability: ${feature}`,
      );
}
