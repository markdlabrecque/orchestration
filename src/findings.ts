import { defineDoc } from "@earendil-works/pi-durable";
import type { AgentResult } from "./runners/types.ts";
import type { Identity } from "./tracker/types.ts";

export type Finding = NonNullable<AgentResult["findings"]>[number] & {
  id: string;
  detector: string;
  status: "open" | "fixed" | "withdrawn" | "deferred";
  responses: NonNullable<AgentResult["responses"]>;
  decisions: NonNullable<AgentResult["decisions"]>;
  filing?: "pending" | "linked";
  marker?: string;
  link?: Identity;
  deferralReason?: string;
};
export const Findings = defineDoc<{ items: Finding[] }>({
  kind: "orch.findings",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
});
export class ContractError extends Error {}
export class FilingError extends Error {}
export const openFindings = (items: Finding[], detector?: string) =>
  items.filter(
    (f) =>
      f.status === "open" &&
      f.classification === "must-fix" &&
      (!detector || f.detector === detector),
  );

export function recordResult(
  items: Finding[],
  result: AgentResult,
  detector: string,
  mode: "normal" | "repair" | "recheck",
  runId: string,
  source = detector,
) {
  const owned = openFindings(items, detector);
  if (mode === "repair" || mode === "recheck") {
    const records =
      mode === "repair" ? (result.responses ?? []) : (result.decisions ?? []);
    const ids = records.map((r) => r.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== owned.length ||
      owned.some((f) => !ids.includes(f.id))
    )
      throw new ContractError(
        "Result must address exactly this detecting step's open finding IDs",
      );
    for (const f of owned) {
      if (mode === "repair")
        f.responses.push(
          ...(result.responses ?? []).filter((r) => r.id === f.id),
        );
      else {
        const decision = result.decisions?.find((r) => r.id === f.id);
        if (decision) {
          f.decisions.push(decision);
          f.status = decision.status;
        }
      }
    }
  }
  for (const input of [
    ...(result.findings ?? []),
    ...(result.followUps ?? []).map((f) => ({
      ...f,
      classification: "follow-up" as const,
    })),
  ]) {
    const id = `F${items.length + 1}`;
    const classification =
      mode === "recheck" ? "follow-up" : input.classification;
    items.push({
      ...input,
      id,
      classification,
      detector: source,
      status: "open",
      responses: [],
      decisions: [],
      ...(classification === "follow-up"
        ? ({
            filing: "pending",
            marker: `<!-- orch:${runId}:finding:${id} -->`,
          } as const)
        : {}),
    });
  }
}
