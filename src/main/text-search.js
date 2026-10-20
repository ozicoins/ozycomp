'use strict';
/**
 * Hive text search — verbatim port of the reference's `hive:textSearch`
 * handler. Whole-hive grep for the UI's search box: scores lines in board.md,
 * tasks.json and every agent's memory.md by keyword hits (phrase match beats
 * keyword count), keeps the best 3 per file, returns the best 14 overall.
 */
const fs = require('node:fs');
const path = require('node:path');

const STOP = new Set("the a an and or of to in on at for with about what who when where why how did do does is are was were be been we you i it that this they them our us me my your have has had tell say said know remember decide decided note noted learn learned team memory please any some there here from by as into up out over just so then than also which whom whose will would could should can let get got one thing things something anything everything".split(" "));
function keywordsOf(query) {
  const out = [];
  for (const w of (query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}
function scoreLine(line, keywords) {
  const l = (line || "").toLowerCase();
  let n = 0;
  for (const k of keywords) if (l.includes(k)) n++;
  return n;
}
function keywordThreshold(keywords) {
  return Math.max(1, Math.ceil(keywords.length / 2));
}
function excerptAround(line, keywords, width = 220) {
  const l = line.trim();
  if (l.length <= width) return l;
  const lower = l.toLowerCase();
  let at = -1;
  for (const k of keywords) {
    const i = lower.indexOf(k);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start2 = Math.max(0, Math.min(at === -1 ? 0 : at - Math.floor(width / 3), l.length - width));
  return `${start2 ? "…" : ""}${l.slice(start2, start2 + width).trim()}${start2 + width < l.length ? "…" : ""}`;
}

/**
 * hiveTextSearch(root, query) — the handler body, verbatim. `root` is the
 * hive directory (hive.root); returns {ok, results:[{source, excerpt}]}.
 */
function hiveTextSearch(root, query) {
  if (typeof query !== "string" || !query.trim()) return { ok: false, results: [] };
  if (!root) return { ok: false, results: [] };
  const q = query.trim().toLowerCase();
  const keywords = keywordsOf(q);
  const threshold = keywordThreshold(keywords);
  const scored = [];
  const targets = [
    { path: path.join(root, "board.md"), source: "board.md" },
    { path: path.join(root, "tasks.json"), source: "tasks.json" }
  ];
  const agentsDir = path.join(root, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const id of fs.readdirSync(agentsDir)) {
      targets.push({ path: path.join(agentsDir, id, "memory.md"), source: `${id}/memory.md` });
    }
  }
  for (const { path: path2, source } of targets) {
    if (!fs.existsSync(path2)) continue;
    const mine = [];
    for (const line of fs.readFileSync(path2, "utf8").split("\n")) {
      const lower = line.toLowerCase();
      const phrase = lower.includes(q);
      const score = phrase ? keywords.length + 1 : keywords.length ? scoreLine(lower, keywords) : 0;
      if (phrase ? false : keywords.length ? score < threshold : true) continue;
      mine.push({ source, excerpt: excerptAround(line, keywords.length ? keywords : [q]), score });
    }
    mine.sort((a, b) => b.score - a.score);
    scored.push(...mine.slice(0, 3));
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, 14).map(({ source, excerpt }) => ({ source, excerpt }));
  return { ok: true, results };
}

module.exports = {
  STOP, keywordsOf, scoreLine, keywordThreshold, excerptAround, hiveTextSearch,
};
