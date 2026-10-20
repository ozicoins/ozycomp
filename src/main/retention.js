'use strict';
/**
 * Retention sweep — verbatim port of the reference's hourly hygiene pass
 * (out/main/index.js ~14776-15019, ~16742-17149).
 *
 * One module holds the whole subsystem: the RETENTION_POLICIES table and its
 * two planners (planTrim for byte/count-bound ledgers, planReap for
 * file-count+keep-daily folders), the filesystem reapers (reapFiles/reapDirs/
 * reapRosterBackups), the cost-ledger folder that keeps lifetime spend exact
 * across a trim (CostCarryFold + the carry lines it writes at the head of the
 * cut file), the three file trims (trimLedger with the append-catchup guard,
 * trimBoardArchive, capTasksArchive), and the scheduler (startRetention /
 * stopRetention / runRetention / verifyRoots).
 *
 * The task-ledger half of the hourly sweep (planSweep/applySweepPlan over
 * tasks.json + tasks-archive.json, the board-size ask) is verbatim too —
 * runTaskHygiene/startTaskHygiene/stopTaskHygiene. It lives here rather than
 * next to retention only because the reference also keeps the two timers side
 * by side, started from the same boot block.
 */
const node_fs = require('node:fs');
const path = require('node:path');

const FRESH_FLOOR_MS = 6e4;
const RETENTION_POLICIES = {
  costLedger: {
    id: "costLedger",
    label: "Cost ledger",
    kind: "bytes",
    max: 4 * 1024 * 1024,
    why: "costLifetime.ts folds at most 8 MB per pass, so a ledger kept under that always ends up behind the folder saved offset and it refolds from zero instead of reading shifted bytes; lifetime spend survives the trim exactly because the carry lines below preserve it, so the only thing this cap costs is per beat detail that nothing reads."
  },
  hiveLog: {
    id: "hiveLog",
    label: "Hive event log",
    kind: "bytes",
    max: 4 * 1024 * 1024,
    why: "logTail reads the WHOLE file synchronously and the heartbeat calls it on every beat, so the cap is what the main process can afford to re read on a timer rather than what a person might like to browse; 4 MB is roughly 25,000 events, about a week of a busy floor."
  },
  rosterBackups: {
    id: "rosterBackups",
    label: "Roster backups",
    kind: "count",
    max: 50,
    keepDailyDays: 30,
    minAgeMs: FRESH_FLOOR_MS,
    why: "A roster is restored either within minutes of a bad write or from the day something went missing, so keep every backup of the current session plus one per day for a month: at most 80 files instead of the thousands a busy day produces."
  },
  messageArchive: {
    id: "messageArchive",
    label: "Handled messages",
    kind: "count",
    max: 500,
    minAgeMs: FRESH_FLOOR_MS,
    why: "voiceMessages parses every file in inbox/.done and outbox/.sent on every Inbox open and then shows at most 200, so the cap is what main can afford to re read: 500 per folder per agent is more than the surface can ever display."
  },
  spawnRequests: {
    id: "spawnRequests",
    label: "Spawn requests",
    kind: "count",
    max: 200,
    minAgeMs: FRESH_FLOOR_MS,
    why: "Nothing reads a request after the worker starts; the folders exist only so a request is never processed twice, and 200 is enough for a person to see what was asked for recently."
  },
  tasksArchive: {
    id: "tasksArchive",
    label: "Archived cards",
    kind: "count",
    max: 1e3,
    why: "The Archived chip is a list a person scans, and 1000 cards is more than a year of a busy board; this is where the hourly hygiene sweep PUTS what it removes, so without a cap the bloat only moves."
  },
  boardArchive: {
    id: "boardArchive",
    label: "Board archive",
    kind: "bytes",
    max: 2 * 1024 * 1024,
    why: "Each entry is a whole copy of board.md, so this is counted in copies rather than cards: 2 MB is roughly 40 full boards, by which point the oldest copy has been superseded dozens of times."
  },
  memoryBackups: {
    id: "memoryBackups",
    label: "Memory backups",
    kind: "count",
    max: 50,
    minAgeMs: FRESH_FLOOR_MS,
    why: "A condense backup is read when a condense went wrong, which is noticed within a day or two; 50 stamps is every condense of the last week on a floor of ten agents that condense daily."
  },
  commandHistory: {
    id: "commandHistory",
    label: "Command history",
    kind: "count",
    max: 5e3,
    why: "listHistory clamps any request to 1000 rows, so 5000 is five times the deepest page the UI can ask for and still bounds the table at a few megabytes of SQLite."
  }
};
const COMMAND_HISTORY_LIMIT = RETENTION_POLICIES.commandHistory.max;

function planTrim(lines, policy) {
  const total = lines.reduce((n, l) => n + Math.max(0, l.bytes), 0);
  if (lines.length === 0) return { drop: 0, keep: 0, keepFromByte: 0, bytesDropped: 0, bytesKept: 0 };
  let keep;
  if (policy.kind === "count") {
    keep = Math.min(lines.length, Math.max(1, Math.floor(policy.max)));
  } else {
    let acc = 0;
    keep = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const b = Math.max(0, lines[i].bytes);
      if (keep > 0 && acc + b > policy.max) break;
      acc += b;
      keep++;
    }
  }
  const drop = lines.length - keep;
  let bytesDropped = 0;
  for (let i = 0; i < drop; i++) bytesDropped += Math.max(0, lines[i].bytes);
  return { drop, keep, keepFromByte: bytesDropped, bytesDropped, bytesKept: total - bytesDropped };
}
function dayKey(ms) {
  const d = new Date(ms);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mo}${day}`;
}
function planReap(files, policy, nowMs) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const max = Math.max(1, Math.floor(policy.max));
  const keep = [];
  const drop = [];
  const daysKept = new Set();
  const dailyBudget = Math.max(0, policy.keepDailyDays ?? 0);
  const minAge = Math.max(0, policy.minAgeMs ?? 0);
  let dailyUsed = 0;
  sorted.forEach((f, i) => {
    if (i < max) {
      keep.push(f.name);
      daysKept.add(dayKey(f.mtimeMs));
      return;
    }
    if (nowMs - f.mtimeMs < minAge) {
      keep.push(f.name);
      return;
    }
    if (dailyUsed < dailyBudget) {
      const k = dayKey(f.mtimeMs);
      if (!daysKept.has(k)) {
        daysKept.add(k);
        dailyUsed++;
        keep.push(f.name);
        return;
      }
    }
    drop.push(f.name);
  });
  if (files.length > 0 && keep.length === 0) return { keep: sorted.map((f) => f.name), drop: [] };
  return { keep, drop };
}

const CARRY_SESSION_ID = "retention_carry";
const EPS = 1e-9;
function costLedgerKeyOf(line) {
  const raw = line.trim();
  if (!raw) return null;
  let row;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!row || typeof row.agent_id !== "string" || !row.agent_id) return null;
  return `${row.agent_id}	${typeof row.session_id === "string" ? row.session_id : ""}`;
}
class CostCarryFold {
  seg = new Map();
  carried = new Map();
  /** Fold one raw line. Unparseable or shapeless lines are skipped, exactly as
   *  costLifetime.ts skips them, so a half written tail costs that line only. */
  add(line) {
    const raw = line.trim();
    if (!raw) return;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      return;
    }
    if (!row || typeof row.agent_id !== "string" || !row.agent_id) return;
    const agentId = row.agent_id;
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const usd = typeof row.usd === "number" && Number.isFinite(row.usd) ? row.usd : 0;
    if (sessionId === CARRY_SESSION_ID) {
      this.carried.set(agentId, (this.carried.get(agentId) ?? 0) + usd);
      return;
    }
    const key = `${agentId}	${sessionId}`;
    let s = this.seg.get(key);
    if (!s) {
      s = { committed: 0, peak: 0, lastLine: raw };
      this.seg.set(key, s);
    }
    s.lastLine = raw;
    if (usd < s.peak - EPS) {
      s.committed += s.peak;
      s.peak = usd;
    } else if (usd > s.peak) {
      s.peak = usd;
    }
  }
  /**
   * The lines to write at the head of the trimmed ledger.
   *
   * `keptKeys` is the set of keys that still have rows after the cut, from
   * costLedgerKeyOf. A key not in it ended in the dropped region, so its whole
   * value folds into the carry and it needs no line. Omitting the set is still
   * exact, it just leaves a line for every key instead of only the straddling
   * ones, which is the right fallback for a caller that cannot see the tail.
   */
  finish(nowMs, keptKeys) {
    const totals = new Map(this.carried);
    const survivors = [];
    for (const [key, s] of this.seg) {
      const agentId = key.slice(0, key.indexOf("	"));
      const straddles = keptKeys ? keptKeys.has(key) : true;
      const carried = straddles ? s.committed : s.committed + s.peak;
      if (carried > 0) totals.set(agentId, (totals.get(agentId) ?? 0) + carried);
      if (straddles) survivors.push(s.lastLine);
    }
    const carry = [];
    for (const [agentId, usd] of totals) {
      if (!(usd > 0)) continue;
      carry.push(JSON.stringify({
        agent_id: agentId,
        session_id: CARRY_SESSION_ID,
        ts: nowMs,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        model: CARRY_SESSION_ID,
        usd
      }));
    }
    return { carry, survivors };
  }
}
function formatBytes(bytes) {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}
function retentionLine(o) {
  if (o.refused) return `${o.label}: skipped, ${o.refused}.`;
  if (!o.removed && !o.freedBytes) return `${o.label}: already inside its limit.`;
  if (!o.removed) return `${o.label}: freed ${formatBytes(o.freedBytes)}.`;
  return `${o.label}: removed ${o.removed.toLocaleString("en-US")}, freed ${formatBytes(o.freedBytes)}.`;
}
function retentionSummary(outcomes) {
  const worked = outcomes.filter((o) => !o.refused && (o.removed > 0 || o.freedBytes > 0));
  if (worked.length === 0) return "Every store on disk is already inside its limit.";
  const freed = worked.reduce((n, o) => n + o.freedBytes, 0);
  const stores = worked.length === 1 ? "1 store" : `${worked.length} stores`;
  return `Trimmed ${stores} and freed ${formatBytes(freed)}.`;
}

const RETENTION_INTERVAL_MS = 36e5;
const RETENTION_FIRST_DELAY_MS = 9e4;
const MAX_CATCHUP_BYTES = 16 * 1024 * 1024;
const ROSTER_BACKUP = /^roster-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-(?:write|run-start|declined|reset)\.json$/;
const MESSAGE_FILE = /^(?:bad-)?[A-Za-z0-9][A-Za-z0-9_-]*\.json$/;
const SPAWN_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/;
const MEMORY_BACKUP_STAMP = /^\d{8}T\d{6}Z$/;
const AGENT_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NOTHING = { removed: 0, freedBytes: 0 };
function withinRoot(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}
function isPlainDir(p) {
  try {
    return node_fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}
function plainFileStat(p) {
  try {
    const s = node_fs.lstatSync(p);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}
function dirSize(p, depth = 0) {
  if (depth > 8) return 0;
  let total = 0;
  let names;
  try {
    names = node_fs.readdirSync(p);
  } catch {
    return 0;
  }
  for (const name of names) {
    const child = path.join(p, name);
    let s;
    try {
      s = node_fs.lstatSync(child);
    } catch {
      continue;
    }
    if (s.isFile()) total += s.size;
    else if (s.isDirectory()) total += dirSize(child, depth + 1);
  }
  return total;
}
function reapFiles(root, dirPath, pattern, policy, now) {
  if (!root) return { ...NOTHING, refused: "no root configured" };
  if (!withinRoot(root, dirPath)) return { ...NOTHING, refused: "the folder is outside its root" };
  if (!node_fs.existsSync(dirPath)) return NOTHING;
  if (!isPlainDir(dirPath)) return { ...NOTHING, refused: "the folder is not a plain directory" };
  let names;
  try {
    names = node_fs.readdirSync(dirPath);
  } catch {
    return { ...NOTHING, refused: "the folder could not be read" };
  }
  const candidates = [];
  for (const name of names) {
    if (path.basename(name) !== name || !pattern.test(name)) continue;
    const st = plainFileStat(path.join(dirPath, name));
    if (!st) continue;
    candidates.push({ name, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (candidates.length === 0) return NOTHING;
  const sizes = new Map(candidates.map((c) => [c.name, c.size]));
  const plan = planReap(candidates, policy, now);
  let removed = 0;
  let freedBytes = 0;
  for (const name of plan.drop) {
    if (path.basename(name) !== name || !pattern.test(name)) continue;
    const p = path.join(dirPath, name);
    if (!withinRoot(root, p)) continue;
    if (!plainFileStat(p)) continue;
    try {
      node_fs.unlinkSync(p);
      removed++;
      freedBytes += sizes.get(name) ?? 0;
    } catch {
    }
  }
  return { removed, freedBytes };
}
function reapDirs(root, dirPath, pattern, policy, now) {
  if (!root) return { ...NOTHING, refused: "no root configured" };
  if (!withinRoot(root, dirPath)) return { ...NOTHING, refused: "the folder is outside its root" };
  if (!node_fs.existsSync(dirPath)) return NOTHING;
  if (!isPlainDir(dirPath)) return { ...NOTHING, refused: "the folder is not a plain directory" };
  let names;
  try {
    names = node_fs.readdirSync(dirPath);
  } catch {
    return { ...NOTHING, refused: "the folder could not be read" };
  }
  const candidates = [];
  for (const name of names) {
    if (path.basename(name) !== name || !pattern.test(name)) continue;
    const p = path.join(dirPath, name);
    if (!isPlainDir(p)) continue;
    try {
      candidates.push({ name, mtimeMs: node_fs.lstatSync(p).mtimeMs });
    } catch {
    }
  }
  if (candidates.length === 0) return NOTHING;
  const plan = planReap(candidates, policy, now);
  let removed = 0;
  let freedBytes = 0;
  for (const name of plan.drop) {
    if (path.basename(name) !== name || !pattern.test(name)) continue;
    const p = path.join(dirPath, name);
    if (!withinRoot(root, p) || !isPlainDir(p)) continue;
    const size = dirSize(p);
    try {
      node_fs.rmSync(p, { recursive: true, force: true });
      removed++;
      freedBytes += size;
    } catch {
    }
  }
  return { removed, freedBytes };
}
function reapRosterBackups(home, now = Date.now()) {
  if (!home || !isPlainDir(home)) return { ...NOTHING, refused: "no harness home" };
  return reapFiles(home, path.join(home, "roster-backups"), ROSTER_BACKUP, RETENTION_POLICIES.rosterBackups, now);
}
async function eachLine(path2, start, endExclusive, skipFirstPartial, onLine) {
  if (endExclusive <= start) return;
  await new Promise((done, fail) => {
    const stream = node_fs.createReadStream(path2, { start, end: endExclusive - 1 });
    let tail = Buffer.alloc(0);
    let skipping = skipFirstPartial;
    let pos = start;
    stream.on("data", (chunk) => {
      const raw = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const buf = tail.length ? Buffer.concat([tail, raw]) : raw;
      let i = 0;
      for (; ; ) {
        const nl = buf.indexOf(10, i);
        if (nl === -1) break;
        const bytes = nl - i + 1;
        if (skipping) skipping = false;
        else onLine(buf.subarray(i, nl).toString("utf8"), bytes, pos);
        pos += bytes;
        i = nl + 1;
      }
      tail = Buffer.from(buf.subarray(i));
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (tail.length && !skipping) onLine(tail.toString("utf8"), tail.length, pos);
      done();
    });
  });
}
async function appendRange(src, from, to, dest) {
  if (to <= from) return;
  await new Promise((done, fail) => {
    const read = node_fs.createReadStream(src, { start: from, end: to - 1 });
    const write = node_fs.createWriteStream(dest, { flags: "a" });
    read.on("error", fail);
    write.on("error", fail);
    write.on("close", () => done());
    read.pipe(write);
  });
}
function readRangeSync(path2, from, to) {
  const len = Math.max(0, to - from);
  const buf = Buffer.alloc(len);
  if (len === 0) return buf;
  const fd = node_fs.openSync(path2, "r");
  try {
    node_fs.readSync(fd, buf, 0, len, from);
  } finally {
    node_fs.closeSync(fd);
  }
}
async function trimLedger(root, path2, policy, opts = {}) {
  if (!root) return { ...NOTHING, refused: "no root configured" };
  if (!withinRoot(root, path2)) return { ...NOTHING, refused: "the file is outside its root" };
  if (!node_fs.existsSync(path2)) return NOTHING;
  const first = plainFileStat(path2);
  if (!first) return { ...NOTHING, refused: "not a plain file" };
  const size = first.size;
  if (size <= policy.max) return NOTHING;
  const scanFrom = Math.max(0, size - policy.max * 2);
  const lines = [];
  let firstScanned = size;
  await eachLine(path2, scanFrom, size, scanFrom > 0, (_t, bytes, offset) => {
    if (lines.length === 0) firstScanned = offset;
    lines.push({ bytes });
  });
  if (lines.length === 0) return { ...NOTHING, refused: "no line boundary found" };
  const plan = planTrim(lines, policy);
  const keepFrom = firstScanned + plan.bytesDropped;
  if (keepFrom <= 0) return NOTHING;
  let head = "";
  if (opts.carry) {
    const keptKeys = new Set();
    await eachLine(path2, keepFrom, size, false, (text) => {
      const k = costLedgerKeyOf(text);
      if (k) keptKeys.add(k);
    });
    const fold = new CostCarryFold();
    await eachLine(path2, 0, keepFrom, false, (text) => fold.add(text));
    const carried = fold.finish(opts.now ?? Date.now(), keptKeys);
    const all = [...carried.carry, ...carried.survivors];
    head = all.length ? `${all.join("\n")}
` : "";
  }
  const tmp = `${path2}.retention-tmp`;
  try {
    node_fs.writeFileSync(tmp, head, "utf8");
    await appendRange(path2, keepFrom, size, tmp);
    const after = node_fs.statSync(path2);
    if (after.size < size) throw new Error("the ledger shrank underneath the trim");
    if (after.size - size > MAX_CATCHUP_BYTES) throw new Error("too much was appended during the trim");
    if (after.size > size) node_fs.appendFileSync(tmp, readRangeSync(path2, size, after.size));
    node_fs.renameSync(tmp, path2);
    try {
      node_fs.utimesSync(path2, after.atime, after.mtime);
    } catch {
    }
  } catch (e) {
    try {
      node_fs.unlinkSync(tmp);
    } catch {
    }
    return { ...NOTHING, refused: e instanceof Error ? e.message : String(e) };
  }
  return { removed: 0, freedBytes: Math.max(0, keepFrom - Buffer.byteLength(head, "utf8")) };
}
async function trimBoardArchive(root, path2, policy) {
  if (!root) return { ...NOTHING, refused: "no root configured" };
  if (!withinRoot(root, path2)) return { ...NOTHING, refused: "the file is outside its root" };
  if (!node_fs.existsSync(path2)) return NOTHING;
  const first = plainFileStat(path2);
  if (!first) return { ...NOTHING, refused: "not a plain file" };
  const size = first.size;
  if (size <= policy.max) return NOTHING;
  const probe = readRangeSync(path2, 0, Math.min(size, 8192)).toString("utf8");
  const headerEnd = probe.startsWith("## Archived ") ? 0 : probe.indexOf("\n## Archived ") >= 0 ? probe.indexOf("\n## Archived ") + 1 : -1;
  if (headerEnd < 0) return { ...NOTHING, refused: "no entry heading in the header" };
  let keepFrom = -1;
  await eachLine(path2, Math.max(0, size - policy.max), size, size > policy.max, (text, _b, offset) => {
    if (keepFrom < 0 && text.startsWith("## Archived ")) keepFrom = offset;
  });
  if (keepFrom <= headerEnd) return NOTHING;
  const tmp = `${path2}.retention-tmp`;
  const note = "Older copies past this file size cap were removed by the retention sweep.\n";
  try {
    const header = readRangeSync(path2, 0, headerEnd).toString("utf8");
    node_fs.writeFileSync(tmp, header.includes(note) ? header : `${header}${note}
`, "utf8");
    await appendRange(path2, keepFrom, size, tmp);
    const after = node_fs.statSync(path2);
    if (after.size < size) throw new Error("the archive shrank underneath the trim");
    if (after.size - size > MAX_CATCHUP_BYTES) throw new Error("too much was appended during the trim");
    if (after.size > size) node_fs.appendFileSync(tmp, readRangeSync(path2, size, after.size));
    node_fs.renameSync(tmp, path2);
  } catch (e) {
    try {
      node_fs.unlinkSync(tmp);
    } catch {
    }
    return { ...NOTHING, refused: e instanceof Error ? e.message : String(e) };
  }
  return { removed: 0, freedBytes: Math.max(0, keepFrom - headerEnd) };
}
function capTasksArchive(root, path2, policy) {
  if (!root) return { ...NOTHING, refused: "no root configured" };
  if (!withinRoot(root, path2)) return { ...NOTHING, refused: "the file is outside its root" };
  if (!node_fs.existsSync(path2)) return NOTHING;
  const st = plainFileStat(path2);
  if (!st) return { ...NOTHING, refused: "not a plain file" };
  let doc;
  try {
    doc = JSON.parse(node_fs.readFileSync(path2, "utf8"));
  } catch {
    return { ...NOTHING, refused: "the archive could not be parsed" };
  }
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : null;
  if (!tasks || tasks.length <= policy.max) return NOTHING;
  const next = { ...doc, tasks: tasks.slice(0, policy.max) };
  const tmp = `${path2}.retention-tmp`;
  try {
    node_fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    node_fs.renameSync(tmp, path2);
  } catch (e) {
    try {
      node_fs.unlinkSync(tmp);
    } catch {
    }
    return { ...NOTHING, refused: e instanceof Error ? e.message : String(e) };
  }
  const freed = Math.max(0, st.size - node_fs.statSync(path2).size);
  return { removed: tasks.length - policy.max, freedBytes: freed };
}
function verifyRoots(roots) {
  const home = roots.harnessHome;
  const hive2 = roots.hiveRoot;
  if (!home || !hive2) return null;
  if (path.basename(hive2) !== "hive" || !withinRoot(home, hive2)) return null;
  if (!isPlainDir(home) || !isPlainDir(hive2)) return null;
  return { hive: hive2, home };
}
async function runRetention(roots, now = Date.now()) {
  const ok = verifyRoots(roots);
  const out = [];
  const add = (policy, s) => {
    out.push({ id: policy.id, label: policy.label, removed: s.removed, freedBytes: s.freedBytes, refused: s.refused });
  };
  if (!ok) {
    return [{
      id: "roots",
      label: "Retention",
      removed: 0,
      freedBytes: 0,
      refused: "the harness home and its hive folder could not be verified"
    }];
  }
  const { hive: hive2, home } = ok;
  const P = RETENTION_POLICIES;
  add(P.costLedger, await safely(() => trimLedger(hive2, path.join(hive2, "cost-ledger.jsonl"), P.costLedger, { carry: true, now })));
  add(P.hiveLog, await safely(() => trimLedger(hive2, path.join(hive2, "log.jsonl"), P.hiveLog)));
  add(P.rosterBackups, sync(() => reapRosterBackups(home, now)));
  const archive = { removed: 0, freedBytes: 0 };
  const agentsDir = path.join(hive2, "agents");
  if (isPlainDir(agentsDir)) {
    let ids = [];
    try {
      ids = node_fs.readdirSync(agentsDir);
    } catch {
      ids = [];
    }
    for (const id of ids) {
      if (path.basename(id) !== id || !AGENT_DIR.test(id)) continue;
      if (!isPlainDir(path.join(agentsDir, id))) continue;
      for (const rel of [["inbox", ".done"], ["outbox", ".sent"]]) {
        const r = sync(() => reapFiles(hive2, path.join(agentsDir, id, rel[0], rel[1]), MESSAGE_FILE, P.messageArchive, now));
        archive.removed += r.removed;
        archive.freedBytes += r.freedBytes;
      }
    }
  }
  add(P.messageArchive, archive);
  const spawn = { removed: 0, freedBytes: 0 };
  for (const sub of [".done", ".failed"]) {
    const r = sync(() => reapFiles(hive2, path.join(hive2, "spawn-requests", sub), SPAWN_FILE, P.spawnRequests, now));
    spawn.removed += r.removed;
    spawn.freedBytes += r.freedBytes;
  }
  add(P.spawnRequests, spawn);
  add(P.tasksArchive, sync(() => capTasksArchive(hive2, path.join(hive2, "tasks-archive.json"), P.tasksArchive)));
  add(P.boardArchive, await safely(() => trimBoardArchive(hive2, path.join(hive2, "board-archive.md"), P.boardArchive)));
  add(P.memoryBackups, sync(() => reapDirs(hive2, path.join(hive2, "backups"), MEMORY_BACKUP_STAMP, P.memoryBackups, now)));
  return out;
}
function sync(f) {
  try {
    return f();
  } catch (e) {
    return { ...NOTHING, refused: e instanceof Error ? e.message : String(e) };
  }
}
async function safely(f) {
  try {
    return await f();
  } catch (e) {
    return { ...NOTHING, refused: e instanceof Error ? e.message : String(e) };
  }
}
let timer = null;
let firstRun = null;
let running = false;
function startRetention(getRoots, intervalMs = RETENTION_INTERVAL_MS, firstDelayMs = RETENTION_FIRST_DELAY_MS) {
  stopRetention();
  const tick = () => {
    if (running) return;
    running = true;
    void runRetention(getRoots()).then((outcomes) => {
      const worked = outcomes.filter((o) => !o.refused && (o.removed > 0 || o.freedBytes > 0));
      if (worked.length) console.log("[retention]", retentionSummary(outcomes), worked.map(retentionLine).join(" "));
      const refused = outcomes.filter((o) => o.refused);
      if (refused.length) console.warn("[retention]", refused.map(retentionLine).join(" "));
    }).catch((e) => console.error("[retention]", e)).finally(() => {
      running = false;
    });
  };
  firstRun = setTimeout(tick, firstDelayMs);
  timer = setInterval(tick, intervalMs);
}
function stopRetention() {
  if (firstRun) {
    clearTimeout(firstRun);
    firstRun = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ─── task hygiene (verbatim ~16525-16741) ──────────────────────────────────
// The other half of the hourly sweep: the kanban card side. resolveTaskHygiene
// clamps the config's five knobs; planSweep decides per card (archive / stamp
// doneAt / flag stale / nag an open human ask); applySweepPlan is the pure
// move between tasks.json and tasks-archive.json; runTaskHygiene is the pass,
// including the one-shot "condense board.md" ask over its token cap.
const TASK_HYGIENE_KEYS = [
  "doneArchiveDays",
  "staleFlagDays",
  "staleArchiveDays",
  "askNagDays",
  "boardTokenCap"
];
const TASK_HYGIENE_DEFAULTS = Object.freeze({
  doneArchiveDays: 2,
  staleFlagDays: 14,
  staleArchiveDays: 21,
  askNagDays: 7,
  boardTokenCap: 5e4
});
const DAY_MS = 864e5;
function resolveTaskHygiene(partial) {
  const out = { ...TASK_HYGIENE_DEFAULTS };
  if (!partial || typeof partial !== "object") return out;
  for (const key of TASK_HYGIENE_KEYS) {
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}
function isHygieneCard(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function cardId(card) {
  return typeof card.id === "string" && card.id ? card.id : null;
}
function toMs(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function asks(card) {
  if (!Array.isArray(card.humanQA)) return [];
  return card.humanQA.filter((e) => !!e && typeof e === "object" && typeof e.q === "string");
}
function openAsk(card) {
  const list = asks(card);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e.a && !e.dismissedAt) return e;
  }
  return null;
}
function lastTouchedAt(card) {
  const stamps = [
    toMs(card.createdAt),
    toMs(card.created_at),
    toMs(card.updatedAt),
    toMs(card.updated_at),
    toMs(card.completedAt),
    toMs(card.doneAt)
  ];
  for (const e of asks(card)) stamps.push(toMs(e.askedAt), toMs(e.answeredAt), toMs(e.dismissedAt));
  const known = stamps.filter((t) => t !== null);
  return known.length ? Math.max(...known) : null;
}
function doneAt(card) {
  return toMs(card.doneAt) ?? toMs(card.completedAt);
}
function ageDays(sinceMs, now) {
  return Math.max(0, Math.floor((now - sinceMs) / DAY_MS));
}
function isLive(card) {
  return card.status === "todo" || card.status === "blocked";
}
function staleDays(card, cfg, now) {
  if (!isLive(card) || openAsk(card)) return null;
  const touched = lastTouchedAt(card);
  if (touched === null) return null;
  return now - touched >= cfg.staleFlagDays * DAY_MS ? ageDays(touched, now) : null;
}
function isStale(card, cfg, now) {
  return staleDays(card, cfg, now) !== null;
}
function askNagDays(card, cfg, now) {
  const ask = openAsk(card);
  if (!ask) return null;
  const at = toMs(ask.askedAt);
  if (at === null) return null;
  return now - at >= cfg.askNagDays * DAY_MS ? ageDays(at, now) : null;
}
function archiveReasonFor(card, cfg, now) {
  if (card.status === "done") {
    const at = doneAt(card);
    return at !== null && now - at >= cfg.doneArchiveDays * DAY_MS ? "done" : null;
  }
  if (!isLive(card) || openAsk(card)) return null;
  const touched = lastTouchedAt(card);
  return touched !== null && now - touched >= cfg.staleArchiveDays * DAY_MS ? "stale" : null;
}
function archiveNote(reason, days) {
  return reason === "done" ? `Done for ${days} day${days === 1 ? "" : "s"}, archived by the hourly sweep.` : `Untouched for ${days} day${days === 1 ? "" : "s"}, archived by the hourly sweep.`;
}
function planSweep(cards, cfg, now) {
  const plan = { archive: [], stampDone: [], stale: [], nags: [] };
  for (const card of cards) {
    const id = cardId(card);
    if (!id) continue;
    const reason = archiveReasonFor(card, cfg, now);
    if (reason) {
      const since = reason === "done" ? doneAt(card) : lastTouchedAt(card);
      plan.archive.push({ id, reason, note: archiveNote(reason, ageDays(since, now)) });
      continue;
    }
    if (card.status === "done" && doneAt(card) === null) plan.stampDone.push(id);
    if (isStale(card, cfg, now)) plan.stale.push(id);
    const nag = askNagDays(card, cfg, now);
    if (nag !== null) plan.nags.push({ id, days: nag });
  }
  return plan;
}
function applySweepPlan(live, archive, plan, nowIso) {
  const reasons = new Map(plan.archive.map((a) => [a.id, a]));
  const stamps = new Set(plan.stampDone);
  const keep = [];
  const moved = [];
  let stamped = 0;
  for (const card of live) {
    const id = isHygieneCard(card) ? cardId(card) : null;
    const due = id ? reasons.get(id) : void 0;
    if (due) {
      moved.push({ ...card, archivedAt: nowIso, archiveReason: due.reason, archiveNote: due.note });
      continue;
    }
    if (id && stamps.has(id)) {
      keep.push({ ...card, doneAt: nowIso });
      stamped++;
      continue;
    }
    keep.push(card);
  }
  const movedIds = new Set(moved.map((c) => cardId(c)));
  const rest = archive.filter((c) => !(isHygieneCard(c) && movedIds.has(cardId(c))));
  return { live: keep, archive: [...moved, ...rest], archived: moved.length, stamped };
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function boardDecision(text, cfg, state) {
  const tokens = estimateTokens(text);
  const over = tokens > cfg.boardTokenCap;
  return { tokens, over, ask: over && !state.asked, next: { asked: over } };
}
function boardArchiveEntry(text, now, tokens) {
  const when = new Date(now).toISOString();
  return `

## Archived ${when} (about ${tokens} tokens)

${text.trim()}
`;
}
function boardAskMessage(tokens, cap, archivePath) {
  return {
    subject: `Board over its size cap: condense board.md (about ${tokens} tokens, cap ${cap})`,
    body: [
      `The shared board is about ${tokens} tokens against a cap of ${cap}. Every agent reads it on wake, so its size is paid on every session.`,
      `Its full text as it stands right now was appended to ${archivePath} under a dated heading, so nothing is lost whatever you do next.`,
      "Please condense the history in board.md: fold finished threads into short summaries, drop superseded plans, and keep the Decisions section verbatim.",
      "This is sent once per crossing. It will not repeat until the board is back under the cap and grows past it again."
    ].join("\n")
  };
}
const TASK_HYGIENE_INTERVAL_MS = 36e5;
let hygieneTimer = null;
function runTaskHygiene(hive, deps, now = Date.now()) {
  const out = { archived: 0, stamped: 0, boardTokens: 0, boardAsked: false };
  if (!hive.enabled()) return out;
  const cfg = resolveTaskHygiene(deps.readConfig().taskHygiene);
  const ledger = hive.tasks();
  const raw = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  const cards = raw.filter(isHygieneCard);
  const plan = planSweep(cards, cfg, now);
  if (plan.archive.length || plan.stampDone.length) {
    const r = hive.applyTaskHygiene(raw, (archive) => applySweepPlan(raw, archive, plan, new Date(now).toISOString()));
    out.archived = r.archived;
    out.stamped = r.stamped;
  }
  const text = hive.board();
  const state = hive.hygieneState();
  const d = boardDecision(text, cfg, { asked: state.boardAskedAt !== null });
  out.boardTokens = d.tokens;
  if (d.ask) {
    const archivePath = hive.appendBoardArchive(boardArchiveEntry(text, now, d.tokens));
    const msg = boardAskMessage(d.tokens, cfg.boardTokenCap, archivePath);
    hive.send({ to: "god", act: "request", subject: msg.subject, body: msg.body }, "system");
    out.boardAsked = true;
  }
  if (d.next.asked !== (state.boardAskedAt !== null)) {
    hive.setHygieneState({ ...state, boardAskedAt: d.next.asked ? now : null });
  }
  return out;
}
function startTaskHygiene(hive, deps, intervalMs = TASK_HYGIENE_INTERVAL_MS) {
  stopTaskHygiene();
  const tick = () => {
    try {
      const r = runTaskHygiene(hive, deps);
      if (r.archived || r.stamped || r.boardAsked) console.log("[hygiene]", r);
    } catch (e) {
      console.error("[hygiene]", e);
    }
  };
  tick();
  hygieneTimer = setInterval(tick, intervalMs);
}
function stopTaskHygiene() {
  if (hygieneTimer) {
    clearInterval(hygieneTimer);
    hygieneTimer = null;
  }
}

module.exports = {
  FRESH_FLOOR_MS, RETENTION_POLICIES, COMMAND_HISTORY_LIMIT,
  planTrim, dayKey, planReap,
  CARRY_SESSION_ID, costLedgerKeyOf, CostCarryFold,
  formatBytes, retentionLine, retentionSummary,
  RETENTION_INTERVAL_MS, RETENTION_FIRST_DELAY_MS, MAX_CATCHUP_BYTES,
  ROSTER_BACKUP, MESSAGE_FILE, SPAWN_FILE, MEMORY_BACKUP_STAMP, AGENT_DIR,
  NOTHING, withinRoot, isPlainDir, plainFileStat, dirSize,
  reapFiles, reapDirs, reapRosterBackups,
  eachLine, appendRange, readRangeSync,
  trimLedger, trimBoardArchive, capTasksArchive, verifyRoots, runRetention,
  startRetention, stopRetention,
  TASK_HYGIENE_KEYS, TASK_HYGIENE_DEFAULTS, DAY_MS, resolveTaskHygiene,
  isHygieneCard, cardId, toMs, asks, openAsk, lastTouchedAt, doneAt, ageDays,
  isLive, staleDays, isStale, askNagDays, archiveReasonFor, archiveNote,
  planSweep, applySweepPlan, estimateTokens, boardDecision, boardArchiveEntry,
  boardAskMessage, TASK_HYGIENE_INTERVAL_MS, runTaskHygiene,
  startTaskHygiene, stopTaskHygiene,
};
