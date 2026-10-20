'use strict';
/**
 * KnowledgeManager — the office knowledge graph. Owns the KG root directory
 * and exposes the same surface as the `kg` CLI that agents run in their
 * shells (bin/kg.cjs), so the UI and agents share one store.
 *
 * Root: <home>/kg  (env KG_ROOT is injected into every agent spawn so `kg`
 * commands work without configuration; KG_CLI/KG_CORE point at our binaries.)
 */
const path = require('node:path');
const core = require('./kg-core.cjs');

class KnowledgeManager {
  constructor({ home, enabled } = {}) {
    this.home = home;
    this.enabled = enabled ?? (() => true);   // settings flag; on by default
    this.root = path.join(home, 'kg');
    this.cliPath = path.join(__dirname, '..', '..', 'bin', 'kg.cjs');
    this.corePath = path.join(__dirname, 'kg-core.cjs');
  }

  /** Env injected into agent spawns; {} when the feature is off. */
  env() {
    if (!this.enabled()) return {};
    return { KG_ROOT: this.root, KG_CLI: this.cliPath, KG_CORE: this.corePath };
  }

  /** Whether the feature flag is on (verbatim KnowledgeManager.active()). */
  active() { return this.enabled() === true; }

  ingest(input, opts) { return core.ingest(this.root, input, opts); }
  /** Ingest a file from disk (verbatim ingestFile(srcPath, opts)). */
  ingestFile(srcPath, opts = {}) { return core.ingest(this.root, srcPath, opts); }
  /** Ingest inline text — e.g. pasted content (verbatim ingestText(text, opts)). */
  ingestText(text, opts = {}) { return core.ingest(this.root, { text, ...opts }, opts); }
  search(q, limit)    { return core.search(this.root, q, limit); }
  getDoc(id)          { return core.getDoc(this.root, id); }
  /** verbatim name for getDoc — KnowledgeManager.get(docId). */
  get(id)             { return core.getDoc(this.root, id); }
  list()              { return core.list(this.root); }
  remove(id)          { return core.removeDoc(this.root, id); }
  stats()             { return core.stats(this.root); }
}

module.exports = { KnowledgeManager };
