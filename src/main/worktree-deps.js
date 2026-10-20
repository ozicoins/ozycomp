'use strict';
/**
 * Worktree dependency links — verbatim port of the reference. A temp's git
 * worktree shares the base checkout's node_modules via a symlink (junction on
 * Windows) so it doesn't reinstall the world; unlinkWorktreeDeps removes ONLY
 * a symlink that verifiably points back at the base's node_modules — never a
 * real directory the agent created itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const { promises } = fs;

async function linkWorktreeDeps(baseDir, worktreeDir) {
  const baseNodeModules = path.join(baseDir, "node_modules");
  const worktreeNodeModules = path.join(worktreeDir, "node_modules");
  if (!fs.existsSync(baseNodeModules)) return { ok: true, skipped: true };
  try {
    await promises.lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
  }
  try {
    await promises.symlink(baseNodeModules, worktreeNodeModules, process.platform === "win32" ? "junction" : null);
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
async function unlinkWorktreeDeps(baseDir, worktreeDir) {
  const baseNodeModules = path.join(baseDir, "node_modules");
  const worktreeNodeModules = path.join(worktreeDir, "node_modules");
  try {
    const stat = await promises.lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await promises.readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      promises.realpath(baseNodeModules),
      promises.realpath(path.resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await promises.unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : void 0;
    if (code === "ENOENT") return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}

module.exports = { linkWorktreeDeps, unlinkWorktreeDeps };
