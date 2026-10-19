import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
export const resultSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("pass"),
      Type.Literal("findings"),
      Type.Literal("failed"),
    ]),
    summary: Type.String(),
  },
  { additionalProperties: false },
);
export type AgentResult = {
  outcome: "pass" | "findings" | "failed";
  summary: string;
  lane?: "standard" | "trivial" | "no-code";
  implementationTier?: "light" | "standard" | "heavy" | "frontier";
  followUps?: { summary: string; evidence: string }[];
  responses?: { id: string; action: "changed" | "disagreed"; reason: string }[];
  decisions?: {
    id: string;
    status: "fixed" | "open" | "withdrawn";
    reason: string;
  }[];
  expectedFailures?: { test: string; message: string }[];
  findings?: {
    summary: string;
    evidence: string;
    classification: "must-fix" | "follow-up";
  }[];
};
export function roleResultSchema(
  role: string,
  mode: "normal" | "repair" | "recheck" = "normal",
) {
  const common = {
    ...resultSchema.properties,
    followUps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            summary: Type.String({ minLength: 1 }),
            evidence: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  };
  const fields = { ...common };
  if (role === "spec-writer")
    Object.assign(fields, {
      lane: Type.Union(
        ["standard", "trivial", "no-code"].map((v) => Type.Literal(v)),
      ),
      implementationTier: Type.Union(
        ["light", "standard", "heavy", "frontier"].map((v) => Type.Literal(v)),
      ),
    });
  if (role === "test-writer")
    Object.assign(fields, {
      expectedFailures: Type.Array(
        Type.Object(
          {
            test: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    });
  if (["reviewer", "verifier"].includes(role))
    Object.assign(fields, {
      findings: Type.Array(
        Type.Object(
          {
            summary: Type.String({ minLength: 1 }),
            evidence: Type.String({ minLength: 1 }),
            classification: Type.Union([
              Type.Literal("must-fix"),
              Type.Literal("follow-up"),
            ]),
          },
          { additionalProperties: false },
        ),
      ),
    });
  if (mode === "repair")
    return Type.Object(
      {
        ...common,
        responses: Type.Array(
          Type.Object(
            {
              id: Type.String({ minLength: 1 }),
              action: Type.Union([
                Type.Literal("changed"),
                Type.Literal("disagreed"),
              ]),
              reason: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    );
  if (mode === "recheck" && ["reviewer", "verifier"].includes(role))
    Object.assign(fields, {
      decisions: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1 }),
            status: Type.Union(
              ["fixed", "open", "withdrawn"].map((v) => Type.Literal(v)),
            ),
            reason: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    });
  return Type.Object(fields, { additionalProperties: false });
}
export type RunnerEvent = { type: "tool" | "text" | "status"; data: unknown };
export type RunnerRequest = {
  session?: string;
  prompt: string;
  role: string;
  cwd: string;
  model: { tier: string; effort: ModelThinkingLevel };
  tools: string[];
  timeoutMs: number;
  resultSchema: TSchema;
  signal: AbortSignal;
  onEvent: (event: RunnerEvent) => void;
};
export type RunnerResult = {
  status: "done" | "failed" | "aborted" | "timeout";
  handoff: string;
  result?: AgentResult;
  artifacts: string[];
  ranOn: { provider: string; model: string; effort: ModelThinkingLevel };
  usage: unknown;
  session?: string;
};
export interface Runner {
  resumable: boolean;
  run(request: RunnerRequest): Promise<RunnerResult>;
}
export function validateResult(schema: TSchema, value: unknown): AgentResult {
  if (!Value.Check(schema, value))
    throw new Error("Agent did not submit a valid result");
  return value as AgentResult;
}
