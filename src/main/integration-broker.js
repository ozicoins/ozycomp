'use strict';
/**
 * Integration broker — verbatim port of the reference integration block
 * (index.js ~21420-21680 auth/validation helpers, ~24060-24430 broker + file
 * grants, ~25495-25530 IPC handlers, ~21760-21850 record/secret store).
 *
 * Workers never hold raw provider secrets: they get a per-worker capability
 * token and a loopback URL, and the broker injects auth headers server-side.
 * Tokens live in memory only — the `.broker` file written into each agent dir
 * is just a re-delivery channel for a token that dies with the process.
 *
 * Electron seam (safeStorage) binds lazily so the module is testable outside
 * Electron; the broker itself only needs getRecord/getSecret injected.
 */
const node_fs = require('node:fs');
const node_crypto = require('node:crypto');
const node_stream = require('node:stream');
const http = require('node:http');
const path = require('node:path');
// The reference reads/writes the config through module-level readConfig /
// writeConfig; here they're seams the host binds — electron-main wires the
// real ConfigStore via _bindConfig, tests inject fakes. Integration record
// CRUD (listRecords/upsertRecord/removeRecord/enabledIds) goes through them.
let readConfig = null;
let writeConfig = null;
function bindConfig() {
  if (!readConfig || !writeConfig) throw new Error('integration-broker: config seam not bound (call _bindConfig first)');
}

// lazy seam — require('electron') throws outside Electron (unit tests),
// so the secret store binds lazily and tests inject a fake via _setElectron.
let electron = null;
function bindElectron() {
  if (!electron) electron = require('electron');
}

// ── auth model (index.js ~21420-21610) ───────────────────────────────────────
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28"
};
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const AUTH_PREFIX_RE = /^[A-Za-z0-9-]{1,32}$/;
const BASIC_USER_RE = /^[\x21-\x39\x3b-\x7e]([\x20-\x39\x3b-\x7e]{0,126}[\x21-\x39\x3b-\x7e])?$/;
function hasSecretValue(secret) {
  return typeof secret === "string" && secret.trim().length > 0;
}
function apiAuthSlot(auth) {
  switch (auth.mode) {
    case "none":
      return null;
    case "bearer":
    case "github":
      return { where: "header", name: "authorization", prefix: "Bearer " };
    case "header": {
      const name = auth.header.trim().toLowerCase();
      return HEADER_NAME_RE.test(name) ? { where: "header", name, prefix: "" } : null;
    }
    case "prefix": {
      const name = auth.header.trim().toLowerCase();
      const word2 = auth.prefix.trim();
      if (!HEADER_NAME_RE.test(name) || !AUTH_PREFIX_RE.test(word2)) return null;
      return { where: "header", name, prefix: `${word2} ` };
    }
    case "query": {
      const name = auth.param.trim();
      return QUERY_PARAM_RE.test(name) ? { where: "query", name, prefix: "" } : null;
    }
    case "basic": {
      const user = auth.user.trim();
      return BASIC_USER_RE.test(user) ? { where: "header", name: "authorization", prefix: "Basic ", basicUser: user } : null;
    }
    default:
      return null;
  }
}
function apiAuthParts(auth, secret) {
  const constant = auth.mode === "github" ? { ...GITHUB_HEADERS } : {};
  const slot = apiAuthSlot(auth);
  if (!slot || !hasSecretValue(secret)) return { headers: constant, query: {} };
  const value = slot.basicUser !== void 0 ? `${slot.prefix}${base64Utf8(`${slot.basicUser}:${secret}`)}` : `${slot.prefix}${secret}`;
  return slot.where === "header" ? { headers: { ...constant, [slot.name]: value }, query: {} } : { headers: constant, query: { [slot.name]: value } };
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Utf8(input) {
  const bytes = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536) bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    else bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : void 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : void 0;
    out += B64[b0 >> 2];
    out += B64[(b0 & 3) << 4 | (b1 ?? 0) >> 4];
    out += b1 === void 0 ? "=" : B64[(b1 & 15) << 2 | (b2 ?? 0) >> 6];
    out += b2 === void 0 ? "=" : B64[b2 & 63];
  }
  return out;
}
const INTEGRATION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ALL_AUTH_TYPES = ["none", "bearer", "header", "prefix", "query", "basic", "github"];
const ALL_KINDS = ["github", "custom-rest"];
function secretRefFor(id) {
  return `int:${id}`;
}
function authTypeNeedsSecret(t) {
  return t !== "none";
}
function validateIntegrationRecord(rec) {
  if (!rec || typeof rec !== "object") return { ok: false, error: "record must be an object" };
  const r = rec;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!INTEGRATION_SLUG_RE.test(id)) {
    return { ok: false, error: "id must be a lowercase slug (2–40 chars, a–z 0–9 -, no leading/trailing hyphen)" };
  }
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (!label || label.length > 60) return { ok: false, error: "label is required and must be <= 60 chars" };
  const kind = r.kind;
  if (!ALL_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${ALL_KINDS.join(", ")}` };
  const authType = r.authType;
  if (!ALL_AUTH_TYPES.includes(authType)) {
    return { ok: false, error: `authType must be one of ${ALL_AUTH_TYPES.join(", ")}` };
  }
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
  const urlCheck = validateBaseUrl(baseUrl);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };
  const field = (key, wanted, re, what) => {
    const raw = typeof r[key] === "string" ? r[key].trim() : "";
    if (!wanted) {
      return raw === "" ? { ok: true, value: void 0 } : { ok: false, error: `${key} is not valid for authType '${authType}'` };
    }
    return re.test(raw) ? { ok: true, value: raw } : { ok: false, error: `authType '${authType}' requires ${key} matching ${what}` };
  };
  const h = field("authHeader", authType === "header" || authType === "prefix", HEADER_NAME_RE, "[A-Za-z0-9-]{1,64}");
  if (!h.ok) return h;
  const p = field("authPrefix", authType === "prefix", AUTH_PREFIX_RE, "[A-Za-z0-9-]{1,32}");
  if (!p.ok) return p;
  const q = field("authQuery", authType === "query", QUERY_PARAM_RE, "[A-Za-z0-9_.-]{1,64}");
  if (!q.ok) return q;
  const u = field("authUser", authType === "basic", BASIC_USER_RE, "a printable name without a colon");
  if (!u.ok) return u;
  const templateId = typeof r.templateId === "string" && INTEGRATION_SLUG_RE.test(r.templateId.trim()) ? r.templateId.trim() : void 0;
  const rawProbe = typeof r.probePath === "string" ? r.probePath.trim().replace(/^\/+/, "") : "";
  if (rawProbe && (rawProbe.length > 200 || !resolveUpstreamUrl(baseUrl, rawProbe))) {
    return { ok: false, error: "probePath must be a path under baseUrl, at most 200 chars" };
  }
  const probePath2 = rawProbe || void 0;
  const needsSecret = authTypeNeedsSecret(authType);
  const secretRef = needsSecret ? secretRefFor(id) : void 0;
  const enabled = r.enabled === true;
  return {
    ok: true,
    value: {
      id,
      label,
      kind,
      baseUrl,
      authType,
      authHeader: h.value,
      authPrefix: p.value,
      authQuery: q.value,
      authUser: u.value,
      secretRef,
      templateId,
      probePath: probePath2,
      enabled
    }
  };
}
function validateBaseUrl(baseUrl) {
  if (!baseUrl) return { ok: false, error: "baseUrl is required" };
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return { ok: false, error: "baseUrl must be a valid URL" };
  }
  if (u.username || u.password) return { ok: false, error: "baseUrl must not contain userinfo" };
  if (u.search || u.hash) return { ok: false, error: "baseUrl must not contain a query or fragment" };
  if (baseUrl.includes("..")) return { ok: false, error: 'baseUrl must not contain ".."' };
  const isLoopbackHost = u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]" || u.hostname === "localhost";
  if (u.protocol === "https:") return { ok: true, url: u };
  if (u.protocol === "http:" && isLoopbackHost) return { ok: true, url: u };
  return { ok: false, error: "baseUrl must be https (http allowed only for 127.0.0.1/localhost)" };
}
function apiAuthOf(rec) {
  switch (rec.authType) {
    case "bearer":
      return { mode: "bearer" };
    case "github":
      return { mode: "github" };
    case "header":
      return { mode: "header", header: rec.authHeader ?? "" };
    case "prefix":
      return { mode: "prefix", header: rec.authHeader ?? "", prefix: rec.authPrefix ?? "" };
    case "query":
      return { mode: "query", param: rec.authQuery ?? "" };
    case "basic":
      return { mode: "basic", user: rec.authUser ?? "" };
    default:
      return { mode: "none" };
  }
}
function buildAuthRequest(rec, secret) {
  return apiAuthParts(apiAuthOf(rec), secret);
}
function resolveTemplate(templates, rec) {
  if (rec.templateId) {
    const byId = templates.find((x) => x.idSuggestion === rec.templateId);
    if (byId) return byId;
  }
  const sameKind = templates.filter((x) => x.kind === rec.kind);
  const byUrl = sameKind.find((x) => x.baseUrl !== "" && x.baseUrl === rec.baseUrl.trim());
  if (byUrl) return byUrl;
  return sameKind.length === 1 ? sameKind[0] : void 0;
}
function probePathFor(templates, rec) {
  return rec.probePath || resolveTemplate(templates, rec)?.probePath || "";
}
function resolveUpstreamUrl(baseUrl, pathAndQuery) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathAndQuery)) return null;
  if (pathAndQuery.startsWith("//")) return null;
  const pathOnly = pathAndQuery.split(/[?#]/)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (decodedPath.split("/").some((seg) => seg === "..")) return null;
  const basePath = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/";
  const rel = pathAndQuery.replace(/^\/+/, "");
  let resolved;
  try {
    resolved = new URL(basePath + rel, base.origin);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  const confinePrefix = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/";
  if (confinePrefix !== "/" && !(resolved.pathname + "/").startsWith(confinePrefix) && resolved.pathname !== base.pathname) {
    return null;
  }
  return resolved;
}
const INTEGRATION_TEMPLATES = [
  {
    kind: "github",
    label: "GitHub",
    baseUrl: "https://api.github.com",
    authType: "github",
    secretLabel: "GitHub personal access token",
    secretHelp: "Create a fine-grained or classic PAT at github.com/settings/tokens with the scopes your workers need.",
    docsUrl: "https://docs.github.com/rest",
    idSuggestion: "github"
  },
  {
    kind: "custom-rest",
    label: "Custom REST API",
    baseUrl: "",
    authType: "bearer",
    secretLabel: "API key / token",
    secretHelp: "Point baseUrl at any REST API, then pick how it wants the key: a bearer token, a header you name, a header with a prefix word, a query parameter, HTTP basic, or none.",
    idSuggestion: "my-api"
  },
  // ─── First-wave YC tools (Dwight, P2) ───────────────────────────────────────
  // Per-tool auth model + high-value endpoint catalog: hive/docs/integration-templates.md.
  // Gmail / Google Calendar / Salesforce are intentionally NOT registered yet: they
  // authenticate via OAuth, and IntegrationAuthType has no `oauth2` (OAuth refresh is a
  // v1 non-goal — spec §8). They are documented under "Pending: OAuth broker".
  {
    kind: "custom-rest",
    label: "Linear",
    baseUrl: "https://api.linear.app/graphql",
    authType: "header",
    authHeader: "Authorization",
    secretLabel: "Linear API key",
    secretHelp: 'Linear → Settings → Security & access → Personal API keys. Sent verbatim in Authorization (no "Bearer"). Every call POSTs to /graphql.',
    docsUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
    idSuggestion: "linear"
  },
  {
    kind: "custom-rest",
    label: "Jira",
    baseUrl: "https://your-domain.atlassian.net/rest/api/3",
    authType: "header",
    authHeader: "Authorization",
    secretLabel: "Authorization header (Basic …)",
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>"). Token at id.atlassian.com → Security → API tokens. Replace your-domain with your Atlassian site.',
    docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
    idSuggestion: "jira"
  },
  {
    kind: "custom-rest",
    label: "Notion",
    baseUrl: "https://api.notion.com/v1",
    authType: "bearer",
    secretLabel: "Notion internal integration token",
    secretHelp: 'notion.so/my-integrations → Internal Integration Secret; share target pages/DBs with it. Every request also needs header "Notion-Version: 2022-06-28" (worker sends it per request).',
    docsUrl: "https://developers.notion.com/reference/intro",
    idSuggestion: "notion"
  },
  {
    kind: "custom-rest",
    label: "Stripe",
    baseUrl: "https://api.stripe.com/v1",
    authType: "bearer",
    secretLabel: "Stripe secret key",
    secretHelp: "dashboard.stripe.com → Developers → API keys → Secret key (sk_live_/sk_test_). Restricted keys recommended. Bodies are form-encoded, not JSON.",
    docsUrl: "https://stripe.com/docs/api",
    idSuggestion: "stripe"
  },
  {
    kind: "custom-rest",
    label: "Confluence",
    baseUrl: "https://your-domain.atlassian.net/wiki/api/v2",
    authType: "header",
    authHeader: "Authorization",
    secretLabel: "Authorization header (Basic …)",
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>") (same Atlassian token as Jira). Replace your-domain with your site.',
    docsUrl: "https://developer.atlassian.com/cloud/confluence/rest/v2/intro/",
    idSuggestion: "confluence"
  },
  {
    kind: "custom-rest",
    label: "Sentry",
    baseUrl: "https://sentry.io/api/0",
    authType: "bearer",
    secretLabel: "Sentry auth token",
    secretHelp: "sentry.io → Settings → Auth Tokens. Org-scoped routes carry your org slug in the path, e.g. /organizations/<org>/issues/.",
    docsUrl: "https://docs.sentry.io/api/",
    idSuggestion: "sentry"
  },
  {
    kind: "custom-rest",
    label: "HubSpot",
    baseUrl: "https://api.hubapi.com",
    authType: "bearer",
    secretLabel: "HubSpot private app token",
    secretHelp: "HubSpot → Settings → Integrations → Private Apps → create app → Access token (scopes crm.objects.*).",
    docsUrl: "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
    idSuggestion: "hubspot"
  },
  {
    // 0.5.5: Razorpay takes a Key Id and Key Secret as HTTP basic. Without a
    // preset the founder was told to hand build `Basic <base64>` into a header.
    kind: "custom-rest",
    label: "Razorpay",
    baseUrl: "https://api.razorpay.com/v1",
    authType: "basic",
    secretLabel: "Key Secret",
    secretHelp: "Razorpay Dashboard → Account & Settings → API Keys. Put the Key Id (rzp_live_…) in User and the Key Secret here, on its own.",
    docsUrl: "https://razorpay.com/docs/api/",
    idSuggestion: "razorpay",
    probePath: "plans?count=1"
  }
];

// ── record store + secret store (index.js ~21757-21850) ──────────────────────
// The reference keeps integration secrets in userData/integration-secrets.json
// via electron.safeStorage (separate from the harness SecretsStore). Same here.
function listRecords() {
  bindConfig();
  return readConfig().integrations ?? [];
}
function getRecord(id) {
  return listRecords().find((r) => r.id === id);
}
function enabledIds() {
  return listRecords().filter((r) => r.enabled && (!authTypeNeedsSecret(r.authType) || hasSecret(r.secretRef))).map((r) => r.id);
}
function upsertRecord(input) {
  bindConfig();
  const v = validateIntegrationRecord(input);
  if (!v.ok) return v;
  const now = Date.now();
  const existing = getRecord(v.value.id);
  const record = {
    ...v.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const next = listRecords().filter((r) => r.id !== record.id);
  next.push(record);
  writeConfig({ integrations: next });
  return { ok: true, record };
}
function removeRecord(id) {
  bindConfig();
  const next = listRecords().filter((r) => r.id !== id);
  writeConfig({ integrations: next });
  deleteSecret(secretRefFor(id));
  return { ok: true };
}
function listRecordsRedacted() {
  return listRecords().map(({ secretRef, ...rest }) => ({ ...rest, hasSecret: !!secretRef && hasSecret(secretRef) }));
}
function secretsPath() {
  bindElectron();
  return path.join(electron.app.getPath("userData"), "integration-secrets.json");
}
function readSecretBlob() {
  const p = secretsPath();
  if (!node_fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(node_fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeSecretBlob(blob) {
  const p = secretsPath();
  node_fs.mkdirSync(path.dirname(p), { recursive: true });
  node_fs.writeFileSync(p, JSON.stringify(blob, null, 2), { encoding: "utf8", mode: 384 });
}
function setSecret(secretRef, plaintext) {
  bindElectron();
  if (!secretRef) return { ok: false, error: "secretRef required" };
  if (typeof plaintext !== "string" || plaintext === "") return { ok: false, error: "secret required" };
  try {
    if (!electron.safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: "OS secret encryption is unavailable; refusing to store a secret in plaintext" };
    }
    const cipher = electron.safeStorage.encryptString(plaintext).toString("base64");
    const blob = readSecretBlob();
    blob[secretRef] = cipher;
    writeSecretBlob(blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function getSecret(secretRef) {
  bindElectron();
  if (!secretRef) return void 0;
  const cipher = readSecretBlob()[secretRef];
  if (!cipher) return void 0;
  try {
    if (!electron.safeStorage.isEncryptionAvailable()) return void 0;
    return electron.safeStorage.decryptString(Buffer.from(cipher, "base64"));
  } catch {
    return void 0;
  }
}
function listSecretRefs() {
  return Object.keys(readSecretBlob());
}
function hasSecret(secretRef) {
  if (!secretRef) return false;
  return !!readSecretBlob()[secretRef];
}
function deleteSecret(secretRef) {
  if (!secretRef) return;
  const blob = readSecretBlob();
  if (secretRef in blob) {
    delete blob[secretRef];
    if (Object.keys(blob).length === 0) {
      try {
        node_fs.rmSync(secretsPath(), { force: true });
      } catch {
      }
    } else {
      writeSecretBlob(blob);
    }
  }
}

// ── the broker (index.js ~24060-24330) ───────────────────────────────────────
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 3e4;
const DEFAULT_USER_AGENT = "ozycomp-broker/1";
const HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const STRIP_REQUEST = /* @__PURE__ */ new Set([
  "authorization",
  "x-md-broker-token",
  "host",
  "cookie",
  "content-length",
  ...HOP_BY_HOP
]);
const STRIP_RESPONSE = /* @__PURE__ */ new Set([
  "content-encoding",
  "content-length",
  "set-cookie",
  ...HOP_BY_HOP
]);
function isLoopback(addr) {
  const a = addr.replace(/^::ffff:/, "");
  return a === "::1" || a.startsWith("127.");
}
class IntegrationBroker {
  server = null;
  port = 0;
  deps;
  /** token -> capability. In-memory only; NEVER persisted. */
  byToken = /* @__PURE__ */ new Map();
  /** workerId -> token, for revoke. */
  byWorker = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.deps = deps;
  }
  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the bound port. */
  start(preferredPort = 0) {
    return new Promise((resolve) => {
      if (this.server) {
        resolve({ ok: true, port: this.port });
        return;
      }
      const server = http.createServer((req, res) => this.handle(req, res));
      const onError = (e) => {
        server.off("listening", onListening);
        resolve({ ok: false, error: e.message });
      };
      const onListening = () => {
        server.off("error", onError);
        this.server = server;
        const addr = server.address();
        this.port = addr && typeof addr === "object" ? addr.port : preferredPort;
        resolve({ ok: true, port: this.port });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(preferredPort, "127.0.0.1");
    });
  }
  /** Close the broker. Idempotent and best-effort. Clears all capabilities. */
  stop() {
    try {
      this.server?.close();
    } catch {
    }
    this.server = null;
    this.port = 0;
    this.byToken.clear();
    this.byWorker.clear();
  }
  /** Whether the broker is bound and serving. */
  running() {
    return !!this.server && this.port > 0;
  }
  /** The base URL workers use (only valid while running). */
  url() {
    return `http://127.0.0.1:${this.port}`;
  }
  /** Mint a per-worker capability token granting access to `allowedIds`. Any prior
   *  token for this worker is revoked first. The token is a random handle — never a
   *  secret, never persisted. */
  grant(workerId, allowedIds) {
    this.revoke(workerId);
    const token = node_crypto.randomBytes(32).toString("base64url");
    this.byToken.set(token, { workerId, allowedIds: new Set(allowedIds), grantedAt: Date.now() });
    this.byWorker.set(workerId, token);
    return token;
  }
  /** Point every live capability at `allowedIds` without minting new tokens,
   *  so an integration enabled after an agent started reaches it too (0.5.5).
   *  Tokens stay the same: an agent's env and its .broker file keep working. */
  retarget(allowedIds) {
    for (const cap of this.byToken.values()) cap.allowedIds = new Set(allowedIds);
  }
  /** Revoke a worker's capability (called on teardown). Idempotent. */
  revoke(workerId) {
    const token = this.byWorker.get(workerId);
    if (token) {
      this.byToken.delete(token);
      this.byWorker.delete(workerId);
    }
  }
  /** Constant-time-ish lookup of a presented token against live capabilities. */
  resolveCapability(provided) {
    if (!provided) return void 0;
    const a = Buffer.from(provided);
    for (const [token, cap] of this.byToken) {
      const b = Buffer.from(token);
      if (a.length === b.length && node_crypto.timingSafeEqual(a, b)) return cap;
    }
    return void 0;
  }
  static sendError(res, status, code, message) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
      }
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message, code }));
  }
  /** Extract the bearer/x-md-broker-token from the request. */
  static tokenFrom(req) {
    const x = req.headers["x-md-broker-token"];
    if (typeof x === "string" && x) return x;
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m) return m[1].trim();
    }
    return void 0;
  }
  handle(req, res) {
    if (!isLoopback(req.socket.remoteAddress ?? "")) {
      return IntegrationBroker.sendError(res, 403, "forbidden", "loopback callers only");
    }
    const cap = this.resolveCapability(IntegrationBroker.tokenFrom(req));
    if (!cap) return IntegrationBroker.sendError(res, 401, "unauthorized", "missing or invalid capability token");
    const rawUrl = req.url ?? "";
    if (/^\/i\/?(\?[^#]*)?$/.test(rawUrl)) {
      if ((req.method ?? "GET").toUpperCase() !== "GET") return IntegrationBroker.sendError(res, 405, "method_not_allowed", "GET /i lists the integration ids this token may reach");
      const ids = [...cap.allowedIds].filter((id) => this.deps.getRecord(id)?.enabled === true);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ids }));
      return;
    }
    const m = /^\/i\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/.exec(rawUrl);
    if (!m) return IntegrationBroker.sendError(res, 404, "not_found", "expected /i/<integrationId>/<path>");
    const integrationId = decodeURIComponent(m[1]);
    const path2 = m[2] ?? "";
    const query = m[3] ?? "";
    if (!cap.allowedIds.has(integrationId)) {
      return IntegrationBroker.sendError(res, 403, "forbidden", "integration not in this worker capability");
    }
    const rec = this.deps.getRecord(integrationId);
    if (!rec) return IntegrationBroker.sendError(res, 404, "not_found", "unknown integration");
    if (!rec.enabled) return IntegrationBroker.sendError(res, 403, "forbidden", "integration is disabled");
    const upstream = resolveUpstreamUrl(rec.baseUrl, path2 + query);
    if (!upstream) return IntegrationBroker.sendError(res, 400, "bad_request", "invalid or out-of-bounds path");
    let secret;
    if (authTypeNeedsSecret(rec.authType)) {
      secret = this.deps.getSecret(rec.secretRef);
      if (!secret) return IntegrationBroker.sendError(res, 503, "no_secret", "no secret configured for this integration");
    }
    void this.forward(req, res, rec, upstream, secret);
  }
  async forward(req, res, rec, upstream, secret) {
    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    let body2;
    if (hasBody) {
      try {
        body2 = await readBodyCapped(req);
      } catch (e) {
        if (e.message === "too_large") {
          return IntegrationBroker.sendError(res, 413, "payload_too_large", "request body too large");
        }
        return IntegrationBroker.sendError(res, 400, "bad_request", "could not read request body");
      }
    }
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (STRIP_REQUEST.has(key)) continue;
      if (Array.isArray(v)) outHeaders[key] = v.join(", ");
      else if (typeof v === "string") outHeaders[key] = v;
    }
    if (!outHeaders["user-agent"]) outHeaders["user-agent"] = DEFAULT_USER_AGENT;
    const { headers: injected, query: injectedQuery } = buildAuthRequest(rec, secret);
    for (const [k, v] of Object.entries(injected)) {
      delete outHeaders[k];
      outHeaders[k] = v;
    }
    for (const [k, v] of Object.entries(injectedQuery)) upstream.searchParams.set(k, v);
    const ac = new AbortController();
    const timer2 = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream, {
        method,
        headers: outHeaders,
        body: body2,
        redirect: "manual",
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer2);
      return IntegrationBroker.sendError(res, 502, "bad_gateway", `upstream request failed: ${e.message}`);
    }
    const respHeaders = {};
    upstreamRes.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
    });
    res.writeHead(upstreamRes.status, respHeaders);
    try {
      if (upstreamRes.body) {
        await pipeWebStream(upstreamRes.body, res);
      } else {
        res.end();
      }
    } catch {
      try {
        res.end();
      } catch {
      }
    } finally {
      clearTimeout(timer2);
    }
  }
}
function readBodyCapped(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(e));
  });
}
function pipeWebStream(web, res) {
  return new Promise((resolve, reject) => {
    const node = node_stream.Readable.fromWeb(web);
    node.on("error", reject);
    res.on("error", reject);
    res.on("finish", resolve);
    node.pipe(res);
  });
}

// ── per-agent .broker file + grants (index.js ~24325-24400) ──────────────────
const BROKER_FILE = ".broker";
function writeBrokerFile(agentDir, env, now = Date.now()) {
  if (!agentDir || !node_fs.existsSync(agentDir)) return false;
  const file = path.join(agentDir, BROKER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const body2 = JSON.stringify({ url: env.MD_BROKER_URL, token: env.MD_BROKER_TOKEN, writtenAt: new Date(now).toISOString() }) + "\n";
  try {
    node_fs.writeFileSync(tmp, body2, { mode: 384 });
    node_fs.chmodSync(tmp, 384);
    node_fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      node_fs.rmSync(tmp, { force: true });
    } catch {
    }
    return false;
  }
}
function removeBrokerFile(agentDir) {
  if (!agentDir) return;
  try {
    node_fs.rmSync(path.join(agentDir, BROKER_FILE), { force: true });
  } catch {
  }
}
class BrokerGrants {
  constructor(broker, allowedIds) {
    this.broker = broker;
    this.allowedIds = allowedIds;
  }
  dirs = /* @__PURE__ */ new Map();
  mint(id) {
    return { MD_BROKER_URL: this.broker.url(), MD_BROKER_TOKEN: this.broker.grant(id, this.allowedIds()) };
  }
  /** Track a spawn and grant it when the broker is up. The env to merge, or
   *  an empty object when the broker is not listening yet (onBrokerStart
   *  grants it then, through the file). */
  grant(id, agentDir) {
    if (agentDir) this.dirs.set(id, agentDir);
    if (!this.broker.running()) return {};
    const env = this.mint(id);
    if (agentDir) writeBrokerFile(agentDir, env);
    return env;
  }
  /** Revoke, remove the file, stop tracking. Idempotent. */
  release(id) {
    try {
      this.broker.revoke(id);
    } catch {
    }
    removeBrokerFile(this.dirs.get(id));
    this.dirs.delete(id);
  }
  /** The broker just started: new port, every old token gone. Mint a fresh
   *  grant for each tracked agent and rewrite its file. Returns files written. */
  onBrokerStart() {
    if (!this.broker.running()) return 0;
    let n = 0;
    for (const [id, dir] of this.dirs) if (writeBrokerFile(dir, this.mint(id))) n++;
    return n;
  }
  /** The enabled integrations changed: widen or narrow every live grant. */
  onIntegrationsChanged() {
    try {
      this.broker.retarget(this.allowedIds());
    } catch {
    }
  }
  tracked() {
    return [...this.dirs.keys()];
  }
}

// ── custom (env) secrets + provider keys (index.js ~24398-24450, 31869-31876) ─
const SECRET_NAME_RE = /^[A-Z0-9_]+$/;
const SECRET_NAME_MAX = 64;
const CUSTOM_SECRET_PREFIX = "env:";
const RESERVED_SECRET_NAMES = /* @__PURE__ */ new Set([
  // the shell and the OS
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PWD",
  "TERM",
  "LANG",
  "LC_ALL",
  // the harness
  "AGENT_ID",
  "AGENT_NAME",
  "AGENT_DIR",
  "HIVE_ROOT",
  "MD_BROKER_URL",
  "MEMPALACE_PALACE_PATH",
  "HIVE_AUTO_APPROVE",
  // the provider keys (their own rows, BACKEND_KEY_ENV in main)
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY"
]);
function secretNameProblem(name) {
  if (!name) return "empty";
  if (!SECRET_NAME_RE.test(name)) return "shape";
  if (name.length > SECRET_NAME_MAX) return "long";
  if (RESERVED_SECRET_NAMES.has(name)) return "reserved";
  return null;
}
const customSecretRef = (name) => `${CUSTOM_SECRET_PREFIX}${name}`;
function customSecretNames(refs) {
  return refs.filter((r) => r.startsWith(CUSTOM_SECRET_PREFIX)).map((r) => r.slice(CUSTOM_SECRET_PREFIX.length)).filter((n) => secretNameProblem(n) === null).sort();
}
function customSecretEnv(names, get2, env) {
  const out = {};
  for (const name of names) {
    if (secretNameProblem(name) !== null || env[name] !== void 0) continue;
    const value = get2(customSecretRef(name));
    if (value) out[name] = value;
  }
  return out;
}
const BACKEND_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY"
};
const providerKeyRef = (backend) => `apikey:${backend}`;

// ── the "test this integration" probe (index.js ~35042-35065) ────────────────
async function testIntegration(payload) {
  const p = payload ?? {};
  if (typeof p.id !== "string" || !p.id) return { ok: false, error: "id required" };
  const rec = getRecord(p.id);
  if (!rec) return { ok: false, error: "unknown integration" };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  const probePath2 = typeof p.path === "string" && p.path ? p.path : probePathFor(INTEGRATION_TEMPLATES, rec);
  const target2 = resolveUpstreamUrl(rec.baseUrl, probePath2);
  if (!target2) return { ok: false, error: "path escapes the integration baseUrl", code: "bad_request" };
  const secret = getSecret(rec.secretRef);
  const { headers, query } = buildAuthRequest(rec, secret);
  for (const [k, v] of Object.entries(query)) target2.searchParams.set(k, v);
  try {
    const ac = new AbortController();
    const timer2 = setTimeout(() => ac.abort(), 15e3);
    const r = await fetch(target2, { method: "GET", headers, redirect: "manual", signal: ac.signal });
    clearTimeout(timer2);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── IPC handler surface (index.js ~25495-25515) ──────────────────────────────
function integrationHandlers(deps) {
  return {
    upsert(record) {
      const r = deps.upsertRecord(record);
      deps.onChanged();
      return r;
    },
    setSecret(payload) {
      const p = payload ?? {};
      if (typeof p.id !== "string" || !p.id) return { ok: false, error: "id required" };
      if (typeof p.secret !== "string" || !p.secret) return { ok: false, error: "secret required" };
      const r = deps.setSecret(deps.secretRefFor(p.id), p.secret);
      if (r.ok) deps.onChanged();
      return r;
    },
    remove(payload) {
      const p = payload ?? {};
      if (typeof p.id !== "string" || !p.id) return { ok: false, error: "id required" };
      const r = deps.removeRecord(p.id);
      deps.onChanged();
      return r;
    }
  };
}

module.exports = {
  GITHUB_HEADERS, HEADER_NAME_RE, QUERY_PARAM_RE, AUTH_PREFIX_RE, BASIC_USER_RE,
  hasSecretValue, apiAuthSlot, apiAuthParts, base64Utf8,
  INTEGRATION_SLUG_RE, ALL_AUTH_TYPES, ALL_KINDS, secretRefFor, authTypeNeedsSecret,
  validateIntegrationRecord, validateBaseUrl, apiAuthOf, buildAuthRequest,
  resolveTemplate, probePathFor, resolveUpstreamUrl, INTEGRATION_TEMPLATES,
  listRecords, getRecord, enabledIds, upsertRecord, removeRecord, listRecordsRedacted,
  secretsPath, readSecretBlob, writeSecretBlob, setSecret, getSecret, listSecretRefs, hasSecret, deleteSecret,
  MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS, DEFAULT_USER_AGENT, HOP_BY_HOP, STRIP_REQUEST, STRIP_RESPONSE,
  isLoopback, IntegrationBroker, readBodyCapped, pipeWebStream,
  BROKER_FILE, writeBrokerFile, removeBrokerFile, BrokerGrants, integrationHandlers,
  SECRET_NAME_RE, SECRET_NAME_MAX, CUSTOM_SECRET_PREFIX, RESERVED_SECRET_NAMES,
  secretNameProblem, customSecretRef, customSecretNames, customSecretEnv,
  BACKEND_KEY_ENV, providerKeyRef, testIntegration,
  _setElectron(ns) { electron = ns; },
  _bindConfig(read, write) { readConfig = read; writeConfig = write; },
  _reset() { electron = null; readConfig = null; writeConfig = null; },
};
