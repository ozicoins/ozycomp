'use strict';
/**
 * git:* IPC surface — verbatim port of the reference block (index.js
 * ~35294-35391) plus every helper it calls (~5060-5400): runGit, getBranch,
 * getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff,
 * mainRepoRoot, getLogGraph, getCommitFiles, getFileAtRev, compareRefs,
 * listWorktrees, agentBranchFor, addWorktree, removeWorktree,
 * worktreeHasUnintegratedWork, worktreeIsGcSafe, worktreeWorkSummary,
 * isSafeRev, parseNameStatusZ, and the worktree-admin block (~35355-35391).
 *
 * safeResolve/openForRead are shared with the fs group (same file family in
 * the reference). worktreeAdminContext reaches the live-fleet maps the pty
 * group stashes on ctx (worktreePaths, worktreeBases, preservedWorktrees,
 * liveWorkers) — it degrades to empty sets until pty.js lands.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { safeResolve, openForRead } = require('./fs');
const { unlinkWorktreeDeps } = require('../worktree-deps');

function runGit(cwd, args, timeoutMs = 8e3) {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    const timer2 = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
      }
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer2);
      resolve({ ok: false, error: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer2);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
    });
  });
}
async function getBranch(cwd) {
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return { error: head.error };
  const name = head.stdout.trim();
  if (name === "HEAD") return { current: null, detached: true };
  return { current: name, detached: false };
}
async function getStatus(cwd) {
  const res = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!res.ok) return { error: res.error };
  const entries = [];
  const untracked = [];
  const tokens = res.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 3) continue;
    const index = token[0];
    const worktree = token[1];
    const path2 = token.slice(3);
    if (index === "?" && worktree === "?") {
      untracked.push(path2);
      continue;
    }
    const entry = { path: path2, index, worktree };
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
      const oldPath = tokens[i + 1];
      if (oldPath !== void 0) {
        entry.oldPath = oldPath;
        i += 1;
      }
    }
    entries.push(entry);
  }
  return {
    staged: entries.filter((e) => e.index !== " " && e.index !== "?"),
    unstaged: entries.filter((e) => e.worktree !== " " && e.worktree !== "?"),
    untracked
  };
}
async function getLog(cwd, n) {
  const sep = "";
  const fsep = "";
  const fmt = ["%H", "%P", "%s", "%an", "%at", "%D"].join(fsep) + sep;
  const res = await runGit(cwd, ["log", "--all", `--max-count=${n}`, `--pretty=format:${fmt}`]);
  if (!res.ok) return { error: res.error };
  const out = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parents.split(" ").filter(Boolean),
      subject: subject ?? "",
      author: author ?? "",
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? "").split(", ").map((s) => s.trim()).filter(Boolean)
    });
  }
  return out;
}
async function getBranches(cwd) {
  const res = await runGit(cwd, ["branch", "-a", "--format=%(HEAD) %(refname:short)"]);
  if (!res.ok) return { error: res.error };
  let current2 = null;
  const local = [];
  const remote = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const [head, name] = line.split(" ");
    if (!name) continue;
    if (head.trim() === "*") current2 = name;
    if (name.startsWith("remotes/")) remote.push(name.replace(/^remotes\//, ""));
    else local.push(name);
  }
  return { local, remote, current: current2 };
}
async function getAheadBehind(cwd) {
  const up = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok) return { ahead: 0, behind: 0, upstream: null };
  const upstream = up.stdout.trim();
  const ab = await runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (!ab.ok) return { error: ab.error };
  const [ahead, behind] = ab.stdout.trim().split("\t").map((n) => parseInt(n, 10) || 0);
  return { ahead, behind, upstream };
}
async function isRepo(cwd) {
  const res = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
async function getDiff(cwd, relPath) {
  const abs = await safeResolve(cwd, relPath);
  if (!abs) return { ok: false, error: "path escapes repository root" };
  let head = "";
  let headExists = false;
  const show = await runGit(cwd, ["show", `HEAD:${relPath}`]);
  if (show.ok) {
    head = show.stdout;
    headExists = true;
  }
  let working = "";
  let workingExists = false;
  let workingBinary = false;
  let fh;
  try {
    fh = await openForRead(abs);
    const s = await fh.stat();
    if (!s.isFile()) throw new Error("not a regular file");
    if (s.size > MAX_DIFF_BYTES) {
      return { ok: false, error: `file too large to diff (${(s.size / 1048576).toFixed(1)} MB)` };
    }
    const buf = await fh.readFile();
    workingExists = true;
    if (buf.includes(0)) workingBinary = true;
    else working = buf.toString("utf8");
  } catch {
    workingExists = false;
  } finally {
    await fh?.close().catch(() => {
    });
  }
  const isBinary = workingBinary || head.includes("\0");
  return {
    ok: true,
    path: abs,
    relPath,
    head: isBinary ? "" : head,
    working: isBinary ? "" : working,
    headExists,
    workingExists,
    isBinary
  };
}
async function mainRepoRoot(cwd) {
  const res = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!res.ok) return null;
  const gitDir = res.stdout.trim();
  if (!gitDir) return null;
  const stripped = gitDir.replace(/[\\/]\.git[\\/]?$/, "");
  return stripped || gitDir;
}
function agentBranchFor(wtPath) {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? "agent";
  const slug2 = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `agent/${slug2}`;
}
async function addWorktree(cwd, wtPath, baseBranch) {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ["worktree", "add", wtPath, "-b", branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  const fallback = await runGit(cwd, ["worktree", "add", wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}
async function removeWorktree(cwd, wtPath) {
  const deps2 = await unlinkWorktreeDeps(cwd, wtPath);
  if (!deps2.ok) return { ok: false, error: `dependency unlink failed: ${deps2.error}` };
  const res = await runGit(cwd, ["worktree", "remove", "--force", wtPath]);
  if (res.ok && !require('node:fs').existsSync(wtPath)) return { ok: true };
  if (res.ok) return { ok: false, error: "worktree directory still exists" };
  return { ok: false, error: res.error };
}
async function worktreeHasUnintegratedWork(wtPath, baseBranch) {
  const br = await getBranch(wtPath);
  const branch = "current" in br && br.current ? br.current : "(detached)";
  const status = await runGit(wtPath, ["status", "--porcelain"]);
  const dirty = status.ok ? status.stdout.trim().length > 0 : true;
  let ahead = 0;
  let aheadKnown = true;
  const rl = await runGit(wtPath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    ahead = Number.isFinite(n) ? n : 0;
  } else {
    aheadKnown = false;
  }
  const keep = dirty || ahead > 0 || !aheadKnown;
  const detail = `dirty=${dirty}, commitsAheadOf(${baseBranch})=${aheadKnown ? ahead : "unknown"}`;
  return { keep, detail, branch, dirty, dirtyKnown: status.ok, ahead };
}
async function worktreeIsGcSafe(wtPath, baseBranch) {
  const status = await runGit(wtPath, ["status", "--porcelain"]);
  if (!status.ok) return { gc: false, detail: "status query failed" };
  if (status.stdout.trim().length > 0) return { gc: false, detail: "working tree dirty" };
  const rl = await runGit(wtPath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
  if (rl.ok) {
    const n = parseInt(rl.stdout.trim(), 10);
    if (Number.isFinite(n) && n === 0) return { gc: true, detail: `clean + 0 commits ahead of ${baseBranch}` };
  }
  const diff = await runGit(wtPath, ["diff", "--quiet", baseBranch, "HEAD"]);
  if (diff.ok) return { gc: true, detail: `clean + tree identical to ${baseBranch} (integrated/squashed)` };
  return { gc: false, detail: `clean but content not yet in ${baseBranch}` };
}
async function worktreeWorkSummary(wtPath, baseBranch, ownLinks = []) {
  const br = await getBranch(wtPath);
  const branch = "current" in br && br.current ? br.current : null;
  const status = await runGit(wtPath, ["status", "--porcelain"]);
  const own = new Set(ownLinks.flatMap((n2) => [`?? ${n2}`, `?? ${n2}/`]));
  const uncommitted = status.ok ? status.stdout.split("\n").filter((l) => l.trim() && !own.has(l.trimEnd())).length : 0;
  let rl;
  if (baseBranch) {
    rl = await runGit(wtPath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
  } else {
    const refs = await runGit(wtPath, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
    if (!refs.ok) rl = refs;
    else {
      const others = refs.stdout.split("\n").map((r) => r.trim()).filter((r) => r && !/\s/.test(r) && r !== `refs/heads/${branch}`).map((r) => `^${r}`);
      rl = await runGit(wtPath, ["rev-list", "--count", "HEAD", ...others, "--"]);
    }
  }
  const n = rl.ok ? parseInt(rl.stdout.trim(), 10) : NaN;
  return { known: status.ok && Number.isFinite(n), uncommitted, unmerged: Number.isFinite(n) ? n : 0, branch };
}
function isSafeRev(rev) {
  return rev.length > 0 && rev.length <= 256 && !rev.startsWith("-") && /^[0-9A-Za-z._/^~@{}-]+$/.test(rev);
}
async function getLogGraph(cwd, n, skip = 0) {
  const sep = "";
  const fsep = "";
  const fmt = ["%H", "%P", "%s", "%an", "%at", "%D"].join(fsep) + sep;
  const res = await runGit(cwd, [
    "log",
    "--all",
    "--topo-order",
    `--max-count=${n}`,
    ...skip > 0 ? [`--skip=${skip}`] : [],
    `--pretty=format:${fmt}`
  ], 15e3);
  if (!res.ok) return { error: res.error };
  const out = [];
  for (const rec of res.stdout.split(sep)) {
    if (!rec.trim()) continue;
    const [sha, parents, subject, author, atime, refs] = rec.split(fsep);
    if (!sha) continue;
    out.push({
      sha: sha.trim(),
      shortSha: sha.trim().slice(0, 7),
      parents: (parents ?? "").split(" ").filter(Boolean),
      subject: subject ?? "",
      author: author ?? "",
      time: parseInt(atime, 10) || 0,
      refs: (refs ?? "").split(", ").map((s) => s.trim()).filter(Boolean)
    });
  }
  return out;
}
function parseNameStatusZ(stdout) {
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[i + 1];
      const path2 = tokens[i + 2];
      i += 2;
      if (path2) files.push({ path: path2, status: kind, oldPath });
    } else {
      const path2 = tokens[i + 1];
      i += 1;
      if (path2) files.push({ path: path2, status: kind });
    }
  }
  return files;
}
async function getCommitFiles(cwd, sha) {
  if (!isSafeRev(sha)) return { error: "invalid revision" };
  const res = await runGit(cwd, ["diff-tree", "--no-commit-id", "-r", "--root", "-z", "-M", "--name-status", sha, "--"]);
  if (!res.ok) return { error: res.error };
  return parseNameStatusZ(res.stdout);
}
const MAX_SHOW_BYTES = 2 * 1024 * 1024;
async function getFileAtRev(cwd, rev, relPath) {
  if (!isSafeRev(rev)) return { ok: false, error: "invalid revision" };
  if (!await safeResolve(cwd, relPath)) return { ok: false, error: "path escapes repository root" };
  const size = await runGit(cwd, ["cat-file", "-s", `${rev}:${relPath}`]);
  if (!size.ok) return { ok: true, exists: false, isBinary: false, content: "" };
  if ((parseInt(size.stdout.trim(), 10) || 0) > MAX_SHOW_BYTES) {
    return { ok: false, error: "file too large to diff (>2 MB)" };
  }
  const res = await runGit(cwd, ["show", `${rev}:${relPath}`]);
  if (!res.ok) return { ok: true, exists: false, isBinary: false, content: "" };
  if (res.stdout.includes("\0")) return { ok: true, exists: true, isBinary: true, content: "" };
  return { ok: true, exists: true, isBinary: false, content: res.stdout };
}
async function compareRefs(cwd, base, head, mode2) {
  if (!isSafeRev(base) || !isSafeRev(head)) return { error: "invalid revision" };
  const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", `${base}...${head}`]);
  if (!counts.ok) return { error: counts.error };
  const [behind, ahead] = counts.stdout.trim().split("\t").map((x) => parseInt(x, 10) || 0);
  const mb2 = await runGit(cwd, ["merge-base", base, head]);
  const mergeBase = mb2.ok ? mb2.stdout.trim() : null;
  const diffArgs = mode2 === "three" ? ["diff", "-z", "-M", "--name-status", `${base}...${head}`, "--"] : ["diff", "-z", "-M", "--name-status", base, head, "--"];
  const res = await runGit(cwd, diffArgs, 15e3);
  if (!res.ok) return { error: res.error };
  return { ahead, behind, mergeBase, files: parseNameStatusZ(res.stdout) };
}
async function listWorktrees(cwd) {
  const res = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return { error: res.error };
  const out = [];
  let cur = {};
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) out.push(cur);
      cur = { path: line.slice(9), head: "", branch: null };
    } else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  if (cur.path) out.push(cur);
  return out;
}

// worktree-admin block (~25133-25210 + 35355-35391) — the pty group's live
// maps arrive via ctx; empty until pty.js registers them.
async function worktreeWork(wtPath, ctx2) {
  if (!ctx2.roots.some((r) => wtPath === r || wtPath.startsWith(r + path.sep))) return null;
  const base = ctx2.baseFor(wtPath);
  const summary = await worktreeWorkSummary(wtPath, base);
  const live = ctx2.liveCwds.includes(wtPath);
  return { ...summary, live };
}
async function listOwnedWorktrees(ctx2) {
  const out = [];
  for (const root of ctx2.roots) {
    const res = await runGit(root, ["worktree", "list", "--porcelain"]);
    if (!res.ok) continue;
    for (const line of res.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice(9);
      if (ctx2.roots.some((r) => p !== r && p.startsWith(r + path.sep))) out.push(p);
    }
  }
  return out;
}
async function removeOwnedWorktree(wtPath, confirmed, ctx2) {
  const inRoot = ctx2.roots.some((r) => wtPath.startsWith(r + path.sep));
  if (!inRoot) return { ok: false, code: "outside" };
  if (ctx2.liveCwds.includes(wtPath)) return { ok: false, code: "live" };
  const base = ctx2.baseFor(wtPath);
  const summary = base ? await worktreeWorkSummary(wtPath, base) : { known: false, uncommitted: 0, unmerged: 0 };
  if ((summary.uncommitted > 0 || summary.unmerged > 0) && !confirmed) {
    return { ok: false, code: "dirty", summary };
  }
  const res = await runGit(path.dirname(wtPath), ["worktree", "remove", "--force", wtPath]);
  return res.ok ? { ok: true } : { ok: false, code: "git", error: res.error };
}
async function worktreeSize(wtPath, roots) {
  if (!roots.some((r) => wtPath.startsWith(r + path.sep))) return null;
  const res = await runGit(wtPath, ["count-objects", "-vH"]);
  if (!res.ok) return null;
  const size = res.stdout.split("\n").find((l) => l.startsWith("size-pack:"));
  return { wtPath, sizePack: size ? size.slice(11).trim() : null };
}

function register(ctx) {
  const ptyManager = ctx.harness?.pty;
  const worktreePaths = ctx.worktreePaths ??= new Map();
  const worktreeBases = ctx.worktreeBases ??= new Map();
  const preservedWorktrees = ctx.preservedWorktrees ??= new Map();
  const liveWorkers = ctx.liveWorkers ??= new Map();
  function worktreeAdminContext() {
    const roots = /* @__PURE__ */ new Set();
    const home = ctx.readConfig?.().harnessHome;
    if (home) roots.add(path.join(home, "worktrees"));
    for (const p of worktreePaths.values()) roots.add(path.dirname(p));
    for (const e of preservedWorktrees.values()) roots.add(path.dirname(e.wtPath));
    const bases = /* @__PURE__ */ new Map();
    for (const [id, p] of worktreePaths) {
      const b = worktreeBases.get(id) ?? liveWorkers.get(id)?.baseBranch;
      if (b) bases.set(p, b);
    }
    for (const e of preservedWorktrees.values()) bases.set(e.wtPath, e.baseBranch);
    return {
      roots: [...roots],
      liveCwds: [...(ptyManager?.list?.() ?? []).map((t) => t.cwd), ...worktreePaths.values()],
      baseFor: (p) => bases.get(p)
    };
  }
  const { ipcMain } = ctx;
  ipcMain.handle("git:isRepo", (_evt, cwd) => {
    if (typeof cwd !== "string") return false;
    return isRepo(cwd);
  });
  ipcMain.handle("git:mainRepo", (_evt, cwd) => {
    if (typeof cwd !== "string" || !cwd) return null;
    return mainRepoRoot(cwd);
  });
  ipcMain.handle("git:branch", (_evt, cwd) => {
    if (typeof cwd !== "string") return { error: "invalid cwd" };
    return getBranch(cwd);
  });
  ipcMain.handle("git:status", (_evt, cwd) => {
    if (typeof cwd !== "string") return { error: "invalid cwd" };
    return getStatus(cwd);
  });
  ipcMain.handle("git:log", (_evt, cwd, n) => {
    if (typeof cwd !== "string") return { error: "invalid cwd" };
    const count = typeof n === "number" ? Math.min(500, Math.max(1, n)) : 50;
    return getLog(cwd, count);
  });
  ipcMain.handle("git:branches", (_evt, cwd) => {
    if (typeof cwd !== "string") return { error: "invalid cwd" };
    return getBranches(cwd);
  });
  ipcMain.handle("git:aheadBehind", (_evt, cwd) => {
    if (typeof cwd !== "string") return { error: "invalid cwd" };
    return getAheadBehind(cwd);
  });
  ipcMain.handle("git:diff", (_evt, cwd, relPath) => {
    if (typeof cwd !== "string" || typeof relPath !== "string") {
      return { ok: false, error: "invalid args" };
    }
    return getDiff(cwd, relPath);
  });
  ipcMain.handle("git:logGraph", (_evt, cwd, n, skip) => {
    if (typeof cwd !== "string") return { error: "invalid args" };
    const count = Math.min(500, Math.max(1, typeof n === "number" ? n : 200));
    const off = Math.max(0, typeof skip === "number" ? skip : 0);
    return getLogGraph(cwd, count, off);
  });
  ipcMain.handle("git:commitFiles", (_evt, cwd, sha) => {
    if (typeof cwd !== "string" || typeof sha !== "string") return { error: "invalid args" };
    return getCommitFiles(cwd, sha);
  });
  ipcMain.handle("git:showFile", (_evt, cwd, rev, relPath) => {
    if (typeof cwd !== "string" || typeof rev !== "string" || typeof relPath !== "string") {
      return { ok: false, error: "invalid args" };
    }
    return getFileAtRev(cwd, rev, relPath);
  });
  ipcMain.handle("git:compareRefs", (_evt, cwd, base, head, mode2) => {
    if (typeof cwd !== "string" || typeof base !== "string" || typeof head !== "string") {
      return { error: "invalid args" };
    }
    return compareRefs(cwd, base, head, mode2 === "two" ? "two" : "three");
  });
  ipcMain.handle("git:worktrees", (_evt, cwd) => {
    if (typeof cwd !== "string") return { error: "invalid args" };
    return listWorktrees(cwd);
  });
  ipcMain.handle("worktrees:list", () => listOwnedWorktrees(worktreeAdminContext()));
  ipcMain.handle("worktrees:work", (_evt, wtPath) => {
    if (typeof wtPath !== "string") return null;
    return worktreeWork(wtPath, worktreeAdminContext());
  });
  ipcMain.handle("worktrees:size", (_evt, wtPath) => {
    if (typeof wtPath !== "string") return null;
    return worktreeSize(wtPath, worktreeAdminContext().roots);
  });
  ipcMain.handle("worktrees:remove", async (_evt, wtPath, confirmed) => {
    if (typeof wtPath !== "string") return { ok: false, code: "outside" };
    const res = await removeOwnedWorktree(wtPath, confirmed === true, worktreeAdminContext());
    if (res.ok) {
      preservedWorktrees.delete(wtPath);
      console.warn(`[worktree] removed by a person from the worktree list: ${wtPath}`);
    }
    return res;
  });
  ipcMain.handle("git:checkout", async (_evt, cwd, ref, detach) => {
    if (typeof cwd !== "string" || typeof ref !== "string" || !isSafeRev(ref)) {
      return { ok: false, error: "invalid args" };
    }
    const args = detach === true ? ["checkout", "--detach", ref] : ["checkout", ref];
    const res = await runGit(cwd, args, 15e3);
    if (!res.ok) return { ok: false, error: res.error };
    const branch = await getBranch(cwd);
    return { ok: true, ...branch };
  });
}

module.exports = { register, runGit, getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot, agentBranchFor, addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe, worktreeWorkSummary, isSafeRev, getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, parseNameStatusZ, worktreeWork, listOwnedWorktrees, removeOwnedWorktree, worktreeSize };
