import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

/** Deterministic offline provider: a follow-up request before a reply is a bug. */
export default function (pi: ExtensionAPI) {
  let requests = 0;
  pi.registerProvider("question-probe", {
    baseUrl: "https://unused.invalid", apiKey: "offline-test", api: "question-probe-api",
    models: [{ id: "probe", name: "Question probe", reasoning: false, input: ["text"],
      contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      if (options?.signal?.aborted) {
        const error: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: "aborted", errorMessage: "Cancelled", content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end();
        return stream;
      }
      const number = ++requests;
      const hasReply = context.messages.some((m) => m.role === "toolResult" && m.content.some((c) => c.type === "text" && c.text.includes("DECISION: reject expired tokens")));
      pi.appendEntry("question-probe-request", { number, hasReply });
      queueMicrotask(() => {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: "stop", content: [], usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        if (number === 1) {
          message.content.push({ type: "toolCall", id: "question-1", name: "ask_question", arguments: { question: "Reject or refresh expired tokens?" } });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          message.stopReason = "toolUse";
        } else {
          message.content.push({ type: "text", text: hasReply ? "Applied the parent's decision." : "Wasting tokens waiting for a reply." });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: (message.content[0] as any).text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      });
      return stream;
    },
  });
}
