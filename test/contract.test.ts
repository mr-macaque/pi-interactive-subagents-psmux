import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import extension from "../pi-extension/subagents/index.ts";
import control from "../pi-extension/subagents/control.ts";
import * as contract from "../pi-extension/subagents/contract.ts";
const baseline = JSON.parse(readFileSync(new URL("./fixtures/rpc-contract.json", import.meta.url), "utf8"));

it("preserves RPC schemas/rendering while adding dense hybrid descriptions",  () => {
  const tools = new Map<string, any>();
  const api: any = { on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {} };
  extension(api); control(api);
  const descriptions: Record<string, string> = { subagent: contract.SPAWN_DESCRIPTION, subagents_list: contract.LIST_DESCRIPTION, subagent_message: contract.MESSAGE_DESCRIPTION, ask_question: contract.QUESTION_DESCRIPTION };
  for (const [name, expected] of Object.entries(baseline.tools) as [string, any][]) {
    const tool = tools.get(name);
    assert.equal(tool.label, expected.label);
    assert.equal(tool.description, descriptions[name]);
    assert.ok(tool.description.split(/\s+/).length <= 75, "guidance must remain dense");
    const parameters = JSON.parse(JSON.stringify(expected.parameters));
    if (name === "subagent") parameters.properties.name.description = "Unique display name and follow-up handle while the subagent is live.";
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), parameters);
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.equal(tool.renderCall, undefined, "ordinary calls must remain available to appearance extensions");
    assert.equal(tool.renderResult, undefined);
    assert.ok(!tool.description.includes("multiplexer"));
  }
});

it("distinguishes launch, steering, answering and waiting without false delivery promises",  () => {
  assert.match(contract.spawnAcknowledgement("scout", "scout", true), /Acknowledgement only; do not assume results or poll/);
  assert.match(contract.spawnAcknowledgement("scout", "scout", true), /Results arrive automatically when it finishes/);
  assert.match(contract.spawnAcknowledgement("worker", "worker", false), /stays open after each turn/);
  assert.ok(!contract.spawnAcknowledgement("worker", "worker", false).includes("when it finishes"));
  assert.match(contract.steerAcknowledgement("scout", true), /queued for the next turn boundary, not an interruption/);
  assert.match(contract.steerAcknowledgement("worker", false), /no per-turn completion notification is guaranteed/);
  assert.equal(contract.answerAcknowledgement("worker"), 'Reply delivered to "worker". Its question is unblocked; the subagent can continue.');
  assert.match(contract.MESSAGE_DESCRIPTION, /Closed subagents are removed and cannot be resumed/);
  assert.equal(contract.QUESTION_ACK, "Question sent to the parent. Waiting for its reply; model generation is paused.");
});

it("keeps essential no-polling, no-invention and focused-question safeguards", () => {
  assert.match(contract.SPAWN_DESCRIPTION, /acknowledgement, not a result/);
  assert.match(contract.SPAWN_DESCRIPTION, /Do not poll status\/logs or invent results/);
  assert.match(contract.MESSAGE_DESCRIPTION, /same name/);
  assert.match(contract.MESSAGE_DESCRIPTION, /does not interrupt/);
  assert.match(contract.QUESTION_DESCRIPTION, /one focused question/);
  assert.match(contract.QUESTION_DESCRIPTION, /Execution pauses in this tool/);
  assert.match(contract.QUESTION_DESCRIPTION, /do not assume an answer/);
});

it("uses RPC result, cancellation, terminal failure and question formats", () => {
  assert.equal(contract.resultPresentation({ name: "scout", phase: "completed", elapsed: 61, summary: "Done" }), 'Subagent "scout" completed (61s).\n\nDone\n\nSession closed and removed. For more work, spawn a fresh subagent.');
  assert.equal(contract.resultPresentation({ name: "scout", phase: "cancelled", elapsed: 61, summary: "Cancelled" }), 'Subagent "scout" cancelled (61s).\n\nCancelled\n\nSession closed and removed. For more work, spawn a fresh subagent.');
  assert.equal(contract.resultPresentation({ name: "scout", phase: "failed", elapsed: 61, summary: "", error: "Unavailable" }), 'Subagent "scout" failed (61s).\n\nUnavailable\n\nSession closed and removed. For more work, spawn a fresh subagent.');
  assert.equal(contract.questionPresentation("scout", "Which file?"), 'Subagent "scout" asks:\n\nWhich file?\n\nReply with subagent_message({ name: "scout", message: "…" }).');
});

it("uses one RPC task wrapper without historical pane/exit instructions", () => {
  const task = contract.taskPresentation("Do work", "Role", undefined);
  assert.ok(task.startsWith("Role\n\nTask:\n\nDo work\n\n"));
  assert.equal(contract.taskPresentation("Do work", "Role", "append"), task.slice("Role\n\n".length));
  assert.match(task, /Stay within the assigned scope/);
  assert.match(task, /not full files or raw logs/);
  assert.match(task, /execution pauses until the parent's reply is returned as the tool result/);
  assert.match(task, /do not simulate waiting/);
  assert.ok(!task.includes("pane"));
});
