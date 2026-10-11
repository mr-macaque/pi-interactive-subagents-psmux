import { rmSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSubagentConfigGuard, parseSubagentConfigJson, readSubagentConfigFile } from "./config.ts";
import { getSessionId, loadoutSidecarPath } from "./session.ts";

export interface CleanupConfig { deleteSessionFiles: boolean }
export function loadCleanupConfig(): CleanupConfig {
  const file = readSubagentConfigFile();
  if (!file) return { deleteSessionFiles: false };
  return parseCleanupConfig(parseSubagentConfigJson(file.rawConfig, file.sourcePath), file.sourcePath);
}
export function parseCleanupConfig(raw: unknown, source = "subagents.json"): CleanupConfig {
  const guard = createSubagentConfigGuard(source);
  const root = guard.requireObject(raw, "root");
  if (root.cleanup === undefined) return { deleteSessionFiles: false };
  const cleanup = guard.requireObject(root.cleanup, "cleanup");
  guard.rejectUnsupportedKeys(cleanup, ["deleteSessionFiles"], "cleanup");
  return { deleteSessionFiles: cleanup.deleteSessionFiles === undefined ? false : guard.requireBoolean(cleanup.deleteSessionFiles, "cleanup.deleteSessionFiles") };
}

/** Only a closed, owned child's exact session, sidecar and private artifacts. */
export function deleteChildFiles(sessionFile: string, parentSessionFile: string | undefined, parentSessionId: string, promptFiles: string[] = [], expectedSessionId?: string | null): void {
  const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  if (!parentSessionFile || samePath(sessionFile, parentSessionFile)) throw new Error("Refusing to delete the parent session.");
  const id = getSessionId(sessionFile);
  if (expectedSessionId !== undefined && id !== expectedSessionId) throw new Error("Refusing to purge a child whose session identity changed.");
  if (id && (process.platform === "win32" ? id.toLowerCase() === parentSessionId.toLowerCase() : id === parentSessionId)) throw new Error("Refusing to delete parent artifacts.");
  // Do not follow a session-file symlink to discover someone else's artifact ID.
  try { if (lstatSync(sessionFile).isSymbolicLink()) throw new Error("Refusing to purge a symlinked session."); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (id && /^[a-zA-Z0-9_-]+$/.test(id)) rmSync(join(dirname(sessionFile), "artifacts", id), { recursive: true, force: true });
  for (const path of promptFiles) rmSync(path, { force: true });
  rmSync(loadoutSidecarPath(sessionFile), { force: true });
  rmSync(sessionFile, { force: true });
}
