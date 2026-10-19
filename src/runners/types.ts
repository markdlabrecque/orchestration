import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
export const resultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal("pass"), Type.Literal("failed")]),
    summary: Type.String(),
  },
  { additionalProperties: false },
);
export type AgentResult = { outcome: "pass" | "failed"; summary: string };
export type RunnerEvent = { type: "tool" | "text" | "status"; data: unknown };
export type RunnerRequest = {
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
