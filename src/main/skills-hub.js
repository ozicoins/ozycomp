'use strict';
/**
 * Skills hub — the reference's "skills & agent repos" surface, verbatim:
 *  - listLocalSkills(): scans every managed skills root —
 *      bundled resources/skills, ~/.claude/skills, ~/.codex/skills,
 *      ~/.agents/skills, ~/.config/opencode/plugin, enabled Claude plugins,
 *      plus registeredRepos' <cwd>/.claude/skills + <cwd>/.opencode/plugin —
 *    dedupes by provider:name with scope rank project > user > bundled and
 *    applies a Turkish name overlay from HarnessAgents/company/
 *    skill-catalog-tr.json when present.
 *  - loadCatalog(): fetches the community catalog README (24h TTL cache).
 *  - installSkill(): resolves a GitHub folder URL (or an officialskills.sh
 *    page that links one), walks it via the GitHub contents API under
 *    SKILL_INSTALL_LIMITS, stages then renames into ~/.claude/skills.
 *  - uninstallSkill(): removes only inside managed roots, never a bare dir.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const CATALOG_URL = 'https://raw.githubusercontent.com/abubakarsiddik31/claude-skills-collection/main/README.md';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const SKILL_INSTALL_LIMITS = { maxFiles: 250, maxTotalBytes: 16 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024, maxDepth: 5 };
const DOWNLOADS_AT_ONCE = 6;
const mb = bytes => (bytes / (1024 * 1024)).toFixed(1);

// ── http helpers (https only, redirect-following, byte-capped) ─────────────
function getBytes(url, opts = {}, hops = 0) {
  const timeoutMs = opts.timeoutMs ?? 12e3;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, body) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(body);
    };
    let target;
    try { target = new URL(url); } catch { finish(new Error(`not a URL: ${url}`)); return; }
    if (target.protocol !== 'https:') {
      finish(new Error(`refusing a fetch that is not https: ${target.protocol}//${target.host}`));
      return;
    }
    const req = https.request(target, { method: 'GET', headers: { 'user-agent': 'ozycomp' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) { finish(new Error(`too many redirects (${MAX_REDIRECTS})`)); return; }
        let nextUrl;
        try { nextUrl = new URL(res.headers.location, target).toString(); }
        catch { finish(new Error('redirect to something that is not a URL')); return; }
        getBytes(nextUrl, opts, hops + 1).then(b => finish(null, b), e => finish(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); finish(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      let seen = 0;
      res.on('data', c => {
        seen += c.length;
        if (opts.maxBytes !== undefined && seen > opts.maxBytes) {
          req.destroy(new Error('larger than expected'));
          finish(new Error('larger than expected'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', e => finish(e instanceof Error ? e : new Error(String(e))));
      res.on('aborted', () => finish(new Error('the connection closed before the whole body arrived')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on('error', e => finish(e instanceof Error ? e : new Error(String(e))));
    req.end();
  });
}
const getText = (url, opts) => getBytes(url, opts).then(b => b.toString('utf8'));
const getJson = url => getText(url).then(t => JSON.parse(t));

// ── frontmatter + directory scanners ───────────────────────────────────────
function parseSkillFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' ').trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function scanSkillDir(dir, provider, scope) {
  const out = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
    for (const entry of fs.readdirSync(dir)) {
      const skillDir = path.join(dir, entry);
      const md = path.join(skillDir, 'SKILL.md');
      try {
        if (!fs.statSync(skillDir).isDirectory() || !fs.existsSync(md)) continue;
        const fm = parseSkillFrontmatter(fs.readFileSync(md, 'utf8'));
        out.push({ id: `${scope}:${entry}`, name: fm.name || entry, description: fm.description || '', provider, scope, path: skillDir });
      } catch {}
    }
  } catch {}
  return out;
}

function scanPluginDir(dir, provider, scope) {
  const out = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      out.push({
        id: `${scope}:${provider}:${entry}`,
        name: entry.replace(/\.(m|c)?js$/i, ''),
        description: `Plugin in ${path.basename(path.dirname(dir))}/${path.basename(dir)}`,
        provider, scope, path: path.join(dir, entry),
      });
    }
  } catch {}
  return out;
}

function listLocalSkills(opts = {}) {
  const home = opts.home ?? os.homedir();
  const found = [
    ...opts.bundledDir ? scanSkillDir(opts.bundledDir, 'claude', 'bundled') : [],
    ...scanSkillDir(path.join(home, '.claude', 'skills'), 'claude', 'user'),
    ...scanPluginDir(path.join(home, '.config', 'opencode', 'plugin'), 'opencode', 'user'),
    ...scanSkillDir(path.join(home, '.codex', 'skills'), 'codex', 'user'),
    ...scanSkillDir(path.join(home, '.agents', 'skills'), 'claude', 'user'),
  ];
  // skills inside enabled, actually-installed Claude plugins
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const walk = (dir, pluginName, depth = 0) => {
      if (depth > 8 || !fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '__pycache__'].includes(item.name)) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file, pluginName, depth + 1);
        else if (item.name === 'SKILL.md') {
          const fm = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
          const parent = path.dirname(file);
          found.push({ id: `plugin:${pluginName}:${fm.name || path.basename(parent)}`, name: fm.name || path.basename(parent), description: fm.description || '', provider: 'claude', scope: 'user', path: parent, source: pluginName });
        }
      }
    };
    for (const [name, records] of Object.entries(installed.plugins ?? {})) {
      if (!settings.enabledPlugins?.[name]) continue;
      for (const record of records) if (record.scope === 'user' && record.installPath) walk(record.installPath, name);
    }
  } catch {}
  for (const cwd of opts.cwds ?? []) {
    if (!cwd) continue;
    found.push(...scanSkillDir(path.join(cwd, '.claude', 'skills'), 'claude', 'project'));
    found.push(...scanPluginDir(path.join(cwd, '.opencode', 'plugin'), 'opencode', 'project'));
  }
  const rank = { project: 3, user: 2, bundled: 1 };
  const best = new Map();
  for (const s of found) {
    const key = `${s.provider}:${s.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || rank[s.scope] > rank[prev.scope]) best.set(key, s);
  }
  let turkce = {};
  try {
    turkce = JSON.parse(fs.readFileSync(path.join(home, 'HarnessAgents', 'company', 'skill-catalog-tr.json'), 'utf8'));
  } catch {}
  return [...best.values()].map(s => {
    const translated = turkce[`${s.provider}:${s.name}`];
    return translated ? { ...s, canonicalName: s.name, name: translated.name, description: translated.description, source: translated.source } : s;
  }).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

// ── remote catalog ─────────────────────────────────────────────────────────
function parseCatalogMarkdown(md) {
  const out = [];
  let category = 'Skills';
  const seen = new Set();
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      category = h[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')
        .replace(/^[\p{Extended_Pictographic}︎\s]+/u, '').trim() || category;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 3) continue;
    if (/^-{3,}$/.test(cells[0].replace(/:/g, ''))) continue;
    const name = cells[0].replace(/[*`]/g, '').trim();
    const description = cells[1].replace(/[*`]/g, '').trim();
    const linkM = /\((https?:\/\/[^)]+)\)/.exec(cells[2]) || /(https?:\/\/\S+)/.exec(cells[2]);
    if (!name || !linkM) continue;
    const url = linkM[1].trim();
    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ghOwner = /^https:\/\/github\.com\/([^/]+)/i.exec(url);
    out.push({ name, description, url, category, owner: ghOwner ? ghOwner[1].toLowerCase() : 'other' });
  }
  return out;
}

async function loadCatalog(cachePath, opts = {}) {
  let cached = null;
  try { if (fs.existsSync(cachePath)) cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cached = null; }
  const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !opts.force) return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: false };
  try {
    const md = await getText(opts.url ?? CATALOG_URL);
    const skills = parseCatalogMarkdown(md);
    if (skills.length === 0 && cached)
      return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error: 'catalog format changed' };
    const payload = { skills, fetchedAt: Date.now() };
    try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
    return { ...payload, stale: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error };
    return { skills: [], fetchedAt: 0, stale: true, error };
  }
}

// ── install / uninstall ────────────────────────────────────────────────────
function parseGitHubSourceUrl(url) {
  const clean = url.trim().replace(/[#?].*$/, '').replace(/\/+$/, '');
  const tree = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/.exec(clean);
  if (tree) {
    const [, owner, repo, ref, p] = tree;
    if (!owner || !repo || !ref) return null;
    return { owner, repo, ref, path: p.replace(/\/+$/, '') };
  }
  const root = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(clean);
  if (root) {
    const [, owner, repo] = root;
    if (['orgs', 'topics', 'collections', 'sponsors', 'features'].includes(owner.toLowerCase())) return null;
    return { owner, repo: repo.replace(/\.git$/i, ''), ref: '', path: '' };
  }
  return null;
}

async function resolveSourceUrl(url) {
  if (parseGitHubSourceUrl(url)) return url;
  if (!/^https:\/\/(www\.)?officialskills\.sh\//i.test(url)) return null;
  try {
    const html = await getText(url);
    const m = /https:\/\/github\.com\/[^/"'\s]+\/[^/"'\s]+\/tree\/[^"'\s<>)]+/.exec(html);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
  } catch { return null; }
}

function safeSkillDirName(raw) {
  const base = raw.trim().split('/').pop() ?? '';
  if (!base || base === '.' || base === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base)) return null;
  if (base.includes('..')) return null;
  return base;
}

async function resolveRepoRootSkillDir(listDir, entryName) {
  let root;
  try { root = await listDir(''); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const hasSkillMd = listing => listing.some(it => it.type === 'file' && it.name === 'SKILL.md');
  if (hasSkillMd(root)) return { path: '' };
  const hasDir = n => root.some(it => it.type === 'dir' && it.name === n);
  const name = safeSkillDirName(entryName);
  const candidates = name ? [
    ...hasDir('skills') ? [`skills/${name}`] : [],
    ...hasDir('.claude') ? [`.claude/skills/${name}`] : [],
    ...hasDir(name) ? [name] : [],
  ] : [];
  for (const candidate of candidates) {
    try { if (hasSkillMd(await listDir(candidate))) return { path: candidate }; } catch {}
  }
  return { unsupported: true, error: "couldn't find the skill's SKILL.md in that repository — open Learn more to install it by hand" };
}

async function planSkillInstall(listDir, skillPath, limits = SKILL_INSTALL_LIMITS) {
  const files = [];
  let total = 0;
  const walk = async (p, depth) => {
    if (depth > limits.maxDepth)
      return { code: 'too-deep', detail: { levels: limits.maxDepth }, error: `the folder nests deeper than the ${limits.maxDepth} levels this installer will follow` };
    let listing;
    try { listing = await listDir(p); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    for (const it of listing) {
      if (it.type === 'dir') { const err = await walk(it.path, depth + 1); if (err) return err; continue; }
      if (it.type !== 'file' || !it.download_url) continue;
      if (files.length >= limits.maxFiles)
        return { code: 'too-many-files', detail: { files: limits.maxFiles }, error: `that skill has more than the ${limits.maxFiles} files this installer will fetch` };
      const size = it.size ?? 0;
      if (size > limits.maxFileBytes)
        return { code: 'file-too-large', detail: { name: it.name, fileMb: mb(size), mb: mb(limits.maxFileBytes) },
          error: `${it.name} is ${mb(size)} MB and this installer fetches files up to ${mb(limits.maxFileBytes)} MB` };
      total += size;
      if (total > limits.maxTotalBytes)
        return { code: 'too-large', detail: { mb: mb(limits.maxTotalBytes) }, error: `that skill is larger than the ${mb(limits.maxTotalBytes)} MB this installer will fetch` };
      const rel = skillPath ? it.path.slice(skillPath.length).replace(/^\/+/, '') : it.path;
      files.push({ path: rel, url: it.download_url, size });
    }
    return null;
  };
  const err = await walk(skillPath, 0);
  if (err) return err;
  return { files };
}

async function installSkill(entryUrl, entryName, deps = {}) {
  const source = await resolveSourceUrl(entryUrl);
  if (!source) return { ok: false, unsupported: true, error: 'No downloadable source — open Learn more to install it by hand.' };
  const gh = parseGitHubSourceUrl(source);
  if (!gh) return { ok: false, unsupported: true, error: 'Source is not a GitHub folder.' };
  const api = p => `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${p ? encodeURI(p) : ''}` + (gh.ref ? `?ref=${encodeURIComponent(gh.ref)}` : '');
  const listDir = deps.listDir ?? (async p => {
    const res = await getJson(api(p));
    return Array.isArray(res) ? res : [res];
  });
  const fetchBytes = deps.fetchBytes ?? getBytes;
  let skillPath = gh.path;
  if (!skillPath) {
    const resolved = await resolveRepoRootSkillDir(listDir, entryName);
    if ('error' in resolved) return { ok: false, error: resolved.error, unsupported: resolved.unsupported };
    skillPath = resolved.path;
  }
  const dirName = safeSkillDirName(skillPath || entryName);
  if (!dirName) return { ok: false, error: 'That skill has a name this app will not create a folder for.' };
  const root = deps.root ?? path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(root, dirName);
  if (fs.existsSync(dest)) return { ok: false, error: `Already installed at ${dest}` };
  const plan = await planSkillInstall(listDir, skillPath);
  if ('error' in plan) return { ok: false, error: plan.error, code: plan.code, detail: plan.detail };
  const files = plan.files;
  if (files.length === 0) return { ok: false, error: 'No files found at that source.' };
  const staging = path.join(root, '.installing', `${dirName}-${crypto.randomBytes(6).toString('hex')}`);
  const dropStaging = () => {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { fs.rmdirSync(path.join(root, '.installing')); } catch {}
  };
  try {
    const targets = files.map(f => {
      const target = path.resolve(staging, f.path);
      if (target !== staging && !target.startsWith(staging + path.sep))
        throw new Error(`refusing to write outside the skill folder: ${f.path}`);
      return target;
    });
    let next = 0;
    let arrived = 0;
    let failure = null;
    const worker = async () => {
      for (let i = next++; i < files.length && !failure; i = next++) {
        try {
          const body = await fetchBytes(files[i].url, { maxBytes: Math.max(files[i].size, SKILL_INSTALL_LIMITS.maxFileBytes) });
          if (failure) return;
          arrived += body.length;
          if (arrived > SKILL_INSTALL_LIMITS.maxTotalBytes) {
            failure = { code: 'too-large', detail: { mb: mb(SKILL_INSTALL_LIMITS.maxTotalBytes) },
              error: `that skill is larger than the ${mb(SKILL_INSTALL_LIMITS.maxTotalBytes)} MB this installer will fetch` };
            return;
          }
          fs.mkdirSync(path.dirname(targets[i]), { recursive: true });
          fs.writeFileSync(targets[i], body);
        } catch (e) {
          failure ??= { error: e instanceof Error ? e.message : String(e) };
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, files.length) }, worker));
    if (failure) { const f = failure; dropStaging(); return { ok: false, error: f.error, code: f.code, detail: f.detail }; }
    if (fs.existsSync(dest)) { dropStaging(); return { ok: false, error: `Already installed at ${dest}` }; }
    try {
      fs.renameSync(staging, dest);
    } catch (e) {
      dropStaging();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    dropStaging();   // only removes the .installing dir itself — staging was renamed away
    return { ok: true, path: dest, files: files.length };
  } catch (e) {
    dropStaging();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function uninstallSkill(skillPath, opts = {}) {
  if (typeof skillPath !== 'string' || !skillPath.trim()) return { ok: false, error: 'no path given' };
  let target;
  try { target = path.resolve(skillPath); } catch { return { ok: false, error: 'unreadable path' }; }
  const home = opts.home ?? os.homedir();
  const roots = [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.config', 'opencode', 'plugin'),
    path.join(home, '.codex', 'plugins'),
    ...(opts.cwds ?? []).filter(Boolean).flatMap(c => [
      path.join(c, '.claude', 'skills'),
      path.join(c, '.opencode', 'plugin'),
    ]),
  ].map(r => path.resolve(r));
  const root = roots.find(r => target.startsWith(r + path.sep));
  if (!root) return { ok: false, error: 'That folder is not inside a skills directory this app manages.' };
  if (target === root) return { ok: false, error: 'refusing to delete the skills directory itself' };
  if (!fs.existsSync(target)) return { ok: false, error: 'Already gone.' };
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      if (!fs.existsSync(path.join(target, 'SKILL.md')))
        return { ok: false, error: 'That folder has no SKILL.md — refusing to delete it.' };
    } else if (!st.isFile()) {
      return { ok: false, error: 'Not a file or folder this app will remove.' };
    }
  } catch { return { ok: false, error: 'could not inspect that path' }; }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** Paths the skills:reveal IPC may open in a file manager. */
function revealable(target, opts = {}) {
  const home = opts.home ?? os.homedir();
  const roots = [path.join(home, '.claude', 'skills'), path.join(home, '.config', 'opencode')];
  const t = path.resolve(target);
  return roots.some(r => t.startsWith(path.resolve(r) + path.sep))
    || (opts.registeredRepos ?? []).some(c => t.startsWith(path.resolve(c) + path.sep));
}

/** ExpandTilde — same helper the config layer uses for registeredRepos. */
function expandTilde(p) {
  const s = String(p ?? '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Normalize the registeredRepos patch: tilde-expand, dedupe, drop empties. */
function normalizeRegisteredRepos(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(expandTilde).filter(r => r && !seen.has(r) && (seen.add(r), true));
}

module.exports = {
  listLocalSkills, scanSkillDir, scanPluginDir, parseSkillFrontmatter,
  parseCatalogMarkdown, loadCatalog,
  installSkill, uninstallSkill, revealable,
  parseGitHubSourceUrl, resolveSourceUrl, resolveRepoRootSkillDir,
  planSkillInstall, safeSkillDirName,
  expandTilde, normalizeRegisteredRepos,
  getBytes, getText, getJson,
  CATALOG_URL, CATALOG_TTL_MS, SKILL_INSTALL_LIMITS, DOWNLOADS_AT_ONCE,
};
