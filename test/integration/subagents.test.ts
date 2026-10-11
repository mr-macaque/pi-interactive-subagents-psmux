import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PiRpc } from "../../pi-extension/subagents/rpc.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
const root = mkdtempSync(join(tmpdir(), "pi rpc integration "));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "agents"), { recursive: true });
writeFileSync(join(root, "agent", "agents", "branch.md"), "---\nname: branch\nmodel: inherit\ntools: read\nauto-exit: true\nsubagent_agents: branch-mid, scout\n---\nTest branch\n");
writeFileSync(join(root, "agent", "agents", "branch-mid.md"), "---\nname: branch-mid\nmodel: inherit\ntools: read\nauto-exit: true\nsubagent_agents: scout\n---\nTest middle branch\n");
writeFileSync(join(root, "agent", "agents", "interactive-worker.md"), "---\nname: interactive-worker\nmodel: inherit\ntools: read\nauto-exit: false\n---\nTest persistent worker\n");
const { default: extension } = await import("../../pi-extension/subagents/index.ts");
const fixture = fileURLToPath(new URL("./fixtures/pi-rpc.mjs", import.meta.url));
after(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

it("keeps the hybrid spawn/list/steer and direct RPC task contract", async () => {
  const h = await setup();
  try {
    const listed = await h.execute("subagents_list", {});
    assert.ok(JSON.parse(listed.content[0].text).profiles.some((a: any) => a.name === "scout"));
    const spawned = await h.execute("subagent", { agent: "scout", name: "legacy", task: "HOLD" });
    assert.match(spawned.content[0].text, /Acknowledgement only; do not assume results or poll/);
    assert.match(spawned.content[0].text, /Results arrive automatically when it finishes/);
    assert.equal(spawned.details.name, "legacy");
    const history = await h.processes[0].request("get_messages");
    const prompt = history.messages.find((m: any) => m.role === "user").content;
    const text = typeof prompt === "string" ? prompt : prompt.map((c: any) => c.text ?? "").join("");
    assert.match(text, /^Task:\n\nHOLD/);
    assert.ok(!text.includes("<file name="));
    assert.match(text, /Stay within the assigned scope/);
    assert.match(text, /execution pauses until the parent's reply is returned as the tool result/);
    const steered = await h.execute("subagent_message", { name: "legacy", message: "HOLD" });
    assert.match(steered.content[0].text, /Message delivered to live subagent "legacy"/);
    assert.match(steered.content[0].text, /queued for the next turn boundary, not an interruption/);
    await assert.rejects(h.execute("subagent_message", { name: "missing", message: "work" }), /No live subagent named "missing"/);
  } finally { await h.shutdown(); }
});

async function setup(cleanupConfig?: { deleteSessionFiles: boolean }) {
  const dir = mkdtempSync(join(root, "parent "));
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const results: any[] = [];
  const entries: any[] = [];
  const launches: any[] = [];
  const processes: PiRpc[] = [];
  const packets: any[] = [];
  const widgets = new Map<string, any>();
  const ui: any = {
    notify() {}, setWidget(key: string, factory: any) { if (factory) widgets.set(key, factory); else widgets.delete(key); }, onTerminalInput() { return () => {}; },
  };
  const ctx: any = {
    cwd: dir, mode: "rpc", hasUI: true, ui, model: { provider: "test", id: "parent", reasoning: true },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "parent", reasoning: true }] },
    sessionManager: { getSessionDir: () => dir, getSessionId: () => "main", getSessionFile: () => join(dir, "main.jsonl") },
  };
  mkdirSync(dir, { recursive: true });
  const api: any = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
    getThinkingLevel: () => "medium",
    sendMessage: (message: any) => results.push(message),
  };
  extension(api, { cleanupConfig, createRpc: (args, options) => {
    launches.push({ args, options });
    const rpc = new PiRpc(args, options, (_command, rawArgs, opts) => spawn(process.execPath, ["--experimental-transform-types", fixture, ...rawArgs.slice(3)], opts) as any);
    rpc.on("tree", (packet) => packets.push(packet));
    processes.push(rpc);
    return rpc;
  } });
  await events.get("session_start")({}, ctx);
  const execute = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, ctx);
  return { api, ctx, execute, commands, events, processes, results, entries, launches, packets, widgets, shutdown: () => events.get("session_shutdown")({}, ctx) };
}
it("excludes legacy internal diagnostics from orchestrator context but retains terminal failures", async () => {
  const h = await setup();
  try {
    const legacy = { role: "custom", customType: "subagent_error", content: "grep failed: missing path" };
    const failed = { role: "custom", customType: "subagent_error", content: "Child exited", details: { phase: "failed" } };
    const answer = { role: "assistant", content: [{ type: "text", text: "Keep this response" }] };
    const result = await h.events.get("context")({ messages: [legacy, failed, answer] }, h.ctx);
    assert.deepEqual(result.messages, [failed, answer]);
    const preparation = { messagesToSummarize: [legacy, failed, answer], turnPrefixMessages: [legacy, answer] };
    const branchEntries = [{ type: "custom_message", customType: "subagent_error", content: legacy.content }];
    await h.events.get("session_before_compact")({ preparation, branchEntries }, h.ctx);
    assert.deepEqual(preparation.messagesToSummarize, [failed, answer]);
    assert.deepEqual(preparation.turnPrefixMessages, [answer]);
    assert.deepEqual(branchEntries, []);
    const tree = { entriesToSummarize: [{ type: "custom_message", customType: "subagent_error", content: legacy.content }] };
    await h.events.get("session_before_tree")({ preparation: tree }, h.ctx);
    assert.deepEqual(tree.entriesToSummarize, []);
  } finally { await h.shutdown(); }
});

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Integration test timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("launches concurrent agents, reports once, retires handles and allows fresh names",  async () => {
  const h = await setup();
  try {
    const [a, b] = await Promise.all([
      h.execute("subagent", { agent: "scout", task: "COMPLETE first" }),
      h.execute("subagent", { agent: "scout", task: "COMPLETE second" }),
    ]);
    assert.equal(a.details.name, "scout");
    assert.equal(b.details.name, "scout-2");
    await waitFor(() => h.results.length === 2);
    assert.ok(h.results.every((r) => r.details.phase === "completed"));
    assert.ok(existsSync(a.details.sessionFile + ".loadout.json"));
    assert.ok(existsSync(a.details.sessionFile), "saved files are retained by default");
    const launch = h.launches[0];
    assert.ok(launch.args.includes("--no-extensions"));
    assert.ok(launch.args.includes("--no-mcp"));
    assert.ok(!launch.args.some((a: string) => a.startsWith("@") || a.includes("__SUBAGENT_DONE")));
    assert.equal((await h.execute("subagents_list", {})).details.sessions.length, 0);
    const registryPath = join(h.ctx.sessionManager.getSessionDir(), "artifacts", "main", "subagent-registry.json");
    assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), {});
    await assert.rejects(h.execute("subagent_message", { name: "scout", message: "follow-up" }), /Closed subagents are removed/);
    const fresh = await h.execute("subagent", { agent: "scout", name: "scout", task: "COMPLETE fresh" });
    await waitFor(() => h.results.length === 3);
    assert.notEqual(fresh.details.sessionFile, a.details.sessionFile);
    assert.equal(h.launches[2].args[h.launches[2].args.indexOf("--tools") + 1], "read,grep,find,ls,ask_question");
  } finally { await h.shutdown(); }
});

it("optionally deletes child files only after preserving the delivered result", async () => {
  const h = await setup({ deleteSessionFiles: true });
  try {
    const child = await h.execute("subagent", { agent: "scout", name: "ephemeral", task: "HOLD" });
    const file = child.details.sessionFile;
    const id = JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id;
    const artifacts = join(dirname(file), "artifacts", id);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "child-only.txt"), "private artifact");
    writeFileSync(h.ctx.sessionManager.getSessionFile(), "parent history");
    assert.ok(existsSync(file));
    await h.execute("subagent_message", { name: "ephemeral", message: "COMPLETE bounded task" });
    await waitFor(() => h.results.some((r) => r.details?.name === "ephemeral"));
    const result = h.results.find((r) => r.details?.name === "ephemeral");
    assert.match(result.content, /Done:/);
    assert.match(result.content, /Session closed and removed/);
    assert.equal(h.results.filter((r) => r.details?.name === "ephemeral").length, 1);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.loadout.json`), false);
    assert.equal(existsSync(artifacts), false);
    assert.equal(readFileSync(h.ctx.sessionManager.getSessionFile(), "utf8"), "parent history");
    assert.equal((await h.execute("subagents_list", {})).details.sessions.length, 0);
  } finally { await h.shutdown(); }
});

it("retains files when the final result cannot be delivered", async () => {
  const h = await setup({ deleteSessionFiles: true });
  try {
    const child = await h.execute("subagent", { agent: "scout", name: "undelivered", task: "HOLD" });
    h.api.sendMessage = () => { throw new Error("delivery failed"); };
    await h.execute("subagent_message", { name: "undelivered", message: "COMPLETE work" });
    await waitFor(() => h.entries.some((e) => e.data?.content?.includes("delivery failed")));
    assert.ok(existsSync(child.details.sessionFile));
    assert.ok(existsSync(child.details.sessionFile + ".loadout.json"));
    assert.equal(h.results.length, 0);
  } finally { await h.shutdown(); }
});

it("retires legacy saved handles on restart without deleting old files", async () => {
  const h = await setup({ deleteSessionFiles: true });
  try {
    const file = join(h.ctx.cwd, "legacy.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", id: "legacy-id" }) + "\n");
    const registry = join(h.ctx.cwd, "artifacts", "main", "subagent-registry.json");
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify({ legacy: { sessionFile: file, sessionId: "legacy-id" } }));
    await h.events.get("session_start")({}, h.ctx);
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), {});
    assert.equal((await h.execute("subagents_list", {})).details.sessions.length, 0);
  } finally { await h.shutdown(); }
});

it("does not promise per-turn completion for a live non-auto-exiting profile", async () => {
  const h = await setup();
  try {
    const spawned = await h.execute("subagent", { agent: "interactive-worker", name: "persistent", task: "COMPLETE first" });
    assert.match(spawned.content[0].text, /stays open after each turn/);
    await waitFor(async () => {
      const listed = await h.execute("subagents_list", {});
      return listed.details.sessions.some((s: any) => s.name === "persistent" && s.activity === "ready for a message");
    });
    assert.equal(h.results.length, 0);
    const steered = await h.execute("subagent_message", { name: "persistent", message: "COMPLETE second" });
    assert.match(steered.content[0].text, /Message delivered to live subagent "persistent"/);
    assert.match(steered.content[0].text, /no per-turn completion notification is guaranteed/);
    assert.equal(h.launches.length, 1, "idle live sessions must be steered, not relaunched");
    assert.equal(h.results.length, 0);
  } finally { await h.shutdown(); }
});

it("question flow stays alive, reply completes, and crash restores the selected view",  async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", task: "ASK which file" });
    await waitFor(() => h.results.some((r) => r.customType === "subagent_question"));
    assert.equal(h.results.filter((r) => r.customType === "subagent_result").length, 0);
    const reply = await h.execute("subagent_message", { name: "scout", message: "COMPLETE a.ts" });
    assert.match(reply.content[0].text, /Reply delivered to "scout"\. Its question is unblocked/);
    await waitFor(() => h.results.some((r) => r.customType === "subagent_result"));
    await h.execute("subagent", { agent: "scout", name: "crasher", task: "HOLD" });
    let component: any;
    let returned = false;
    let consume: any;
    h.ctx.mode = "tui";
    h.ctx.ui.onTerminalInput = (handler: any) => { consume = handler; return () => { consume = undefined; }; };
    h.ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
      component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text }, {}, () => { returned = true; resolve(); });
    });
    const viewing = h.commands.get("subagents").handler("crasher", h.ctx);
    assert.ok(component);
    assert.ok(consume);
    h.processes[1].process.kill();
    await viewing;
    assert.equal(returned, true);
    assert.equal(consume, undefined);
    await waitFor(() => h.results.some((r) => r.details?.name === "crasher"));
    assert.equal(h.results.find((r) => r.details?.name === "crasher").details.phase, "failed");
    assert.equal(h.results.filter((r) => r.details?.name === "crasher").length, 1);
    assert.equal(h.results.find((r) => r.details?.name === "crasher").customType, "subagent_error");
  } finally { await h.shutdown(); }
});

it("stopping the selected agent returns to main without cancelling another child", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    await h.execute("subagent", { agent: "scout", name: "two", task: "HOLD" });
    let consume: any;
    let returned = 0;
    h.ctx.mode = "tui";
    h.ctx.ui.onTerminalInput = (handler: any) => { consume = handler; return () => { consume = undefined; }; };
    h.ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
      factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text }, {}, () => { returned++; resolve(); });
    });
    const viewing = h.commands.get("subagents").handler("one", h.ctx);
    assert.deepEqual(consume("\x03"), { consume: true });
    await viewing;
    assert.equal(returned, 1);
    await waitFor(() => h.results.some((r) => r.details?.name === "one"));
    assert.equal(h.results[0].details.phase, "cancelled");
    const list = await h.execute("subagents_list", {});
    assert.equal(list.details.sessions.find((s: any) => s.name === "two").phase, "running");
    await h.shutdown();
    await Promise.all(h.processes.map((rpc) => rpc.closed));
    assert.equal(h.results.length, 1, "shutdown must not deliver results into a dead parent session");
  } finally { await h.shutdown(); }
});

function view(h: Awaited<ReturnType<typeof setup>>, name: string) {
  const state: { returned: number; component?: any; consume?: any } = { returned: 0 };
  h.ctx.mode = "tui";
  h.ctx.ui.onTerminalInput = (handler: any) => { state.consume = handler; return () => { state.consume = undefined; }; };
  h.ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
    state.component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text, bold: (text: string) => text }, {}, () => { state.returned++; resolve(); });
  });
  return { state, done: h.commands.get("subagents").handler(name, h.ctx) };
}
async function waitSessions(h: Awaited<ReturnType<typeof setup>>, predicate: (sessions: any[]) => boolean) {
  const deadline = Date.now() + 10000;
  while (true) {
    const sessions = (await h.execute("subagents_list", {})).details.sessions;
    if (predicate(sessions)) return sessions;
    if (Date.now() > deadline) throw new Error(`Tree test timed out: ${JSON.stringify(sessions)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("opens long-running child views after valid and legacy compaction without stopping them", async () => {
  const h = await setup();
  try {
    for (const task of ["COMPACT HOLD", "LEGACY_COMPACT HOLD"]) {
      const name = task.startsWith("LEGACY") ? "legacy-compaction" : "live-compaction";
      await h.execute("subagent", { agent: "scout", name, task });
      await waitFor(() => existsSync(h.launches.at(-1).args[h.launches.at(-1).args.indexOf("--session") + 1] + ".heartbeat"));
      const opened = view(h, name);
      assert.doesNotThrow(() => opened.state.component.render(100));
      assert.equal(opened.state.returned, 0);
      assert.equal(opened.state.component.agent.live, true);
      assert.equal(h.entries.length, 0);
      assert.equal(h.results.length, 0);
      opened.state.consume("\x1b");
      await opened.done;
      assert.equal(opened.state.component.agent.live, true, "returning must leave the long-running child alive");
    }
  } finally { await h.shutdown(); }
});

it("opens a grandchild in the root tab, routes messages to it, and delivers completion to its owner", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running") && s.find((a) => a.name === "one")?.phase === "waiting");
    const v = view(h, "one/leaf");
    assert.equal(v.state.component.agent.name, "one/leaf");
    assert.ok(v.state.component.render(100).some((line: string) => line.includes("Return to main agent")));
    await h.execute("subagent_message", { name: "one/leaf", message: "COMPLETE root follow-up" });
    await v.done;
    assert.equal(v.state.returned, 1);
    assert.equal(v.state.consume, undefined);
    await waitSessions(h, (s) => s.length === 0);
    assert.ok(h.entries.some((r) => r.data?.details?.name === "one/leaf" && r.data?.details?.parent === "one"));
    assert.ok(!h.results.some((r) => r.details?.name === "one/leaf"), "descendant results must not enter root model context");
    await waitFor(() => h.results.some((r) => r.details?.name === "one"));
    assert.ok(h.results.find((r) => r.details?.name === "one").content.includes("root follow-up"));
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
  } finally { await h.shutdown(); }
});

it("returning manually from a deeply nested view keeps the entire branch running", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NEST3" });
    const sessions = await waitSessions(h, (s) => s.some((a) => a.name === "one/middle/leaf" && a.phase === "running"));
    assert.deepEqual(sessions.map((a) => a.name), ["one", "one/middle", "one/middle/leaf"]);
    const v = view(h, "one/middle/leaf");
    v.state.component.handleInput("draft");
    await h.execute("subagent_message", { name: "one/middle", message: "SETTLE own turn" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(v.state.returned, 0, "an ancestor settling its own turn must not close a busy descendant view");
    v.state.consume("\x1b");
    await v.done;
    assert.equal(v.state.returned, 1);
    assert.equal(v.state.component.agent.draft, "draft");
    await waitSessions(h, (s) => s.find((a) => a.name === "one/middle/leaf")?.phase === "running");
    assert.equal(h.results.filter((r) => r.customType === "subagent_result").length, 0);
  } finally { await h.shutdown(); }
});

it("stopping an ancestor while viewing its grandchild returns immediately and preserves a sibling", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await h.execute("subagent", { agent: "scout", name: "sibling", task: "HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    const v = view(h, "one/leaf");
    const stopping = h.commands.get("subagent-stop").handler("one", h.ctx);
    assert.equal(v.state.returned, 1, "return must not wait for subprocess shutdown");
    await v.done;
    await stopping;
    await waitSessions(h, (s) => !s.some((a) => a.name === "one" || a.name.startsWith("one/")));
    assert.ok(h.results.some((r) => r.details?.name === "one" && r.details.phase === "cancelled"));
    assert.equal((await h.execute("subagents_list", {})).details.sessions.find((a: any) => a.name === "sibling").phase, "running");
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
  } finally { await h.shutdown(); }
});

it("stopping a nested parent routes through its owner and closes the deeper view", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NEST3" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/middle/leaf" && a.phase === "running"));
    const v = view(h, "one/middle/leaf");
    const stopping = h.commands.get("subagent-stop").handler("one/middle", h.ctx);
    assert.equal(v.state.returned, 1);
    await v.done;
    await stopping;
    await waitSessions(h, (s) => !s.some((a) => a.name === "one/middle" || a.name.startsWith("one/middle/")));
    assert.ok(h.entries.some((e) => e.data?.details?.name === "one/middle" && e.data.details.phase === "cancelled"));
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
  } finally { await h.shutdown(); }
});

it("ancestor crash restores main, reports the error in chat and terminates the orphan", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await h.execute("subagent", { agent: "scout", name: "sibling", task: "HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    const leaf = h.packets.find((p) => p.kind === "spawn" && p.node.name === "leaf").node;
    await waitFor(() => existsSync(leaf.sessionFile + ".heartbeat"));
    const v = view(h, "one/leaf");
    h.processes[0].process.kill();
    await v.done;
    assert.equal(v.state.returned, 1);
    assert.equal(v.state.consume, undefined);
    await waitSessions(h, (s) => !s.some((a) => a.name === "one/leaf"));
    assert.ok(h.entries.some((e) => e.data?.details?.name === "one/leaf" && e.data.details.phase === "failed"));
    await waitFor(() => h.results.some((r) => r.details?.phase === "failed"));
    assert.ok(h.results.some((r) => r.details?.phase === "failed" && r.content.includes("one")));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const heartbeat = readFileSync(leaf.sessionFile + ".heartbeat", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(readFileSync(leaf.sessionFile + ".heartbeat", "utf8"), heartbeat, "orphan process must no longer run");
    assert.equal((await h.execute("subagents_list", {})).details.sessions.find((a: any) => a.name === "sibling").phase, "running");
  } finally { await h.shutdown(); }
});

it("shows descendant questions to the user without duplicating them in root model context", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    await h.execute("subagent_message", { name: "one/leaf", message: "ASK which file" });
    await waitFor(() => h.entries.some((e) => e.data?.customType === "subagent_question"));
    assert.ok(!h.results.some((r) => r.customType === "subagent_question"));
    const notification = h.entries.find((e) => e.data?.customType === "subagent_question").data;
    assert.equal(notification.details.delivery, "observer");
    assert.equal(notification.details.name, "one/leaf");
  } finally { await h.shutdown(); }
});

it("nested tool errors stay in the child without closing its view or entering orchestrator chat",  async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    const v = view(h, "one/leaf");
    await h.execute("subagent_message", { name: "one/leaf", message: "TOOL_ERROR" });
    await waitFor(() => v.state.component.agent.tools.get("bad")?.state === "failed");
    assert.equal(v.state.returned, 0);
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
    assert.ok(v.state.component.agent.tools.get("bad").result.content[0].text.includes("fixture missing file"));
    assert.equal((await h.execute("subagents_list", {})).details.sessions.find((a: any) => a.name === "one/leaf").phase, "running", "recoverable tool errors do not cancel the agent");
    await h.execute("subagent_message", { name: "one/leaf", message: "COMPLETE recovered" });
    await v.done;
    await waitFor(() => h.entries.some((r) => r.data?.customType === "subagent_result" && r.data.details.name === "one/leaf"));
    assert.equal(v.state.returned, 1);
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
    assert.ok(!h.results.some((r) => r.content.includes("fixture missing file")));
  } finally { await h.shutdown(); }
});

it("malformed conversation rendering falls back to main and posts a visible chat error", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    const v = view(h, "one");
    v.state.component.agent.messages.push({ role: "assistant", content: {} });
    assert.deepEqual(v.state.component.render(100), []);
    await v.done;
    assert.equal(v.state.returned, 1);
    assert.ok(h.entries.some((r) => r.data?.customType === "subagent_error" && r.data.content.includes("Subagent view")));
    assert.equal(h.results.length, 0);
  } finally { await h.shutdown(); }
});

it("tool validation uses ordinary tool output without extra cards or dismissing a child view", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    const v = view(h, "one");
    await assert.rejects(h.execute("subagent", { agent: "does-not-exist", task: "test" }), /Unknown or disallowed agent/);
    assert.equal(v.state.returned, 0);
    assert.equal(h.entries.length, 0);
    assert.equal(h.results.length, 0);
    await assert.rejects(h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" }), /already taken/);
    assert.equal(h.entries.length, 0, "name conflicts must not create a duplicate error card");
    assert.equal(v.state.returned, 0);
    v.state.consume("\x1b");
    await v.done;
  } finally { await h.shutdown(); }
});

it("a nested blocking dialog is shown once at the root and ancestor stop releases it", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    const v = view(h, "one/leaf");
    let dialogs = 0;
    let released = 0;
    h.ctx.ui.custom = (factory: any) => new Promise((resolve) => {
      dialogs++;
      factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text, bold: (text: string) => text }, {}, (response: any) => { released++; resolve(response); });
    });
    await h.execute("subagent_message", { name: "one/leaf", message: "DIALOG" });
    await v.done;
    await waitFor(() => dialogs > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dialogs, 1, "intermediate parents must not re-open the same forwarded dialog");
    await h.commands.get("subagent-stop").handler("one", h.ctx);
    assert.equal(released, 1, JSON.stringify(h.results));
    assert.equal(v.state.consume, undefined);
    assert.equal(h.results.filter((r) => r.customType === "subagent_error").length, 0);
  } finally { await h.shutdown(); }
});

it("crashing an intermediate ancestor closes the deepest view and cleans its branch", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NEST3" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/middle/leaf" && a.phase === "running"));
    const middle = h.packets.find((p) => p.kind === "spawn" && p.node.name === "middle").node;
    const leaf = h.packets.find((p) => p.kind === "spawn" && p.node.name === "leaf").node;
    await waitFor(() => existsSync(leaf.sessionFile + ".heartbeat"));
    const v = view(h, "one/middle/leaf");
    process.kill(middle.pid);
    await v.done;
    assert.equal(v.state.returned, 1);
    await waitSessions(h, (s) => !s.some((a) => a.name === "one/middle/leaf"));
    assert.ok(h.entries.some((e) => e.data?.details?.name === "one/middle/leaf" && e.data.details.phase === "failed"));
    assert.ok(h.entries.some((r) => r.data?.details?.phase === "failed" && r.data.content.includes("one/middle")));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const heartbeat = readFileSync(leaf.sessionFile + ".heartbeat", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(readFileSync(leaf.sessionFile + ".heartbeat", "utf8"), heartbeat);
  } finally { await h.shutdown(); }
});

it("unexpected modal creation failure reports an error and releases the waiting child", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "branch", name: "one", task: "NESTED HOLD" });
    await waitSessions(h, (s) => s.some((a) => a.name === "one/leaf" && a.phase === "running"));
    const v = view(h, "one/leaf");
    h.ctx.ui.custom = async () => { throw new Error("unexpected modal failure"); };
    await h.execute("subagent_message", { name: "one/leaf", message: "DIALOG" });
    await v.done;
    await waitSessions(h, (s) => s.length === 0);
    assert.equal(v.state.returned, 1);
    assert.ok(h.entries.some((r) => r.data?.customType === "subagent_error" && r.data.content.includes("unexpected modal failure")));
  } finally { await h.shutdown(); }
});

it("tool validation leaves an open selector alone and adds no custom main-chat error", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    const picker = view(h, "");
    await assert.rejects(h.execute("subagent", { agent: "invalid-profile", task: "test" }), /Unknown or disallowed agent/);
    assert.equal(picker.state.returned, 0);
    assert.equal(h.entries.length, 0);
    picker.state.component.handleInput("\x1b");
    await picker.done;
    assert.equal(picker.state.returned, 1);
    assert.equal(picker.state.consume, undefined);
    const reopened = view(h, "one");
    assert.equal(reopened.state.component.agent.name, "one");
    reopened.state.consume("\x1b");
    await reopened.done;
  } finally { await h.shutdown(); }
});

it("keeps the subagent widget stable above observation progress throughout streaming updates", async () => {
  const h = await setup();
  try {
    h.ctx.mode = "tui";
    const observation = () => ({ render: () => ["Creating observations…"], invalidate() {} });
    h.widgets.set("observations", observation);
    const bridge = (globalThis as any)[Symbol.for("pi-subagents/native-presentation")];
    bridge.frontends.set(h.ctx.sessionManager, { extensionWidgetsAbove: h.widgets, renderWidgets() {} });
    let registrations = 0;
    const setWidget = h.ctx.ui.setWidget;
    h.ctx.ui.setWidget = (key: string, content: any) => { if (key === "subagent-status" && content) registrations++; setWidget(key, content); };
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    const factory = h.widgets.get("subagent-status");
    let renders = 0;
    const widget = factory({ requestRender() { renders++; } });
    await h.execute("subagent_message", { name: "one", message: "TOOL_ERROR" });
    await waitFor(() => renders > 0);
    assert.equal(registrations, 1);
    assert.equal(h.widgets.get("subagent-status"), factory);
    assert.deepEqual([...h.widgets.keys()], ["subagent-status", "observations"]);
    const lines = widget.render(100);
    assert.ok(lines.at(-1)?.includes("╯"), "do not add an extra blank row before observation progress");
    assert.ok(!lines.join("\n").includes("/subagents"));
    assert.ok(!lines.join("\n").includes("Ctrl+Alt+G"));
    assert.equal(h.widgets.get("observations"), observation);
  } finally { await h.shutdown(); }
});

it("removes finished agents from the widget, selector and session list",  async () => {
  const h = await setup();
  try {
    h.ctx.mode = "tui";
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    await h.execute("subagent", { agent: "scout", name: "two", task: "HOLD" });
    assert.ok(h.widgets.has("subagent-status"));
    await h.execute("subagent_message", { name: "one", message: "COMPLETE one" });
    await waitFor(() => h.results.some((r) => r.details?.name === "one"));
    const text = h.widgets.get("subagent-status")({ requestRender() {} }).render(100).join("\n");
    assert.ok(!text.includes("one (scout)"));
    assert.ok(text.includes("two (scout)"));
    await h.execute("subagent_message", { name: "two", message: "COMPLETE two" });
    await waitFor(() => h.results.some((r) => r.details?.name === "two"));
    assert.equal(h.widgets.has("subagent-status"), false);
    assert.equal((await h.execute("subagents_list", {})).details.sessions.length, 0);
    const saved = view(h, "one");
    await saved.done;
    assert.equal(saved.state.component, undefined, "retired agents cannot be opened");
    await assert.rejects(h.execute("subagent_message", { name: "one", message: "follow-up" }), /No live subagent/);
  } finally { await h.shutdown(); }
});
