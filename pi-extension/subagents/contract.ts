// Concise RPC contract with explicit delegation safeguards from the Psmux era.
// Config compatibility and presentation/lifecycle fixes are independent.
import { Type } from "@sinclair/typebox";

export const SPAWN_DESCRIPTION = "Launch an isolated Pi subagent in the background; returns an acknowledgement, not a result. Assign one scoped goal, offload context-heavy reads/commands, and request concise evidence. Results arrive automatically when its session ends; non-auto-exiting profiles stay open after each turn. Do not poll status/logs or invent results. Continue independent work or end your turn; follow up by name with subagent_message.";
export const LIST_DESCRIPTION = "Discover available profiles and view spawned sessions. Completion notifications arrive automatically; do not use this tool to poll for results.";
export const MESSAGE_DESCRIPTION = "Follow up by the same name while the subagent is live: answer a pending question or steer its work. Steering queues during an active response; it does not interrupt it. Closed subagents are removed and cannot be resumed; spawn a fresh subagent for more work. Non-auto-exiting sessions have no guaranteed per-turn completion notification. Do not poll or assume results.";
export const QUESTION_DESCRIPTION = "Ask the parent one focused question for a blocking decision or missing requirement. Include enough context to answer directly. Execution pauses in this tool until the parent's reply is returned as its result; do not assume an answer or simulate waiting.";
export const QUESTION_ACK = "Question sent to the parent. Waiting for its reply; model generation is paused.";
export const SubagentParams = Type.Object({
  agent: Type.String({ description: "Agent profile to launch (worker, scout, researcher, or a custom profile)." }),
  task: Type.String({ description: "Task for the subagent." }),
  name: Type.Optional(Type.String({ description: "Unique display name and follow-up handle while the subagent is live." })),
  model: Type.Optional(Type.String({ description: "Model override, subject to /subagent-model configuration." })),
  cwd: Type.Optional(Type.String({ description: "Working directory; relative paths resolve from the parent cwd." })),
});
export const spawnAcknowledgement = (name: string, agent: string, autoExit: boolean) => `Started "${name}" (${agent}). Acknowledgement only; do not assume results or poll. ${autoExit ? "Results arrive automatically when it finishes." : "This profile stays open after each turn; completion is reported when its session ends."} Follow up by this name with subagent_message.`;
export const steerAcknowledgement = (name: string, autoExit: boolean) => `Message delivered to live subagent "${name}". If a response is running, it is queued for the next turn boundary, not an interruption. ${autoExit ? "Its final result arrives automatically when the session ends." : "This profile stays open; no per-turn completion notification is guaranteed."}`;
export const answerAcknowledgement = (name: string) => `Reply delivered to "${name}". Its question is unblocked; the subagent can continue.`;
export function resultPresentation(agent: { name: string; phase: string; elapsed: number; summary: string; error?: string }): string {
  const outcome = agent.phase === "failed" ? agent.error ?? agent.summary : agent.summary;
  return `Subagent "${agent.name}" ${agent.phase} (${agent.elapsed}s).\n\n${outcome}\n\nSession closed and removed. For more work, spawn a fresh subagent.`;
}
export function questionPresentation(name: string, question: string): string {
  return `Subagent "${name}" asks:\n\n${question}\n\nReply with subagent_message({ name: ${JSON.stringify(name)}, message: "…" }).`;
}
export function taskPresentation(task: string, body: string | undefined, systemPromptMode: string | undefined): string {
  return `${!systemPromptMode && body ? body + "\n\n" : ""}Task:\n\n${task}\n\nStay within the assigned scope. Return concise findings/results, relevant paths and verification, not full files or raw logs. If blocked, use ask_question for one focused question; execution pauses until the parent's reply is returned as the tool result. Otherwise finish with a concise final summary; do not simulate waiting or repeatedly announce that you are stopping.`;
}
