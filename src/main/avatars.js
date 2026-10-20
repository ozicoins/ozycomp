'use strict';
/**
 * Office avatar recipes — verbatim port of the reference. A custom avatar is
 * a recipe over fixed part lists (skin / hair style / cloth + optional face /
 * eyes / brow / nose / mouth / facial + RGB slots), saved under config
 * customAvatars (cap 48). migrateRecipe fills the optional slots and derives
 * the legacy heavy/lashes booleans so old recipes keep rendering.
 */
const SKINS = ["pale", "light", "tan", "brown", "dark", "deep"];
const FACES = ["oval", "round", "square", "long", "heart", "heavy"];
const EYES = ["normal", "wide", "dot", "squint", "happy", "lashed"];
const BROWS = ["flat", "angry", "raised", "soft", "thick", "arched"];
const NOSES = ["small", "normal", "long", "wide"];
const MOUTHS = ["neutral", "smile", "frown", "grin", "open", "smirk"];
const FACIALS = ["mustache", "mustacheSm", "stubble", "goatee"];
const HAIR_STYLES = [
  "styleShort",
  "styleFloppy",
  "styleFrame",
  "styleBun",
  "styleCurly",
  "styleMessy",
  "styleRecede",
  "styleSpiky",
  "styleBald",
  "styleLong",
  "styleAfro",
  "styleBuzz",
  "styleMohawk"
];
const CLOTHS = [
  "suit",
  "dressshirt",
  "polo",
  "blouse",
  "cardigan",
  "sweater",
  "shirt_open",
  "sweater_v",
  "tee",
  "hoodie",
  "vest",
  "blazer_tee",
  "turtleneck",
  "shirt_w",
  "boatneck",
  "dress",
  "wrap",
  "blazer_w",
  "stripe_tee",
  "cami"
];
function newCustomAvatarId(now = Date.now()) {
  return `${now.toString(36)}${Math.floor(Math.random() * 16777215).toString(36).padStart(5, "0")}`;
}
const MAX_CUSTOM_AVATARS = 48;
const MAX_AVATAR_NAME = 24;
const ID_RE = /^[a-z0-9]{4,40}$/;
function sanitizeAvatarName(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, MAX_AVATAR_NAME).trim();
}
function normalizeCustomAvatar(input, now = new Date().toISOString()) {
  if (!input || typeof input !== "object") return null;
  const a = input;
  if (typeof a.id !== "string" || !ID_RE.test(a.id)) return null;
  const name = sanitizeAvatarName(a.name);
  if (!name) return null;
  const recipe = normalizeRecipe(a.recipe);
  if (!recipe) return null;
  const iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : now;
  return { id: a.id, name, recipe, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt) };
}
const isRgb = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255);
const oneOf = (list, v) => typeof v === "string" && list.includes(v);
const rgbOf = (v) => isRgb(v) ? [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])] : void 0;
function normalizeRecipe(input) {
  if (!input || typeof input !== "object") return null;
  const r = input;
  if (!oneOf(SKINS, r.skin) || !oneOf(HAIR_STYLES, r.hair) || !oneOf(CLOTHS, r.cloth)) return null;
  const hairc = rgbOf(r.hairc), c1 = rgbOf(r.c1);
  if (!hairc || !c1) return null;
  const out = { skin: r.skin, hair: r.hair, hairc, cloth: r.cloth, c1 };
  if (oneOf(FACES, r.face)) out.face = r.face;
  if (oneOf(EYES, r.eyes)) out.eyes = r.eyes;
  if (oneOf(BROWS, r.brow)) out.brow = r.brow;
  if (oneOf(NOSES, r.nose)) out.nose = r.nose;
  if (oneOf(MOUTHS, r.mouth)) out.mouth = r.mouth;
  if (oneOf(FACIALS, r.facial)) out.facial = r.facial;
  const eyec = rgbOf(r.eyec);
  if (eyec) out.eyec = eyec;
  const mouthc = rgbOf(r.mouthc);
  if (mouthc) out.mouthc = mouthc;
  const c2 = rgbOf(r.c2);
  if (c2) out.c2 = c2;
  const tie = rgbOf(r.tie);
  if (tie) out.tie = tie;
  const pants = rgbOf(r.pants);
  if (pants) out.pants = pants;
  if (r.blush === true) out.blush = true;
  if (r.glasses === true) out.glasses = true;
  if (r.heavy === true) out.heavy = true;
  if (r.lashes === true) out.lashes = true;
  if (r.hairargs && typeof r.hairargs === "object") {
    const a = r.hairargs;
    const ha = {};
    if (a.part === "L" || a.part === "R") ha.part = a.part;
    if (typeof a.recede === "number" && Number.isFinite(a.recede)) ha.recede = a.recede;
    if (typeof a.length === "number" && Number.isFinite(a.length)) ha.length = Math.max(0, Math.min(31, Math.round(a.length)));
    if (typeof a.vol === "number" && Number.isFinite(a.vol)) ha.vol = Math.max(0, Math.min(3, Math.round(a.vol)));
    if (Object.keys(ha).length) out.hairargs = ha;
  }
  return migrateRecipe(out);
}
function migrateRecipe(r) {
  const o = { ...r };
  if (!o.face) o.face = o.heavy ? "heavy" : "oval";
  if (!o.eyes) o.eyes = o.lashes ? "lashed" : "normal";
  if (!o.brow) o.brow = "flat";
  if (!o.nose) o.nose = "normal";
  if (!o.mouth) o.mouth = "neutral";
  o.heavy = o.face === "heavy";
  o.lashes = o.eyes === "lashed";
  return o;
}

module.exports = {
  SKINS, FACES, EYES, BROWS, NOSES, MOUTHS, FACIALS, HAIR_STYLES, CLOTHS,
  newCustomAvatarId, MAX_CUSTOM_AVATARS, MAX_AVATAR_NAME, ID_RE,
  sanitizeAvatarName, normalizeCustomAvatar, normalizeRecipe, migrateRecipe,
};
