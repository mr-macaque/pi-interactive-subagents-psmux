import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { QUESTION_DESCRIPTION, QUESTION_ACK } from "./contract.ts";
import { Type } from "@sinclair/typebox";

/** Child control is protocol-native: no sidecars, polling, or auto-exit hooks. */
export default function (pi: ExtensionAPI) {
  // IPC disappears when the owning parent crashes. This guard also runs in leaf
  // agents, which do not load the delegation extension itself.
  let context: ExtensionContext | undefined;
  type Reply = Pick<InputEvent, "text" | "images">;
  let pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  const disconnect = () => {
    const deadline = setTimeout(() => process.exit(1), 3000);
    deadline.unref();
    try { context?.abort(); context?.shutdown(); } catch { process.exit(1); }
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (process.env.PI_SUBAGENT_ID) {
      process.off("disconnect", disconnect);
      if (process.connected && typeof process.send === "function") process.once("disconnect", disconnect);
      else disconnect(); // Parent may have died before extensions finished loading.
    }
  });
  pi.on("session_shutdown", () => {
    process.off("disconnect", disconnect);
    pending?.reject(new Error("Session shut down while awaiting the parent's reply."));
    pending = undefined;
  });
  pi.on("input", (event) => {
    if (!pending || (!event.text.trim() && !event.images?.length)) return;
    // Consume exactly one reply here, rather than queueing it as a second turn.
    // The answer becomes the tool result, so no model request runs while waiting.
    const question = pending;
    pending = undefined;
    pi.appendEntry("subagent_question_answered", {});
    question.resolve({ text: event.text, images: event.images });
    return { action: "handled" as const };
  });
  pi.registerTool({
    name: "ask_question",
    label: "Ask Parent",
    description: QUESTION_DESCRIPTION,
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, params, signal, onUpdate) {
      if (pending) throw new Error("A question is already awaiting the parent's reply.");
      if (signal?.aborted) throw new Error("Question cancelled.");
      let cancel: (() => void) | undefined;
      const reply = new Promise<Reply>((resolve, reject) => {
        const question = { resolve, reject };
        pending = question;
        cancel = () => {
          if (pending === question) pending = undefined;
          reject(new Error("Question cancelled."));
        };
        signal?.addEventListener("abort", cancel, { once: true });
      });
      // Publishing can fail before the await attaches a rejection handler.
      void reply.catch(() => {});
      try {
        // Register the gate before notifying the parent: an immediate reply is safe.
        onUpdate?.({ content: [{ type: "text", text: QUESTION_ACK }], details: { question: params.question } });
        pi.appendEntry("subagent_question", { question: params.question });
        const answer = await reply;
        return { content: [{ type: "text" as const, text: `Parent reply:\n\n${answer.text}` }, ...(answer.images ?? [])], details: { question: params.question, answered: true } };
      } finally {
        if (cancel) signal?.removeEventListener("abort", cancel);
        // Also release the gate if publishing the question or its UI update failed.
        cancel?.();
      }
    },
  });
}
