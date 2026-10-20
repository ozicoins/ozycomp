'use strict';
/**
 * CostLedgerTotals — verbatim port of the reference's incremental ledger fold
 * (out/main/index.js ~23496-23632): the fleet snapshot's LIFETIME usd column.
 * The cost ledger only grows, so each pass consumes just the bytes appended
 * since the last one (MAX_BYTES_PER_PASS per fold); a cumulative session's usd
 * can reset downward mid-file (compaction, --resume), which is folded exactly
 * like the retention carry: a drop commits the prior peak and starts a new one.
 *
 * warm=false until one full pass completes, so usdFor() returns null instead of
 * a confident $0 for an agent whose ledger bytes have not been read yet.
 */
const fs = require('node:fs');

const EPS = 1e-9;
const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;

class CostLedgerTotals {
  constructor() {
    /** Bytes of the ledger already folded. */
    this.offset = 0;
    /** Trailing partial line, kept as BYTES so a multi-byte character split
     *  across a read boundary is never decoded in half. */
    this.tail = Buffer.alloc(0);
    /** `agentId \t sessionId` → fold state. */
    this.seg = new Map();
    /** agentId → lifetime usd. Recomputed after each pass. */
    this.totals = new Map();
    /** One pass at a time; a timer must never stack folds on itself. */
    this.folding = false;
    /** True once a full pass has completed, so callers can tell "no spend" from
     *  "not read yet" instead of reporting a confident $0. */
    this.warm = false;
  }
  /** Lifetime usd for one agent, or null when the ledger has not been folded
   *  yet. Null rather than 0 so a caller never publishes a cold zero as fact. */
  usdFor(agentId) {
    if (!this.warm) return null;
    return this.totals.get(agentId) ?? 0;
  }
  /** Every agent's lifetime usd. Empty until the first pass completes. */
  all() {
    return new Map(this.totals);
  }
  /** Has at least one full pass completed? */
  get ready() {
    return this.warm;
  }
  /** True lifetime spend across every agent in the ledger. */
  floorTotal() {
    let t = 0;
    for (const v of this.totals.values()) t += v;
    return t;
  }
  /**
   * Fold whatever has been appended since the last pass. Returns immediately;
   * the work happens off the caller's stack. Safe to call from a timer and
   * never throws.
   */
  refresh(ledgerPath) {
    if (this.folding) return Promise.resolve();
    this.folding = true;
    return this.fold(ledgerPath).catch(() => {
    }).finally(() => {
      this.folding = false;
    });
  }
  /** Fold repeatedly until caught up to EOF. */
  async refreshFully(ledgerPath) {
    for (let i = 0; i < 4096; i++) {
      await this.refresh(ledgerPath);
      if (this.warm) return;
    }
  }
  async fold(ledgerPath) {
    let size;
    try {
      size = fs.statSync(ledgerPath).size;
    } catch {
      return;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) {
      this.warm = true;
      return;
    }
    const end = Math.min(size, this.offset + MAX_BYTES_PER_PASS) - 1;
    const from = this.offset;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(ledgerPath, { start: from, end });
      stream.on('data', (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.consume(buf);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    this.offset = end + 1;
    this.recompute();
    if (this.offset >= size) this.warm = true;
  }
  /** Fold one buffer, holding back any incomplete trailing line. */
  consume(chunk) {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const cut = buf.lastIndexOf(10);
    if (cut === -1) {
      this.tail = buf;
      return;
    }
    this.tail = buf.subarray(cut + 1);
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (line) this.foldLine(line);
    }
  }
  foldLine(line) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!row || typeof row.agent_id !== 'string') return;
    const usd = typeof row.usd === 'number' && Number.isFinite(row.usd) ? row.usd : 0;
    const key = `${row.agent_id}\t${row.session_id ?? ''}`;
    let s = this.seg.get(key);
    if (!s) {
      s = { committed: 0, peak: 0 };
      this.seg.set(key, s);
    }
    if (usd < s.peak - EPS) {
      s.committed += s.peak;
      s.peak = usd;
    } else if (usd > s.peak) {
      s.peak = usd;
    }
  }
  recompute() {
    const next = new Map();
    for (const [key, s] of this.seg) {
      const agentId = key.slice(0, key.indexOf('\t'));
      next.set(agentId, (next.get(agentId) ?? 0) + s.committed + s.peak);
    }
    this.totals = next;
  }
  reset() {
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.seg.clear();
    this.totals = new Map();
    this.warm = false;
  }
}

module.exports = { CostLedgerTotals, EPS, MAX_BYTES_PER_PASS };
