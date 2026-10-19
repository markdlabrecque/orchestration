import type { Identity } from "./types.ts";

/** A successful HTTP request is not evidence of a completed filing. */
export function remoteIdentity(id: unknown, url: unknown): Identity {
  if (
    !Number.isSafeInteger(id) ||
    Number(id) <= 0 ||
    typeof url !== "string" ||
    !url.trim()
  )
    throw new Error("Ambiguous tracker identity");
  return { id: String(id), url };
}
