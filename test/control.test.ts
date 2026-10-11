import { it } from "node:test";
import assert from "node:assert/strict";
import control from "../pi-extension/subagents/control.ts";

function harness() {
  const handlers = new Map<string, any>();
  const entries: any[] = [];
  let tool: any;
  const api: any = { on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (t: any) => tool = t,
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }) };
  control(api);
  return { api, entries, handlers, ask: (signal?: AbortSignal, update?: any) => tool.execute("question", { question: "Which file?" }, signal, update),
    input: (text: string, images?: any[]) => handlers.get("input")({ text, images, source: "rpc" }) };
}

it("holds the question tool until a reply arrives, consuming that reply exactly once", async () => {
  const h = harness();
  let resolved = false;
  const updates: any[] = [];
  const result = h.ask(undefined, (r: any) => updates.push(r)).then((r: any) => { resolved = true; return r; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, "the agent cannot request another model response while the tool is pending");
  assert.equal(h.entries[0].customType, "subagent_question");
  assert.match(updates[0].content[0].text, /model generation is paused/);
  assert.deepEqual(h.input("Use a.ts"), { action: "handled" });
  const reply = await result;
  assert.equal(reply.content[0].text, "Parent reply:\n\nUse a.ts");
  assert.equal(reply.details.answered, true);
  assert.equal(h.entries[1].customType, "subagent_question_answered");
  assert.equal(h.input("ordinary follow-up"), undefined);
});

it("accepts an immediate reply during notification without losing it", async () => {
  const h = harness();
  const publish = h.api.appendEntry;
  h.api.appendEntry = (type: string, data: any) => { publish(type, data); if (type === "subagent_question") h.input("Immediate decision"); };
  assert.equal((await h.ask()).content[0].text, "Parent reply:\n\nImmediate decision");
});

it("does not release the gate for empty input, but preserves image replies", async () => {
  const h = harness();
  const result = h.ask();
  assert.equal(h.input("  "), undefined);
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  assert.deepEqual(h.input("", [image]), { action: "handled" });
  assert.deepEqual((await result).content[1], image);
});

it("rejects overlapping questions instead of creating multiple wait gates", async () => {
  const h = harness();
  const first = h.ask();
  await assert.rejects(h.ask(), /already awaiting/);
  h.input("First reply");
  await first;
  const second = h.ask();
  h.input("Second reply");
  assert.equal((await second).content[0].text, "Parent reply:\n\nSecond reply");
});

it("cancellation releases the gate without hanging or consuming later input", async () => {
  const h = harness();
  const abort = new AbortController();
  const result = h.ask(abort.signal);
  abort.abort();
  await assert.rejects(result, /cancelled/);
  assert.equal(h.input("later message"), undefined);
  await assert.rejects(h.ask(abort.signal), /cancelled/);
});

it("shutdown and failed notification release pending questions", async () => {
  const h = harness();
  const result = h.ask();
  h.handlers.get("session_shutdown")();
  await assert.rejects(result, /shut down/);
  h.api.appendEntry = () => { throw new Error("publishing failed"); };
  await assert.rejects(h.ask(), /publishing failed/);
  assert.equal(h.input("later message"), undefined);
});
