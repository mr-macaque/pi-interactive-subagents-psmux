import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteChildFiles, parseCleanupConfig } from "../pi-extension/subagents/cleanup.ts";
import { registerName, unregisterName, readNameRegistry } from "../pi-extension/subagents/session.ts";

it("validates opt-in deletion without changing model/status settings", () => {
  assert.deepEqual(parseCleanupConfig({}), { deleteSessionFiles: false });
  assert.deepEqual(parseCleanupConfig({ cleanup: {} }), { deleteSessionFiles: false });
  assert.deepEqual(parseCleanupConfig({ status: { enabled: false }, models: {}, cleanup: { deleteSessionFiles: true } }), { deleteSessionFiles: true });
  assert.throws(() => parseCleanupConfig({ cleanup: { deleteSessionFiles: "yes" } }), /boolean/);
  assert.throws(() => parseCleanupConfig({ cleanup: { unknown: true } }), /unsupported/i);
  assert.throws(() => parseCleanupConfig({ cleanup: false }), /object/);
});

it("unregistering an old child cannot remove a reused name's new mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-retire-registry-"));
  try {
    registerName(dir, "worker", { sessionFile: "new.jsonl", sessionId: "new" });
    unregisterName(dir, "worker", "old.jsonl");
    assert.equal(readNameRegistry(dir).worker.sessionFile, "new.jsonl");
    unregisterName(dir, "worker", "new.jsonl");
    assert.deepEqual(Object.keys(readNameRegistry(dir)), []);
    unregisterName(dir, "worker", "new.jsonl");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("purges only the child session, sidecar, private artifacts and tracked prompt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-retire-files-"));
  try {
    const child = join(dir, "child.jsonl"), parent = join(dir, "parent.jsonl"), sibling = join(dir, "sibling.jsonl");
    for (const [path, id] of [[child, "child-id"], [parent, "parent-id"], [sibling, "sibling-id"]]) {
      writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n");
      writeFileSync(`${path}.loadout.json`, "{}");
      mkdirSync(join(dir, "artifacts", id), { recursive: true });
      writeFileSync(join(dir, "artifacts", id, "keep-or-delete"), "data");
    }
    const prompt = join(dir, "child-system.md");
    writeFileSync(prompt, "child profile");
    deleteChildFiles(child, parent, "parent-id", [prompt]);
    assert.equal(existsSync(child), false);
    assert.equal(existsSync(`${child}.loadout.json`), false);
    assert.equal(existsSync(join(dir, "artifacts", "child-id")), false);
    assert.equal(existsSync(prompt), false);
    for (const path of [parent, `${parent}.loadout.json`, sibling, `${sibling}.loadout.json`, join(dir, "artifacts", "parent-id"), join(dir, "artifacts", "sibling-id")]) assert.ok(existsSync(path), path);
    deleteChildFiles(child, parent, "parent-id", [prompt]);
    assert.throws(() => deleteChildFiles(parent, parent, "parent-id"), /parent session/);
    assert.throws(() => deleteChildFiles(sibling, parent, "sibling-id"), /parent artifacts/);
    assert.ok(existsSync(sibling));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
