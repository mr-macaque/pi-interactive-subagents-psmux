import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpc } from "../../pi-extension/subagents/rpc.ts";
import { seedSubagentSessionFile } from "../../pi-extension/subagents/session.ts";

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Question pause test timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("real Pi makes no follow-up model request until the question is answered", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-question-pause-"));
  const session = join(dir, "session.jsonl");
  seedSubagentSessionFile({ mode: "standalone", childSessionFile: session, childCwd: dir });
  const control = fileURLToPath(new URL("../../pi-extension/subagents/control.ts", import.meta.url));
  const provider = fileURLToPath(new URL("./fixtures/question-provider.ts", import.meta.url));
  const rpc = new PiRpc(["--offline", "--session", session, "--no-extensions", "--no-mcp", "-e", control, "-e", provider,
    "--provider", "question-probe", "--model", "probe", "--tools", "ask_question"],
    { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_ID: "question-probe" } });
  const entries: any[] = [];
  const errors: any[] = [];
  rpc.on("record", (r) => {
    if (r.type === "entry_appended") entries.push(r.entry);
    if (r.type === "extension_error") errors.push(r);
  });
  try {
    await rpc.request("get_state");
    await rpc.prompt("Perform the bounded assignment; ask for a decision if blocked.");
    await waitFor(() => entries.some((e) => e.customType === "subagent_question"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(entries.filter((e) => e.customType === "question-probe-request").length, 1,
      "a pending question must not generate any follow-up waiting/thinking response");
    const before = (await rpc.request("get_messages")).messages;
    assert.equal(before.filter((m: any) => m.role === "assistant").length, 1);
    await rpc.prompt("DECISION: reject expired tokens");
    await waitFor(async () => !(await rpc.request("get_state")).isStreaming);
    const requests = entries.filter((e) => e.customType === "question-probe-request");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].data.hasReply, true);
    const messages = (await rpc.request("get_messages")).messages;
    assert.equal(messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "question-1").length, 1);
    assert.ok(messages.some((m: any) => m.role === "toolResult" && m.content.some((c: any) => c.text?.includes("DECISION: reject expired tokens"))));
    assert.ok(!messages.some((m: any) => m.role === "user" && m.content.some((c: any) => c.text?.includes("DECISION:"))), "reply must not be queued twice");
    assert.deepEqual(errors, []);
  } finally {
    await rpc.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real Pi can stop cleanly while the question tool is paused", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-question-cancel-"));
  const session = join(dir, "session.jsonl");
  seedSubagentSessionFile({ mode: "standalone", childSessionFile: session, childCwd: dir });
  const control = fileURLToPath(new URL("../../pi-extension/subagents/control.ts", import.meta.url));
  const provider = fileURLToPath(new URL("./fixtures/question-provider.ts", import.meta.url));
  const rpc = new PiRpc(["--offline", "--session", session, "--no-extensions", "--no-mcp", "-e", control, "-e", provider,
    "--provider", "question-probe", "--model", "probe", "--tools", "ask_question"],
    { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_ID: "question-cancel" } });
  let asked = false;
  rpc.on("record", (r) => { if (r.type === "entry_appended" && r.entry?.customType === "subagent_question") asked = true; });
  try {
    await rpc.request("get_state");
    await rpc.prompt("Ask for a decision.");
    await waitFor(() => asked);
    await rpc.stop();
    assert.equal((await rpc.closed).code, 0);
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
