export const CONTRACT = "orch.control/1";

export type OwnerLifetime = "host-bound" | "detached";

// The orch CLI itself launches a foreground owner, so it can only promise host-bound.
// Adapters that launch the owner detached declare that themselves (ticket 165).
export const declaredOwnerLifetimes: OwnerLifetime[] = ["host-bound"];

export function capabilitiesResponse(requestedOwnerLifetime?: string) {
  const base = {
    contract: CONTRACT,
    supportedMajors: [1],
    capabilities: {
      "owner-lifetime": "host-bound" as OwnerLifetime,
      durability: "unqualified",
    },
  };
  if (
    requestedOwnerLifetime !== undefined &&
    !(declaredOwnerLifetimes as string[]).includes(requestedOwnerLifetime)
  )
    return {
      ...base,
      outcome: "rejected",
      code: "unsupported-capability",
      detail: `owner-lifetime: ${requestedOwnerLifetime}`,
    };
  return { ...base, outcome: "answered" };
}
