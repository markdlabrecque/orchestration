// PROTOTYPE (#128): a custom step kind registered from a project module. Throwaway.
//
// The project's override lists this file under `uses:`. The engine imports it and
// registers the kind by name before it reads the step list, so the workflow file
// can say `kind: a11y-scan`. A name that is already registered is an error.
import { defineStepKind } from "#engine"; // in v2 proper: the engine package

type Options = { pages: string[]; standard?: string };
type Exec = (command: string) => Promise<{ code: number; stdout: string }>;

export default defineStepKind({
  name: "a11y-scan",

  // The first outcome falls through to the next step. Every other outcome must be
  // mapped under `on:` in the workflow, or the ticket blocks when it happens.
  outcomes: ["pass", "violations"],

  options: {
    pages: { type: "string[]", required: true },
    standard: { type: "string", default: "WCAG2AA" },
  },

  async run({ options, exec }: { options: Options; exec: Exec }) {
    const urls = options.pages.map((p) => `http://127.0.0.1:8080${p}`).join(" ");
    const result = await exec(`npx pa11y-ci --standard ${options.standard ?? "WCAG2AA"} ${urls}`);
    if (result.code === 0) return { outcome: "pass" };
    return { outcome: "violations", findings: result.stdout.split("\n").filter(Boolean) };
  },
});
