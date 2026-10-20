import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { AdapterError } from "./errors.ts";

// An explicit variable wins; otherwise the first executable on PATH.
export function resolveBin(
  name: string,
  envVar: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[envVar];
  if (explicit) return explicit;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new AdapterError(
    "binary-not-found",
    `Could not find ${name}: set ${envVar} or put ${name} on PATH`,
  );
}
