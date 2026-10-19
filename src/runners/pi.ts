import { createHash } from "node:crypto";
import {
  BACKGROUND_CONTEXT as ctx,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  type ConversationId,
  type Cursor,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  type Harness,
  type TaskId,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { TSchema } from "typebox";
import {
  type AgentResult,
  type Runner,
  type RunnerResult,
  resultSchema,
  validateResult,
} from "./types.ts";

const Result = defineDoc<{ key: string; result: AgentResult | null }>({
  kind: "orch.agent-result",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ key: "", result: null }),
});
const makeSubmit = (schema: TSchema) =>
  defineTool({
    name: "submit_result",
    description: "Submit the final typed result and end this agent step.",
    parameters: schema,
    replay: "safe",
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        (await tx.doc(Result, api.conversationId)).result = validateResult(
          schema,
          args,
        );
      }, context);
      return {
        output: [{ type: "text", text: validateResult(schema, args).summary }],
        control: { terminate: true },
      };
    },
  });
const read = createReadTool(),
  write = createWriteTool(),
  edit = createEditTool(),
  bash = createBashTool();
export function piResultExtension(schema: TSchema) {
  return defineExtension({
    name:
      JSON.stringify(schema) === JSON.stringify(resultSchema)
        ? "orch.pi"
        : `orch.pi.${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}`,
    tools: [makeSubmit(schema), read, write, edit, bash],
  });
}
export const PiResults = piResultExtension(resultSchema);

export function createPiRunner(
  harness: Harness,
  owner: TaskId,
  key: string,
  selectModel:
    | { provider: string; model: string }
    | ((tier: string) => { provider: string; model: string }),
): Runner {
  return {
    resumable: true,
    async run(request) {
      const model =
        typeof selectModel === "function"
          ? selectModel(request.model.tier)
          : selectModel;
      const base: RunnerResult = {
        status: "failed",
        handoff: "",
        artifacts: [],
        ranOn: {
          provider: model.provider,
          model: model.model,
          effort: request.model.effort,
        },
        usage: null,
      };
      if (request.signal.aborted) return { ...base, status: "aborted" };
      if (request.tools.some((t) => !["read", "edit", "shell"].includes(t)))
        throw new Error("Pi: unsupported tool permission");
      const extension = piResultExtension(request.resultSchema);
      const tools = [
        makeSubmit(request.resultSchema),
        ...(request.tools.includes("read") ? [read] : []),
        ...(request.tools.includes("edit") ? [write, edit] : []),
        ...(request.tools.includes("shell") ? [bash] : []),
      ];
      const root = await harness.root(ctx);
      const id = await root.commit(async (tx) => {
        if (request.session) {
          const id = Number(request.session) as ConversationId;
          if (!(await tx.conversation(id)))
            throw new Error(`Pi: missing session ${request.session}`);
          const doc = await tx.doc(Result, id);
          if (doc.key !== key) {
            doc.key = key;
            doc.result = null;
            await configure(tx, id, {
              model: { provider: model.provider, modelId: model.model },
              thinkingLevel: request.model.effort,
              extensions: [extension],
              tools,
              cwd: request.cwd,
              instructions: `${request.role}\nYou must finish by calling submit_result. Do not perform tracker writes.`,
            });
          }
          return id;
        }
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations(
            { ownerTaskId: owner },
            100,
            cursor,
          );
          for (const conversation of page.items) {
            const doc = await tx.doc(Result, conversation.id);
            if (doc.key === key) return conversation.id;
          }
          cursor = page.next;
        } while (cursor);
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: owner },
        });
        await configure(tx, conversation.id, {
          model: { provider: model.provider, modelId: model.model },
          thinkingLevel: request.model.effort,
          extensions: [extension],
          tools,
          cwd: request.cwd,
          instructions: `${request.role}\nYou must finish by calling submit_result. Do not perform tracker writes.`,
        });
        (await tx.doc(Result, conversation.id)).key = key;
        return conversation.id;
      }, ctx);
      const conversation = await harness.conversation(id, ctx);
      if (!conversation) throw new Error("Pi conversation is missing");
      base.session = String(id);
      const events = await watchEvents(harness, id, ctx);
      events.start(async (batch) => {
        for (const event of batch)
          request.onEvent({
            type: event.type.startsWith("tool_")
              ? "tool"
              : event.type.startsWith("message_")
                ? "text"
                : "status",
            data: event,
          });
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void conversation.abort(ctx).catch(() => {});
      }, request.timeoutMs);
      try {
        const submission = await conversation.submit(
          { type: "input", content: request.prompt, requestId: `orch:${key}` },
          ctx,
        );
        const settled = await submission.wait(
          withAbortSignal(request.signal, ctx),
        );
        if (timedOut) return { ...base, status: "timeout" };
        if (settled.status !== "done") return base;
        const saved = await harness.snapshot(Result, id, ctx);
        const result = validateResult(request.resultSchema, saved?.result);
        const transcript = await conversation.context(ctx);
        const messages = transcript.entries
          .flatMap((e) => e.model ?? [])
          .filter((m) => m.role === "assistant");
        const last = messages.at(-1);
        if (last?.role === "assistant") {
          base.ranOn = {
            provider: last.provider,
            model: last.responseModel ?? last.model,
            effort: last.thinkingLevel ?? request.model.effort,
          };
          base.usage = (await harness.snapshot(UsageDoc, id, ctx)) ?? null;
        }
        return { ...base, status: "done", handoff: result.summary, result };
      } catch (error) {
        if (request.signal.aborted) {
          await conversation.abort(ctx).catch(() => {});
          return { ...base, status: "aborted" };
        }
        if (timedOut) return { ...base, status: "timeout" };
        request.onEvent({ type: "status", data: String(error) });
        return base;
      } finally {
        clearTimeout(timer);
        await events.stop();
      }
    },
  };
}
