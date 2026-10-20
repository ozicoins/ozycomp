import { bj as recipeKey, b6 as migrateRecipe, a4 as PORTRAIT_W, a3 as PORTRAIT_H, b1 as isCustomAvatarId, aS as getCustomAvatar, i as CUSTOM_PREFIX, bd as presetIndexOf, be as presetRecipe } from "./global-eDtrx50m.js";
import "./index-CsK_GEYj.js";
const CAST_COSTUMES = {
  michael: "vampire",
  jim: "skeleton",
  pam: "witch",
  dwight: "scarecrow",
  kevin: "pumpkin",
  angela: "cat",
  oscar: "scientist",
  stanley: "undertaker",
  phyllis: "fortune",
  andy: "pirate",
  kelly: "batqueen",
  ryan: "werewolf",
  toby: "mummy",
  creed: "reaper",
  meredith: "bride"
};
const POOL = ["skeleton", "witch", "pumpkin", "cat", "vampire", "mummy", "scientist", "pirate"];
function costumeForRecipe(r) {
  const k = recipeKey(r);
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return POOL[(h >>> 0) % POOL.length];
}
const INK = [34, 30, 42];
const INK_HI = [58, 52, 70];
const PURPLE = [92, 54, 138];
const PURPLE_HI = [128, 84, 176];
const PURPLE_SH = [60, 34, 94];
const ORANGE = [242, 140, 40];
const ORANGE_HI = [255, 176, 84];
const ORANGE_SH = [196, 100, 24];
const GREEN = [104, 150, 56];
const GREEN_SH = [66, 104, 38];
const BONE = [240, 236, 222];
const BONE_SH = [196, 190, 172];
const PINK = [236, 150, 176];
const FANG = [252, 252, 250];
const STRAW = [222, 186, 102];
const STRAW_SH = [176, 138, 64];
const RUST = [184, 108, 50];
const DENIM = [72, 94, 132];
const FUR = [132, 120, 108];
const FUR_HI = [172, 160, 146];
const FUR_SH = [94, 84, 76];
const STEEL_SH = [150, 156, 172];
const ROBE = [46, 42, 58];
const ROBE_HI = [70, 64, 86];
const GOGGLE = [120, 206, 192];
const GREY = [150, 150, 158];
function costumeRecipe(r, c) {
  switch (c) {
    case "skeleton":
      return { ...r, cloth: "sweater", c1: INK, c2: void 0, tie: void 0, pants: INK };
    case "mummy":
      return { ...r, cloth: "sweater", c1: BONE, c2: void 0, tie: void 0, pants: BONE_SH };
    case "vampire":
      return { ...r, cloth: "suit", c1: PURPLE_SH, c2: BONE, tie: INK, pants: INK };
    case "undertaker":
      return { ...r, cloth: "suit", c1: INK, c2: BONE, tie: BONE, pants: INK };
    case "witch":
      return { ...r, cloth: "sweater", c1: PURPLE, c2: void 0, tie: void 0, pants: PURPLE_SH };
    case "scarecrow":
      return { ...r, cloth: "dressshirt", c1: RUST, c2: void 0, tie: void 0, pants: DENIM };
    case "pumpkin":
      return { ...r, cloth: "sweater", c1: ORANGE, c2: void 0, tie: void 0, pants: GREEN_SH };
    case "cat":
      return { ...r, cloth: "turtleneck", c1: INK, c2: void 0, tie: void 0, pants: INK };
    case "scientist":
      return { ...r, cloth: "suit", c1: BONE, c2: r.c1, tie: r.tie ?? INK_HI, pants: r.pants ?? INK_HI };
    case "fortune":
      return { ...r, c1: PURPLE_HI, c2: ORANGE, pants: PURPLE_SH };
    case "pirate":
      return { ...r, cloth: "tee", c1: BONE, c2: void 0, tie: void 0, pants: INK };
    case "batqueen":
      return { ...r, c1: PURPLE, c2: INK, pants: INK };
    case "werewolf":
      return { ...r, cloth: "tee", c1: FUR_SH, c2: void 0, tie: void 0, pants: DENIM };
    case "reaper":
      return { ...r, cloth: "hoodie", c1: ROBE, c2: ROBE_HI, tie: void 0, pants: ROBE };
    case "bride":
      return { ...r, cloth: "blouse", c1: BONE, c2: void 0, tie: void 0, pants: BONE_SH };
  }
}
function row(p, y, x0, x1, c) {
  for (let x = x0; x <= x1; x++) p.set(x, y, c);
}
function clearRows(p, y0, y1, x0 = 0, x1 = p.w - 1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p.clear(x, y);
}
function witchHat(p) {
  clearRows(p, 0, 4);
  p.set(11, 0, PURPLE_SH);
  p.set(12, 0, PURPLE_SH);
  p.set(10, 0, PURPLE);
  row(p, 1, 8, 10, PURPLE);
  p.set(8, 1, PURPLE_HI);
  row(p, 2, 7, 10, PURPLE);
  p.set(7, 2, PURPLE_HI);
  p.set(10, 2, PURPLE_SH);
  row(p, 3, 6, 11, PURPLE);
  p.set(6, 3, PURPLE_HI);
  p.set(11, 3, PURPLE_SH);
  row(p, 4, 5, 12, ORANGE);
  p.set(5, 4, ORANGE_HI);
  p.set(12, 4, ORANGE_SH);
  p.set(8, 4, GREEN);
  p.set(9, 4, GREEN);
  row(p, 5, 2, 15, PURPLE);
  p.set(2, 5, PURPLE_HI);
  p.set(3, 5, PURPLE_HI);
  p.set(14, 5, PURPLE_SH);
  p.set(15, 5, PURPLE_SH);
}
function catEars(p, back) {
  clearRows(p, 0, 2);
  const ear = (xs) => {
    for (const [y, a, b] of xs) row(p, y, a, b, INK);
  };
  ear([[0, 4, 4], [1, 4, 5], [2, 3, 6], [3, 3, 7]]);
  ear([[0, 13, 13], [1, 12, 13], [2, 11, 14], [3, 10, 14]]);
  row(p, 4, 4, 13, INK);
  p.set(6, 4, INK_HI);
  p.set(11, 4, INK_HI);
  if (!back) {
    p.set(5, 2, PINK);
    p.set(5, 3, PINK);
    p.set(4, 3, PINK);
    p.set(12, 2, PINK);
    p.set(12, 3, PINK);
    p.set(13, 3, PINK);
  }
}
function catFace(p) {
  const W2 = [70, 60, 72];
  p.set(8, 12, PINK);
  p.set(4, 12, W2);
  p.set(5, 13, W2);
  p.set(13, 12, W2);
  p.set(12, 13, W2);
}
function mummyHead(p) {
  const strip = (pts, c) => {
    for (const [x, y] of pts) if (p.alpha(x, y) === 255) p.set(x, y, c);
  };
  for (let x = 4; x <= 13; x++) {
    if (p.alpha(x, 5) === 255) p.set(x, 5, BONE);
  }
  strip([[5, 4], [6, 4], [7, 3], [8, 3], [9, 3], [10, 2], [11, 2], [12, 2]], BONE);
  strip([[4, 6], [5, 6], [12, 4], [13, 4], [13, 3]], BONE_SH);
  for (const x of [6, 9, 12]) if (p.alpha(x, 5) === 255) p.set(x, 5, BONE_SH);
  p.set(14, 5, BONE);
  p.set(15, 6, BONE);
  p.set(15, 7, BONE_SH);
}
const torsoEnd = (ctx, p) => ctx.scene ? 24 : p.h - 1;
function skeletonBody(p, ctx) {
  const { T } = ctx;
  const end = torsoEnd(ctx, p);
  const onCloth = (x, y) => p.alpha(x, y) === 255 && isInk(p.rgb(x, y));
  const bone = (x, y, c = BONE) => {
    if (onCloth(x, y)) p.set(x, y, c);
  };
  if (ctx.back) {
    for (let y = T + 1; y <= end; y++) bone(8, y, y % 2 ? BONE : BONE_SH), bone(9, y, BONE_SH);
  } else {
    for (let y = T + 1; y <= end - 1; y++) {
      bone(8, y);
      bone(9, y, BONE_SH);
    }
    for (const dy of [2, 4, 6]) {
      const y = T + dy;
      if (y > end) continue;
      for (const x of [5, 6, 7]) bone(x, y);
      for (const x of [10, 11, 12]) bone(x, y, x === 12 ? BONE_SH : BONE);
    }
  }
  if (ctx.scene) {
    for (let y = 25; y <= 30; y++) {
      bone(6, y);
      bone(11, y, BONE_SH);
    }
  }
}
function isInk(c) {
  return c[0] < 80 && c[1] < 76 && c[2] < 90 && Math.abs(c[0] - c[1]) < 14;
}
function mummyBody(p, ctx) {
  const { T } = ctx;
  const end = ctx.scene ? 30 : p.h - 1;
  for (let y = T + 1; y <= end; y += 2) {
    for (let x = 0; x < p.w; x++) {
      if (p.alpha(x, y) !== 255) continue;
      const c = p.rgb(x, y);
      if (isBandage(c) && (x + (y >> 1)) % 5 !== 0) p.set(x, y, BONE_SH);
    }
  }
}
function isBandage(c) {
  return c[0] > 150 && c[1] > 140 && c[2] > 120 && c[0] - c[2] < 60;
}
function vampireBody(p, ctx) {
  const { T, back } = ctx;
  const end = ctx.scene ? 29 : p.h - 1;
  if (back) {
    for (let y = T; y <= end; y++) {
      const half = y < T + 2 ? 5 : 6;
      for (let x = 8 - half + 1; x <= 9 + half - 1; x++) p.set(x, y, INK);
      p.set(8, y, INK_HI);
    }
    row(p, T, 5, 12, PURPLE);
    return;
  }
  for (let y = T; y <= end; y++) {
    const spread = Math.min(2, Math.floor((y - T) / 3));
    let xl = -1, xr = -1;
    for (let x = 0; x < p.w; x++) if (p.alpha(x, y) === 255) {
      xl = x;
      break;
    }
    for (let x = p.w - 1; x >= 0; x--) if (p.alpha(x, y) === 255) {
      xr = x;
      break;
    }
    if (xl < 0) {
      xl = 5;
      xr = 12;
    }
    if (y > 24 && ctx.scene) {
      xl = 5;
      xr = 12;
    }
    const L = Math.max(0, xl - spread), R = Math.min(p.w - 1, xr + spread);
    for (let x = L; x <= L + 1; x++) p.set(x, y, INK);
    for (let x = R - 1; x <= R; x++) p.set(x, y, INK);
    p.set(L + 2, y, PURPLE_SH);
    p.set(R - 2, y, PURPLE_SH);
  }
}
function vampireCollar(p, ctx) {
  if (ctx.back) return;
  const pts = [
    [2, 14, INK],
    [3, 15, INK],
    [3, 16, PURPLE],
    [4, 17, PURPLE],
    [5, 18, INK],
    [2, 15, INK],
    [2, 16, INK],
    [3, 17, INK],
    [4, 18, INK],
    [15, 14, INK],
    [14, 15, INK],
    [14, 16, PURPLE],
    [13, 17, PURPLE],
    [12, 18, INK],
    [15, 15, INK],
    [15, 16, INK],
    [14, 17, INK],
    [13, 18, INK]
  ];
  for (const [x, y, c] of pts) if (p.alpha(x, y) !== 255 || y >= 17) p.set(x, y, c);
}
function fangs(p, r) {
  const y = r.mouth === "frown" ? 16 : 15;
  p.set(7, y, FANG);
  p.set(10, y, FANG);
}
const CARVED = [96, 46, 12];
const RUST_SH = [136, 76, 34];
function stamp(p, x0, y0, grid, pal) {
  grid.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      const c = pal[line[dx]];
      if (c) p.set(x0 + dx, y0 + dy, c);
    }
  });
}
const onBody = (p, ctx, x, y) => y >= ctx.T && y <= torsoEnd(ctx, p) && p.alpha(x, y) === 255;
function paintBody(p, ctx, x, y, c) {
  if (onBody(p, ctx, x, y)) p.set(x, y, c);
}
function topHat(p, back) {
  clearRows(p, 0, 4);
  stamp(p, 0, 0, [
    ".....hkkkkkkk.....",
    ".....hkkkkkkk.....",
    ".....hkkkkkkk.....",
    ".....hkkkkkkk.....",
    ".....ggggggggg....".slice(0, 18),
    "..hkkkkkkkkkkkkk.."
  ], { k: INK, h: INK_HI, g: GREY });
  if (!back) p.set(12, 4, BONE);
}
function bowTie(p, ctx) {
  if (ctx.back) return;
  const y = ctx.T + 1;
  stamp(p, 6, y - 1, ["g....g", "ggkkgg", "g....g"], { g: GREY, k: INK_HI });
  paintBody(p, ctx, 12, ctx.T + 3, BONE);
}
function tricorn(p, back) {
  clearRows(p, 0, 2);
  stamp(p, 0, 0, [
    "..................",
    "..kk..........kk..",
    "..kkk.kkkkkk.kkk..",
    "...kkkkkkkkkkkk...",
    "...kkkkkbbkkkkk...",
    "..oooooooooooooo.."
  ], { k: INK, b: back ? INK : BONE, o: ORANGE });
}
function sailorStripes(p, ctx) {
  const end = torsoEnd(ctx, p);
  for (let y = ctx.T + 1; y <= end; y += 2) for (let x = 0; x < p.w; x++) paintBody(p, ctx, x, y, y === end || y === end - 1 ? ORANGE : INK_HI);
}
function strawHat(p) {
  clearRows(p, 0, 3);
  stamp(p, 0, 0, [
    "..................",
    "......hssssss.....",
    ".....hssssssss....",
    ".....rrrrrrrrr....",
    ".hssssssssssssss..",
    ".t.S.t......t.S.t."
  ], { s: STRAW, h: [240, 212, 140], S: STRAW_SH, t: STRAW, r: RUST_SH });
}
function plaid(p, ctx) {
  const end = torsoEnd(ctx, p);
  for (let y = ctx.T + 1; y <= end; y++) for (let x = 0; x < p.w; x++) {
    if (!onBody(p, ctx, x, y)) continue;
    if (y % 3 === 0) p.set(x, y, RUST_SH);
    else if (x % 3 === 0) p.set(x, y, [206, 134, 70]);
  }
  const py = ctx.scene ? ctx.T + 3 : ctx.T + 4;
  for (const [x, y] of [[5, py], [6, py], [5, py + 1], [6, py + 1]]) paintBody(p, ctx, x, y, DENIM);
  if (!ctx.back) {
    p.set(7, ctx.T, STRAW);
    p.set(10, ctx.T, STRAW_SH);
  }
  if (ctx.scene) {
    for (const x of [1, 16]) {
      p.set(x, 24, STRAW);
      p.set(x, 25, STRAW_SH);
    }
    row(p, 24, 3, 14, STRAW_SH);
  }
}
function pumpkinBeanie(p) {
  clearRows(p, 0, 3);
  stamp(p, 0, 0, [
    "........gl........",
    "........gll.......",
    ".....GGGGGGGG.....",
    "....GGGGGGGGGG....",
    "...GGGGGGGGGGGG...",
    "...dGdGdGdGdGdG..."
  ], { g: GREEN_SH, l: GREEN, G: GREEN, d: GREEN_SH });
}
function pumpkinFace(p, ctx) {
  const end = torsoEnd(ctx, p);
  for (let y = ctx.T + 1; y <= end; y++) for (const x of [4, 13]) paintBody(p, ctx, x, y, ORANGE_SH);
  if (ctx.back) return;
  const e = ctx.scene ? ctx.T + 1 : ctx.T + 2;
  const face = [
    [6, e + 1],
    [7, e],
    [7, e + 1],
    [10, e + 1],
    [10, e],
    [11, e + 1],
    [6, e + 3],
    [7, e + 4],
    [8, e + 4],
    [9, e + 3],
    [10, e + 4],
    [11, e + 4],
    [12, e + 3],
    [8, e + 3],
    [10, e + 3],
    [11, e + 3],
    [7, e + 3]
  ];
  for (const [x, y] of face) paintBody(p, ctx, x, y, CARVED);
}
function catDetails(p, ctx) {
  if (!ctx.back) {
    for (let y = ctx.T + 1; y <= ctx.T + 4; y++) for (let x = 7; x <= 10; x++) if (!(y === ctx.T + 4 && (x === 7 || x === 10))) paintBody(p, ctx, x, y, BONE);
  }
  if (ctx.scene) {
    const pts = ctx.back ? [[9, 25], [10, 26], [11, 26], [12, 25], [13, 24], [13, 23], [14, 22]] : [[16, 27], [17, 26], [17, 25], [17, 24], [16, 23]];
    for (const [x, y] of pts) p.set(x, y, INK);
  }
}
function goggles(p, back) {
  row(p, 5, 2, 15, INK_HI);
  if (back) return;
  stamp(p, 0, 3, [
    "....ssss..ssss....",
    "....sggs..sggs....",
    "..kksggskksggskk.."
  ], { s: STEEL_SH, g: GOGGLE, k: INK_HI });
}
function labCoat(p, ctx) {
  if (ctx.back) return;
  const y = ctx.T + (ctx.scene ? 2 : 3);
  paintBody(p, ctx, 12, y, ORANGE);
  paintBody(p, ctx, 13, y, PURPLE_HI);
  paintBody(p, ctx, 12, y + 1, BONE_SH);
  paintBody(p, ctx, 13, y + 1, BONE_SH);
}
function headScarf(p) {
  clearRows(p, 0, 2, 2, 15);
  stamp(p, 0, 2, [
    ".....pppppppp.....",
    "...pPPPPPPPPPPp...",
    "..pPPPPPPPPPPPPpk.",
    "..cPcPcPcPcPcPcPkk"
  ], { p: PURPLE, P: PURPLE_HI, c: ORANGE_HI, k: PURPLE_SH });
}
function shawl(p, ctx) {
  const y = ctx.T + (ctx.scene ? 3 : 4);
  for (let x = 0; x < p.w; x++) paintBody(p, ctx, x, y, x % 2 ? ORANGE : ORANGE_SH);
  for (let x = 0; x < p.w; x++) paintBody(p, ctx, x, y - 1, PURPLE);
}
function batBand(p, back) {
  clearRows(p, 0, 1);
  stamp(p, 0, 0, [
    ".PP............PP.",
    ".PPPP..p..p..PPPP.",
    "..PPPPPppppPPPPP..",
    "...P.P.peep.P.P...",
    "..oooooooooooooo.."
  ], { P: PURPLE_HI, p: PURPLE_SH, e: back ? PURPLE_SH : ORANGE_HI, o: ORANGE });
}
function wolfEars(p, back) {
  clearRows(p, 0, 1);
  const pal = { f: FUR, h: FUR_HI, s: FUR_SH, i: back ? FUR : PINK };
  stamp(p, 0, 0, [
    "..f...........f...",
    "..ff.........ff...",
    "..hif.......fih...",
    ".hhiff.....ffihh..",
    "..hfff.....fffh..."
  ].map((l) => l.padEnd(18, ".").slice(0, 18)), pal);
}
function furCollar(p, ctx) {
  const T = ctx.T;
  for (let x = 0; x < p.w; x++) {
    paintBody(p, ctx, x, T, x % 2 ? FUR_HI : FUR);
    if (x % 3 === 1) paintBody(p, ctx, x, T + 1, FUR_HI);
  }
  const end = torsoEnd(ctx, p);
  for (let x = 0; x < p.w; x++) if (x % 2 === 0) paintBody(p, ctx, x, end, FUR);
  if (!ctx.back) for (const [x, dy] of [[5, 3], [6, 4], [7, 5]]) paintBody(p, ctx, x, T + dy, FUR_HI);
}
function reaperHood(p, ctx) {
  const { back } = ctx;
  clearRows(p, 0, 2, 2, 15);
  stamp(p, 0, 1, [
    ".....oooooooo.....",
    "....oooooooooo....",
    "...ohhhhhhhhhho...",
    "..oohhhhhhhhhhoo..",
    "..ohhhhhhhhhhhho.."
  ], { o: ROBE, h: back ? ROBE : ROBE_HI });
  for (let y = 6; y <= 14; y++) for (const x of [2, 3, 14, 15]) {
    if ((x === 3 || x === 14) && p.alpha(x, y) === 255) continue;
    p.set(x, y, x === 2 || x === 15 ? ROBE : ROBE_HI);
  }
  if (back) {
    for (let y = 3; y <= 16; y++) for (let x = 2; x <= 15; x++) if (p.alpha(x, y) === 255 || y <= 14) p.set(x, y, x === 8 || x === 9 ? ROBE_HI : ROBE);
  }
}
function beehive(p) {
  clearRows(p, 0, 3, 2, 15);
  stamp(p, 0, 0, [
    "......kkkkkk......",
    ".....kbkkkkbk.....",
    "....kbkkkkkkbk....",
    "....kbkkkkkkbk....",
    "...kbkkkkkkkkbk...",
    "...kbkkkkkkkkbk..."
  ], { k: INK, b: BONE });
}
function paintCostume(p, c, ctx) {
  const { back } = ctx;
  switch (c) {
    case "witch":
      witchHat(p);
      break;
    case "pumpkin":
      pumpkinFace(p, ctx);
      pumpkinBeanie(p);
      break;
    case "cat":
      catDetails(p, ctx);
      catEars(p, back);
      if (!back) catFace(p);
      break;
    case "mummy":
      mummyBody(p, ctx);
      mummyHead(p);
      break;
    case "skeleton":
      skeletonBody(p, ctx);
      break;
    case "vampire":
      vampireBody(p, ctx);
      vampireCollar(p, ctx);
      if (!back) fangs(p, ctx.r);
      break;
    case "undertaker":
      bowTie(p, ctx);
      topHat(p, back);
      break;
    case "pirate":
      sailorStripes(p, ctx);
      tricorn(p, back);
      break;
    case "scarecrow":
      plaid(p, ctx);
      strawHat(p);
      break;
    case "scientist":
      labCoat(p, ctx);
      goggles(p, back);
      break;
    case "fortune":
      shawl(p, ctx);
      headScarf(p);
      break;
    case "batqueen":
      batBand(p, back);
      break;
    case "werewolf":
      furCollar(p, ctx);
      wolfEars(p, back);
      break;
    case "reaper":
      reaperHood(p, ctx);
      break;
    case "bride":
      beehive(p);
      break;
  }
}
const SCENE_W = 18;
const SCENE_H = 32;
const OUTLINE = [38, 34, 46];
const HX0 = 4, HX1 = 13;
let CUR_W = PORTRAIT_W, CUR_H = PORTRAIT_H;
const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
function shades(rgb, dl = 1.22, dd = 0.68) {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)]
  ];
}
const mix = (a, b, t) => [
  Math.round(a[0] * (1 - t) + b[0] * t),
  Math.round(a[1] * (1 - t) + b[1] * t),
  Math.round(a[2] * (1 - t) + b[2] * t)
];
function set(buf, x, y, c, a = 255) {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return;
  const i = (y * CUR_W + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = a;
}
const clear = (buf, x, y) => set(buf, x, y, [0, 0, 0], 0);
function alphaAt(buf, x, y) {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return 0;
  return buf[(y * CUR_W + x) * 4 + 3];
}
function rgbAt(buf, x, y) {
  const i = (y * CUR_W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
}
function eq(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function rect(buf, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(buf, x, y, c);
}
function onBase(buf, x, y, base, paint) {
  if (alphaAt(buf, x, y) === 255 && eq(rgbAt(buf, x, y), base)) set(buf, x, y, paint);
}
const SKIN = {
  pale: { hi: [255, 238, 224], base: [252, 226, 208], sh: [226, 188, 166], line: [186, 136, 112] },
  light: { hi: [255, 221, 189], base: [247, 201, 170], sh: [212, 158, 126], line: [168, 112, 82] },
  tan: { hi: [232, 182, 136], base: [214, 162, 116], sh: [176, 126, 86], line: [138, 92, 60] },
  brown: { hi: [180, 130, 94], base: [158, 112, 78], sh: [124, 86, 58], line: [90, 60, 40] },
  dark: { hi: [142, 98, 70], base: [120, 80, 56], sh: [94, 62, 42], line: [64, 42, 28] },
  deep: { hi: [112, 74, 52], base: [90, 58, 40], sh: [66, 40, 27], line: [44, 26, 16] }
};
const SKIN_SWATCHES = Object.fromEntries(
  Object.keys(SKIN).map((k) => [k, SKIN[k].base])
);
const skinPal = (skin) => SKIN[skin] ?? SKIN.light;
function drawHead(buf, skin) {
  const s = skinPal(skin);
  for (let y = 4; y <= 16; y++) {
    for (let x = HX0; x <= HX1; x++) {
      if ((x === HX0 || x === HX1) && (y === 4 || y === 5 || y === 16) || (x === 5 || x === 12) && y === 4) continue;
      set(buf, x, y, s.base);
    }
  }
  for (let y = 6; y < 12; y++) set(buf, 5, y, s.hi);
  set(buf, 6, 5, s.hi);
  set(buf, 7, 5, s.hi);
  for (let y = 6; y < 15; y++) set(buf, 12, y, s.sh);
  for (const x of [7, 8, 9, 10, 11]) set(buf, x, 16, s.sh);
  for (const ex of [HX0 - 1, HX1 + 1]) {
    set(buf, ex, 9, s.base);
    set(buf, ex, 10, s.base);
    set(buf, ex, 11, s.sh);
  }
  rect(buf, 7, 17, 10, 18, s.sh);
  rect(buf, 7, 17, 9, 17, s.base);
}
function drawHeavyFace(buf, skin) {
  const s = skinPal(skin);
  for (let y = 11; y <= 15; y++) {
    set(buf, HX0 - 1, y, s.base);
    set(buf, HX1 + 1, y, s.base);
  }
  set(buf, HX0 - 1, 15, s.sh);
  set(buf, HX1 + 1, 15, s.sh);
  for (const x of [5, 6, 11, 12]) set(buf, x, 16, s.base);
  rect(buf, 6, 17, 11, 18, s.base);
  for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 18, s.sh);
  set(buf, 7, 17, s.sh);
  set(buf, 10, 17, s.sh);
}
function drawFaceShape(buf, skin, face) {
  const s = skinPal(skin);
  if (face === "heavy") {
    drawHeavyFace(buf, skin);
    return;
  }
  if (face === "round") {
    for (let y = 10; y <= 14; y++) {
      set(buf, HX0 - 1, y, s.base);
      set(buf, HX1 + 1, y, s.sh);
    }
    set(buf, HX0 - 1, 10, s.hi);
    set(buf, HX0 - 1, 14, s.sh);
  } else if (face === "square") {
    rect(buf, HX0, 16, HX1, 16, s.base);
    set(buf, HX1, 16, s.sh);
    rect(buf, 5, 17, 12, 17, s.base);
    set(buf, 12, 17, s.sh);
    set(buf, 5, 17, s.sh);
    rect(buf, 7, 18, 10, 18, s.sh);
  } else if (face === "long") {
    rect(buf, 5, 16, 12, 16, s.base);
    set(buf, 12, 16, s.sh);
    rect(buf, 5, 17, 12, 17, s.base);
    set(buf, 12, 17, s.sh);
    rect(buf, 7, 18, 10, 18, s.base);
    set(buf, 10, 18, s.sh);
    rect(buf, 7, 19, 10, 19, s.sh);
  } else if (face === "heart") {
    for (const [x, y] of [[4, 14], [13, 14], [4, 15], [13, 15], [5, 16], [12, 16]]) clear(buf, x, y);
    set(buf, 6, 16, s.sh);
    set(buf, 11, 16, s.sh);
  }
}
function drawFace(buf, r) {
  const s = skinPal(r.skin);
  const white = [250, 248, 244], pup = r.eyec ?? [46, 38, 42];
  const glint = [252, 250, 248], lash = [54, 40, 48];
  const e = r.eyes ?? "normal";
  if (e === "normal" || e === "lashed" || e === "wide") {
    for (const x of [5, 6, 10, 11]) set(buf, x, 9, white);
    set(buf, 6, 9, pup);
    set(buf, 10, 9, pup);
  }
  if (e === "wide") {
    for (const x of [5, 6, 10, 11]) set(buf, x, 8, white);
    set(buf, 6, 8, pup);
    set(buf, 10, 8, pup);
  }
  if (e === "lashed") {
    for (const x of [5, 6, 10, 11]) set(buf, x, 8, lash);
    set(buf, 4, 8, lash);
    set(buf, 12, 8, lash);
    set(buf, 5, 9, glint);
    set(buf, 10, 9, glint);
  }
  if (e === "dot") {
    set(buf, 6, 9, pup);
    set(buf, 10, 9, pup);
  }
  if (e === "squint") for (const x of [5, 6, 10, 11]) set(buf, x, 9, pup);
  if (e === "happy") {
    set(buf, 5, 9, pup);
    set(buf, 6, 8, pup);
    set(buf, 10, 8, pup);
    set(buf, 11, 9, pup);
  }
  const brow = r.brow ?? "flat";
  if (brow === "flat") for (const x of [5, 6, 10, 11]) set(buf, x, 7, s.line);
  else if (brow === "angry") {
    set(buf, 5, 8, s.line);
    set(buf, 6, 7, s.line);
    set(buf, 10, 7, s.line);
    set(buf, 11, 8, s.line);
  } else if (brow === "raised") for (const x of [5, 6, 10, 11]) set(buf, x, 6, s.line);
  else if (brow === "soft") {
    for (const x of [5, 11]) set(buf, x, 7, s.line);
    for (const x of [6, 10]) set(buf, x, 7, s.sh);
  } else if (brow === "thick") {
    for (const x of [4, 5, 6, 10, 11, 12]) set(buf, x, 7, s.line);
    set(buf, 5, 6, s.line);
    set(buf, 11, 6, s.line);
  } else if (brow === "arched") {
    set(buf, 5, 7, s.line);
    set(buf, 6, 6, s.line);
    set(buf, 10, 6, s.line);
    set(buf, 11, 7, s.line);
  }
  const nose = r.nose ?? "normal";
  if (nose === "normal") {
    set(buf, 8, 11, s.sh);
    set(buf, 8, 12, s.sh);
    set(buf, 7, 12, s.sh);
  } else if (nose === "small") set(buf, 8, 12, s.sh);
  else if (nose === "long") {
    set(buf, 8, 10, s.sh);
    set(buf, 8, 11, s.sh);
    set(buf, 8, 12, s.sh);
    set(buf, 7, 12, s.sh);
  } else if (nose === "wide") {
    set(buf, 8, 11, s.sh);
    set(buf, 7, 12, s.sh);
    set(buf, 8, 12, s.sh);
    set(buf, 9, 12, s.sh);
  }
  const mc = r.mouthc ?? [158, 86, 80];
  const mouth = r.mouth ?? "neutral";
  const mouths = {
    neutral: [[7, 14], [8, 14], [9, 14], [10, 14]],
    smile: [[7, 14], [8, 14], [9, 14], [10, 14], [6, 13], [11, 13]],
    frown: [[7, 15], [8, 15], [9, 15], [10, 15], [6, 14], [11, 14]],
    grin: [[7, 14], [8, 14], [9, 14], [10, 14], [7, 13], [8, 13], [9, 13], [10, 13], [6, 13], [11, 13]],
    smirk: [[7, 14], [8, 14], [9, 14], [10, 14], [11, 13]],
    open: []
  };
  for (const [x, y] of mouths[mouth]) set(buf, x, y, mc);
  if (mouth === "open") {
    rect(buf, 8, 13, 9, 14, [88, 40, 46]);
    set(buf, 7, 14, mc);
    set(buf, 10, 14, mc);
  }
  if (r.blush) for (const x of [5, 12]) set(buf, x, 12, [235, 150, 140], 140);
}
const styleShort = (buf, color, skinBase, a) => {
  const [hi, base, sh] = shades(color);
  const part = a.part ?? "L", recede = a.recede ?? 0;
  rect(buf, HX0, 2, HX1, 4, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
  for (let y = 6; y < 9; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  if (recede) {
    for (let y = 3; y < 6; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase);
    set(buf, 8, 5, base);
  }
  const hx = part === "L" ? 6 : 11;
  for (let y = 2; y < 6; y++) set(buf, hx, y, sh);
  for (let x = HX0; x < hx; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
};
const styleFloppy = (buf, color) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 2, HX1, 4, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x <= 12; x++) set(buf, x, 6, base);
  set(buf, 9, 7, base);
  set(buf, 10, 7, base);
  set(buf, 11, 7, base);
  for (let y = 6; y < 9; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
  for (const x of [7, 8, 9]) set(buf, x, 6, hi);
};
const styleFrame = (buf, color, skinBase, a) => {
  const [hi, base, sh] = shades(color);
  const length = a.length ?? 17, vol = a.vol ?? 1;
  rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase);
  set(buf, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) {
    for (let dx = 0; dx < vol; dx++) {
      set(buf, HX0 - 1 - dx, y, base);
      set(buf, HX1 + 1 + dx, y, base);
    }
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
  }
  for (let x = HX0 - 1; x < HX0 + 1; x++) set(buf, x, length + 1, base);
  for (let x = HX1; x < HX1 + 2; x++) set(buf, x, length + 1, base);
  for (let y = 2; y < 6; y++) if (alphaAt(buf, HX1, y)) set(buf, HX1, y, sh);
  for (let x = HX0; x < 9; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
};
const styleBun = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase);
  set(buf, 9, 6, skinBase);
  for (let y = 6; y < 9; y++) {
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
  }
  rect(buf, 7, 1, 10, 2, base);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
};
const styleCurly = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  const pts = [
    [4, 3],
    [5, 2],
    [6, 3],
    [7, 2],
    [8, 3],
    [9, 2],
    [10, 3],
    [11, 2],
    [12, 3],
    [13, 3],
    [3, 4],
    [4, 4],
    [13, 4],
    [14, 4],
    [3, 5],
    [4, 5],
    [13, 5],
    [14, 5],
    [3, 6],
    [13, 6],
    [4, 6],
    [12, 6],
    [3, 7],
    [13, 7],
    [4, 7]
  ];
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (const [x, y] of pts) set(buf, x, y, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase);
  set(buf, 9, 6, skinBase);
  for (const [x, y] of [[5, 2], [7, 2], [9, 2], [11, 2]]) set(buf, x, y, hi);
};
const styleMessy = (buf, color, skinBase, a) => {
  const [hi, base] = shades(color);
  const length = a.length ?? 8;
  rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
  const spikes = [[3, 2], [5, 1], [7, 2], [9, 1], [11, 2], [13, 1], [14, 2], [4, 2], [12, 2]];
  for (const [x, y] of spikes) set(buf, x, y, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase);
  set(buf, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (const [x, y] of spikes) set(buf, x, y, hi);
};
const styleRecede = (buf, color, skinBase) => {
  const [, base, sh] = shades(color);
  for (let y = 4; y < 10; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (let x = HX0; x <= HX1; x++) set(buf, x, 4, base);
  for (let x = HX0 + 1; x < HX1; x++) set(buf, x, 5, base);
  for (let y = 5; y < 9; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 4)) set(buf, x, 4, sh);
};
const styleSpiky = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  const spikes = [[5, 2], [7, 1], [9, 2], [11, 1], [6, 2], [8, 2], [10, 2], [12, 2]];
  for (const [x, y] of spikes) set(buf, x, y, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase);
  set(buf, 9, 6, skinBase);
  for (let y = 6; y < 8; y++) {
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
  }
  for (const [x, y] of spikes) set(buf, x, y, hi);
};
const styleBald = (buf, color, skinBase, a) => {
  const [shi, sbase, ssh] = shades(skinBase, 1.1, 0.82);
  for (let x = 6; x <= 11; x++) set(buf, x, 2, sbase);
  for (let x = 5; x <= 12; x++) set(buf, x, 3, sbase);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 4, sbase);
  for (const x of [7, 8, 9]) set(buf, x, 2, shi);
  set(buf, 6, 3, shi);
  set(buf, 7, 3, shi);
  set(buf, 5, 3, ssh);
  set(buf, 12, 3, ssh);
  set(buf, HX1, 4, ssh);
  const [, base, sh] = shades(color);
  const top = a.recede ? 8 : 6;
  for (let y = top; y <= 10; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (let y = top; y <= 10; y++) {
    set(buf, HX0 - 1, y, sh);
    set(buf, HX1 + 1, y, sh);
  }
};
const styleLong = (buf, color, _skinBase, a) => {
  const [hi, base, sh] = shades(color);
  const len = a.length ?? 23;
  rect(buf, 5, 2, 12, 2, base);
  rect(buf, 4, 3, 13, 4, base);
  for (let x = 6; x <= 9; x++) set(buf, x, 2, hi);
  for (let y = 5; y <= 7; y++) {
    set(buf, 4, y, base);
    set(buf, 13, y, sh);
  }
  for (let y = 4; y <= len; y++) {
    set(buf, 3, y, y <= 9 ? hi : base);
    set(buf, 14, y, sh);
  }
  for (let y = 8; y <= len; y++) {
    set(buf, 2, y, base);
    set(buf, 15, y, sh);
  }
};
const styleAfro = (buf, color) => {
  const [hi, base, sh] = shades(color);
  rect(buf, 5, 0, 12, 0, base);
  rect(buf, 3, 1, 14, 1, base);
  rect(buf, 2, 2, 15, 4, base);
  for (let y = 5; y <= 12; y++) {
    rect(buf, 2, y, 3, y, base);
    rect(buf, 14, y, 15, y, base);
  }
  set(buf, 2, 13, base);
  set(buf, 15, 13, base);
  set(buf, 4, 5, base);
  set(buf, 13, 5, base);
  for (let y = 2; y <= 13; y++) set(buf, 15, y, sh);
  for (let y = 5; y <= 12; y++) set(buf, 14, y, y % 2 ? sh : base);
  for (const [x, y] of [[5, 0], [6, 0], [3, 1], [4, 1], [2, 2], [3, 2], [2, 3], [2, 5], [3, 7], [2, 9]]) set(buf, x, y, hi);
};
const styleBuzz = (buf, color, skinBase) => {
  const c = mix(shades(color)[1], skinBase, 0.45);
  rect(buf, 5, 3, 12, 3, c);
  rect(buf, 4, 4, 13, 4, c);
  set(buf, 4, 5, c);
  set(buf, 13, 5, c);
};
const styleMohawk = (buf, color, skinBase) => {
  const [hi, base, sh] = shades(color);
  const c = mix(base, skinBase, 0.5);
  rect(buf, 4, 4, 13, 4, c);
  set(buf, 4, 5, c);
  set(buf, 13, 5, c);
  rect(buf, 8, 0, 9, 3, base);
  set(buf, 7, 3, base);
  set(buf, 10, 3, base);
  set(buf, 8, 0, hi);
  set(buf, 8, 1, hi);
  set(buf, 9, 3, sh);
  set(buf, 10, 3, sh);
};
const HAIR_FNS = {
  styleShort,
  styleFloppy,
  styleFrame,
  styleBun,
  styleCurly,
  styleMessy,
  styleRecede,
  styleSpiky,
  styleBald,
  styleLong,
  styleAfro,
  styleBuzz,
  styleMohawk
};
function drawFacial(buf, kind, color) {
  const [, base, sh] = shades(color);
  if (kind === "mustache") {
    for (const x of [6, 7, 8, 9, 10]) set(buf, x, 13, base);
    set(buf, 6, 12, base);
    set(buf, 10, 12, base);
  } else if (kind === "mustacheSm") {
    for (const x of [7, 8, 9]) set(buf, x, 13, base);
  } else if (kind === "stubble") {
    for (const [x, y] of [[5, 14], [6, 15], [7, 15], [8, 15], [9, 15], [10, 15], [11, 14], [12, 13], [4, 13], [5, 15], [10, 15]])
      set(buf, x, y, sh, 150);
  } else if (kind === "goatee") {
    for (const x of [8, 9]) set(buf, x, 15, base);
    set(buf, 8, 14, base);
    set(buf, 9, 14, base);
    for (const x of [7, 8, 9, 10]) set(buf, x, 13, base);
  }
}
function drawGlasses(buf) {
  const frame = [60, 54, 62];
  const glint = [236, 240, 246];
  for (const x of [5, 6]) {
    set(buf, x, 8, frame);
    set(buf, x, 10, frame);
  }
  set(buf, 4, 9, frame);
  set(buf, 7, 9, frame);
  set(buf, 4, 8, frame);
  set(buf, 7, 8, frame);
  for (const x of [10, 11]) {
    set(buf, x, 8, frame);
    set(buf, x, 10, frame);
  }
  set(buf, 9, 9, frame);
  set(buf, 12, 9, frame);
  set(buf, 9, 8, frame);
  set(buf, 12, 8, frame);
  set(buf, 8, 8, frame);
  set(buf, 3, 9, frame);
  set(buf, 13, 9, frame);
  set(buf, 4, 8, glint);
  set(buf, 9, 8, glint);
}
function bodyShape(buf, col, heavy = false) {
  const [, base, sh] = shades(col);
  const rows = heavy ? [[19, 5, 12], [20, 3, 14], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 0, 17], [25, 0, 17], [26, 0, 17], [27, 0, 17]] : [[19, 6, 11], [20, 4, 13], [21, 3, 14], [22, 2, 15], [23, 2, 15], [24, 1, 16], [25, 1, 16], [26, 1, 16], [27, 1, 16]];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  const [lo, hi] = heavy ? [1, 16] : [2, 15];
  for (let y = 22; y < 28; y++) {
    set(buf, lo, y, sh);
    set(buf, hi, y, sh);
  }
}
function drawClothing(buf, kind, c1, c2, tie, skin, heavy = false) {
  const [hi, base, sh] = shades(c1);
  bodyShape(buf, c1, heavy);
  if (kind === "suit") {
    const white = [238, 238, 236];
    for (const [x, y] of [[8, 19], [9, 19], [7, 20], [8, 20], [9, 20], [10, 20], [8, 21], [9, 21]]) set(buf, x, y, white);
    for (const [x, y] of [[6, 20], [7, 21], [11, 20], [10, 21], [6, 21], [11, 21]]) set(buf, x, y, sh);
    if (tie) {
      for (let y = 20; y < 26; y++) {
        set(buf, 8, y, tie);
        set(buf, 9, y, tie);
      }
      set(buf, 8, 20, shades(tie)[0]);
    } else for (let y = 22; y < 26; y++) {
      set(buf, 8, y, white);
      set(buf, 9, y, white);
    }
  } else if (kind === "dressshirt") {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19], [7, 20], [10, 20]]) set(buf, x, y, sh);
    for (let y = 20; y < 27; y += 2) set(buf, 8, y, sh);
    if (tie) for (let y = 19; y < 26; y++) {
      set(buf, 8, y, tie);
      set(buf, 9, y, tie);
    }
  } else if (kind === "polo") {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]]) set(buf, x, y, hi);
    set(buf, 8, 20, sh);
    set(buf, 8, 22, sh);
    const accent = c2 ? shades(c2)[1] : hi;
    for (const [x, y] of [[7, 20], [9, 20]]) set(buf, x, y, accent);
  } else if (kind === "blouse") {
    const s = skinPal(skin);
    for (const [x, y] of [[7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) set(buf, x, y, s.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 20), base)) set(buf, x, 20, hi);
  } else if (kind === "cardigan") {
    const inner = c2 ? shades(c2)[1] : [235, 233, 226];
    for (let y = 19; y < 27; y++) {
      set(buf, 8, y, inner);
      set(buf, 9, y, inner);
    }
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]]) set(buf, x, y, sh);
  } else if (kind === "sweater") {
    for (const [x, y] of [[6, 19], [7, 19], [8, 19], [9, 19], [10, 19], [11, 19]]) set(buf, x, y, sh);
  }
}
function collarNeck(buf, skin) {
  rect(buf, 7, 18, 10, 19, skinPal(skin).sh);
}
const W = [238, 238, 236], IVORY = [235, 233, 226];
const GARMENT_ART = {
  shirt_open: { draw(b, T, c) {
    for (const [x, y] of [[5, T], [6, T], [11, T], [12, T], [6, T + 1], [11, T + 1]]) set(b, x, y, c.sh);
    for (const [x, y] of [[8, T], [9, T], [8, T + 1], [9, T + 1]]) set(b, x, y, c.skin.base);
    set(b, 8, T + 3, c.sh);
    set(b, 8, T + 5, c.sh);
  } },
  tee: { draw(b, T, c) {
    for (const x of [7, 8, 9, 10]) set(b, x, T, c.sh);
    if (c.c2) rect(b, 8, T + 3, 9, T + 4, c.c2);
  } },
  vest: { draw(b, T, c) {
    for (const [x, y] of [[8, T], [9, T], [7, T + 1], [8, T + 1], [9, T + 1], [10, T + 1], [8, T + 2], [9, T + 2], [6, T], [11, T]]) set(b, x, y, W);
    for (const [x, y] of [[7, T + 2], [10, T + 2], [7, T + 3], [10, T + 3]]) set(b, x, y, c.sh);
    set(b, 8, T + 4, c.sh);
    set(b, 8, T + 6, c.sh);
    if (c.tie) for (let y = T + 1; y <= T + 6; y++) {
      set(b, 8, y, c.tie);
      set(b, 9, y, c.tie);
    }
  } },
  blazer_tee: { draw(b, T, c) {
    const inner = c.c2 ?? IVORY;
    rect(b, 7, T, 10, T + 6, inner);
    set(b, 8, T, shades(inner)[2]);
    set(b, 9, T, shades(inner)[2]);
    for (const [x, y] of [[6, T], [11, T], [7, T + 1], [10, T + 1]]) set(b, x, y, c.sh);
  } },
  turtleneck: { over(b, c) {
    rect(b, 6, 17, 11, 18, c.base);
    for (const x of [7, 8, 9, 10]) set(b, x, 17, c.hi);
    set(b, 6, 17, c.sh);
    set(b, 11, 17, c.sh);
    set(b, 11, 18, c.sh);
  } },
  hoodie: {
    draw(b, T, c) {
      for (const x of [7, 10]) for (let y = T + 1; y <= T + 3; y++) set(b, x, y, c.hi);
      rect(b, 6, T + 5, 11, T + 5, c.sh);
      set(b, 6, T + 6, c.sh);
      set(b, 11, T + 6, c.sh);
    },
    over(b, c, scene) {
      const x0 = scene ? 5 : 6, x1 = scene ? 12 : 11;
      rect(b, x0, 17, 6, 17, c.base);
      rect(b, 11, 17, x1, 17, c.base);
      rect(b, x0 - 1, 18, 7, 18, c.base);
      rect(b, 10, 18, x1 + 1, 18, c.base);
      set(b, x0 - 1, 18, c.sh);
      set(b, x1 + 1, 18, c.sh);
      set(b, 8, 18, c.skin.sh);
      set(b, 9, 18, c.skin.sh);
    }
  },
  boatneck: { draw(b, T, c) {
    for (const x of [6, 7, 8, 9, 10, 11]) set(b, x, T, c.skin.sh);
    for (let x = 5; x <= 12; x++) onBase(b, x, T + 1, c.base, c.hi);
  } },
  dress: {
    draw(b, T, c) {
      set(b, 8, T, c.skin.sh);
      set(b, 9, T, c.skin.sh);
      set(b, 7, T, c.sh);
      set(b, 10, T, c.sh);
      for (let x = 5; x <= 12; x++) onBase(b, x, T + 5, c.base, c.sh);
    },
    skirt(b, c) {
      const x0 = c.heavy ? 3 : 4, x1 = c.heavy ? 14 : 13;
      rect(b, x0, 25, x1, 28, c.base);
      for (let y = 25; y <= 28; y++) {
        set(b, x0, y, c.hi);
        set(b, x1, y, c.sh);
        set(b, x1 - 1, y, c.sh);
      }
    }
  },
  wrap: { draw(b, T, c) {
    for (const [x, y] of [[5, T], [6, T + 1], [7, T + 2], [8, T + 3], [12, T], [11, T + 1], [10, T + 2], [9, T + 3]]) set(b, x, y, c.sh);
    for (const [x, y] of [[7, T], [8, T], [9, T], [10, T], [8, T + 1], [9, T + 1]]) set(b, x, y, c.skin.sh);
    for (let x = 6; x <= 11; x++) onBase(b, x, T + 5, c.base, c.hi);
  } },
  blazer_w: { draw(b, T, c) {
    const inner = c.c2 ?? IVORY;
    for (let y = T + 1; y <= T + 6; y++) {
      set(b, 8, y, inner);
      set(b, 9, y, inner);
    }
    set(b, 8, T, c.skin.sh);
    set(b, 9, T, c.skin.sh);
    for (const [x, y] of [[6, T], [11, T], [7, T + 1], [10, T + 1]]) set(b, x, y, c.sh);
  } },
  stripe_tee: { draw(b, T, c) {
    for (const x of [7, 8, 9, 10]) set(b, x, T, c.sh);
    const st = c.c2 ?? IVORY;
    for (const y of [T + 2, T + 4, T + 6]) for (let x = 4; x <= 13; x++) onBase(b, x, y, c.base, st);
  } },
  cami: { draw(b, T, c) {
    for (const x of [7, 8, 9, 10]) set(b, x, T, c.skin.sh);
    for (const [x, y] of [[4, T + 1], [5, T + 1], [12, T + 1], [13, T + 1], [3, T + 2], [4, T + 2], [13, T + 2], [14, T + 2]]) onBase(b, x, y, c.base, c.skin.base);
    for (const [x, y] of [[13, T + 1], [14, T + 2]]) onBase(b, x, y, c.skin.base, c.skin.sh);
  } },
  sweater_v: { draw(b, T, c) {
    const inner = c.c2 ?? W;
    for (const [x, y] of [[7, T], [8, T], [9, T], [10, T], [8, T + 1], [9, T + 1]]) set(b, x, y, inner);
    for (const [x, y] of [[6, T], [11, T], [7, T + 1], [10, T + 1], [8, T + 2], [9, T + 2]]) set(b, x, y, c.sh);
  } },
  shirt_w: { draw(b, T, c) {
    for (const [x, y] of [[6, T], [11, T]]) set(b, x, y, c.hi);
    for (const [x, y] of [[7, T], [10, T]]) set(b, x, y, c.sh);
    set(b, 8, T, c.skin.sh);
    set(b, 9, T, c.skin.sh);
    for (let y = T + 1; y <= T + 6; y += 2) set(b, 8, y, c.sh);
  } }
};
function garmentCtx(r) {
  const [hi, base, sh] = shades(r.c1);
  return { hi, base, sh, c1: r.c1, c2: r.c2, tie: r.tie, skin: skinPal(r.skin), heavy: r.face === "heavy" };
}
const SHOE = [44, 40, 48];
function drawSceneLegs(buf, pants, phase) {
  const [, base, sh] = shades(pants);
  for (const [lx0, lx1] of [[5, 7], [10, 12]]) {
    rect(buf, lx0, 25, lx1, 30, base);
    for (let y = 25; y <= 30; y++) set(buf, lx1, y, sh);
  }
  const leftLow = phase !== 1, rightLow = phase !== 2;
  rect(buf, 5, leftLow ? 31 : 30, 7, leftLow ? 31 : 30, SHOE);
  rect(buf, 10, rightLow ? 31 : 30, 12, rightLow ? 31 : 30, SHOE);
}
function drawSceneTorso(buf, r, back) {
  const [hi, base, sh] = shades(r.c1);
  if (r.heavy) {
    rect(buf, 3, 18, 14, 18, base);
    rect(buf, 2, 19, 15, 19, base);
    rect(buf, 2, 20, 15, 24, base);
    for (let y = 20; y <= 24; y++) {
      set(buf, 2, y, sh);
      set(buf, 15, y, sh);
      set(buf, 14, y, sh);
    }
  } else {
    rect(buf, 4, 18, 13, 18, base);
    rect(buf, 3, 19, 14, 19, base);
    rect(buf, 4, 20, 13, 24, base);
    for (let y = 20; y <= 24; y++) {
      set(buf, 3, y, sh);
      set(buf, 14, y, sh);
      set(buf, 13, y, sh);
    }
  }
  if (back) {
    rect(buf, 6, 18, 11, 18, sh);
    for (let y = 19; y <= 24; y++) set(buf, 8, y, sh);
    return;
  }
  const skin = skinPal(r.skin);
  if (r.cloth === "suit") {
    const white = [238, 238, 236];
    for (const [x, y] of [[8, 18], [9, 18], [7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) set(buf, x, y, white);
    for (const [x, y] of [[6, 19], [7, 20], [11, 19], [10, 20]]) set(buf, x, y, sh);
    if (r.tie) {
      for (let y = 19; y <= 24; y++) {
        set(buf, 8, y, r.tie);
        set(buf, 9, y, r.tie);
      }
      set(buf, 8, 19, shades(r.tie)[0]);
    }
  } else if (r.cloth === "dressshirt") {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18], [7, 19], [10, 19]]) set(buf, x, y, sh);
    if (r.tie) for (let y = 18; y <= 24; y++) {
      set(buf, 8, y, r.tie);
      set(buf, 9, y, r.tie);
    }
    else for (let y = 20; y <= 24; y += 2) set(buf, 8, y, sh);
  } else if (r.cloth === "polo") {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) set(buf, x, y, hi);
    set(buf, 8, 19, sh);
    set(buf, 8, 21, sh);
  } else if (r.cloth === "blouse") {
    for (const [x, y] of [[7, 18], [8, 18], [9, 18], [10, 18], [8, 19], [9, 19]]) set(buf, x, y, skin.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 19), base)) set(buf, x, 19, hi);
  } else if (r.cloth === "cardigan") {
    const inner = r.c2 ? shades(r.c2)[1] : [235, 233, 226];
    for (let y = 18; y <= 24; y++) {
      set(buf, 8, y, inner);
      set(buf, 9, y, inner);
    }
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) set(buf, x, y, sh);
  } else if (r.cloth === "sweater") {
    for (const [x, y] of [[6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18]]) set(buf, x, y, sh);
  }
}
function drawHeadBack(buf, r) {
  const s = skinPal(r.skin);
  if (r.hair === "styleBald") {
    drawHeadBackBald(buf, r);
    return;
  }
  const [hi, base, sh] = shades(r.hairc);
  const rows = [
    [2, 6, 11],
    [3, 5, 12],
    [4, 4, 13],
    [5, 4, 13],
    [6, 4, 13],
    [7, 4, 13],
    [8, 4, 13],
    [9, 4, 13],
    [10, 4, 13],
    [11, 4, 13],
    [12, 4, 13],
    [13, 5, 12],
    [14, 6, 11]
  ];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  const len = r.hair === "styleFrame" ? r.hairargs?.length ?? 17 : r.hair === "styleMessy" ? r.hairargs?.length ?? 9 : 0;
  for (let y = 11; y <= len; y++) {
    set(buf, HX0 - 1, y, base);
    set(buf, HX0, y, base);
    set(buf, HX1, y, base);
    set(buf, HX1 + 1, y, base);
  }
  for (let y = 4; y <= 12; y++) {
    set(buf, 4, y, sh);
    set(buf, 13, y, sh);
  }
  for (const [x, y] of [[5, 3], [12, 3], [5, 13], [12, 13], [6, 14], [11, 14]]) set(buf, x, y, sh);
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [10, 2], [7, 3], [8, 3], [9, 3]]) set(buf, x, y, hi);
  for (let y = 4; y <= 11; y++) set(buf, 9, y, hi);
  for (let y = 4; y <= 12; y++) set(buf, 8, y, sh);
  rect(buf, 7, 14, 10, 14, sh);
  rect(buf, 7, 15, 10, 17, s.sh);
  rect(buf, 7, 15, 9, 15, s.base);
}
function drawHeadBackBald(buf, r) {
  const s = skinPal(r.skin);
  const [shi, sbase, ssh] = shades(s.base, 1.1, 0.82);
  const rows = [
    [2, 6, 11],
    [3, 5, 12],
    [4, 4, 13],
    [5, 4, 13],
    [6, 4, 13],
    [7, 4, 13],
    [8, 4, 13],
    [9, 4, 13],
    [10, 4, 13],
    [11, 4, 13],
    [12, 4, 13],
    [13, 5, 12],
    [14, 6, 11]
  ];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, sbase);
  for (let y = 4; y <= 12; y++) {
    set(buf, 4, y, ssh);
    set(buf, 13, y, ssh);
  }
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [8, 3], [9, 4], [9, 5]]) set(buf, x, y, shi);
  const [, base, sh] = shades(r.hairc);
  for (let x = 4; x <= 13; x++) {
    set(buf, x, 11, base);
    set(buf, x, 12, base);
  }
  for (const x of [4, 13]) {
    set(buf, x, 11, sh);
    set(buf, x, 12, sh);
  }
  rect(buf, 7, 14, 10, 14, s.sh);
  rect(buf, 7, 15, 10, 17, s.sh);
  rect(buf, 7, 15, 9, 15, s.base);
}
function drawHeadBackAny(buf, r) {
  const [hi, base, sh] = shades(r.hairc);
  const s = skinPal(r.skin);
  if (r.hair === "styleBuzz" || r.hair === "styleMohawk") {
    drawHeadBackBald(buf, r);
    const c = mix(base, s.base, r.hair === "styleBuzz" ? 0.45 : 0.5);
    for (let y = 2; y <= 12; y++) for (let x = 4; x <= 13; x++) {
      if (alphaAt(buf, x, y) === 255 && !eq(rgbAt(buf, x, y), s.sh)) set(buf, x, y, c);
    }
    if (r.hair === "styleMohawk") {
      rect(buf, 8, 1, 9, 12, base);
      set(buf, 8, 1, hi);
      set(buf, 8, 2, hi);
    }
    return;
  }
  drawHeadBack(buf, r);
  if (r.hair === "styleLong") {
    const len = r.hairargs?.length ?? 23;
    for (let y = 11; y <= len; y++) {
      set(buf, 2, y, base);
      set(buf, 3, y, base);
      set(buf, 4, y, base);
      set(buf, 13, y, sh);
      set(buf, 14, y, sh);
      set(buf, 15, y, sh);
    }
    for (let y = 15; y <= len; y++) for (let x = 5; x <= 12; x++) set(buf, x, y, x === 8 ? sh : base);
  } else if (r.hair === "styleAfro") {
    rect(buf, 5, 0, 12, 0, base);
    rect(buf, 3, 1, 14, 1, base);
    rect(buf, 2, 2, 15, 3, base);
    for (let y = 4; y <= 12; y++) {
      rect(buf, 2, y, 3, y, base);
      rect(buf, 14, y, 15, y, sh);
    }
    for (let y = 2; y <= 13; y++) set(buf, 15, y, sh);
    for (const [x, y] of [[5, 0], [6, 0], [3, 1], [2, 2], [2, 3]]) set(buf, x, y, hi);
  }
}
function outlinePass(buf) {
  const pts = [];
  for (let y = 0; y < CUR_H; y++) {
    for (let x = 0; x < CUR_W; x++) {
      if (alphaAt(buf, x, y) !== 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (alphaAt(buf, x + dx, y + dy) === 255) {
          pts.push([x, y]);
          break;
        }
      }
    }
  }
  for (const [x, y] of pts) set(buf, x, y, OUTLINE);
}
const CAST_RECIPES = {
  michael: { skin: "light", hairc: [58, 42, 28], hair: "styleShort", hairargs: { part: "L" }, cloth: "suit", c1: [58, 63, 74], tie: [170, 58, 58], brow: "flat", mouth: "smile" },
  jim: { skin: "light", hairc: [92, 60, 34], hair: "styleFloppy", cloth: "dressshirt", c1: [172, 196, 224], tie: [120, 130, 150], brow: "flat", mouth: "smile" },
  pam: { skin: "light", hairc: [120, 76, 42], hair: "styleFrame", hairargs: { length: 18, vol: 2 }, cloth: "cardigan", c1: [236, 174, 192], c2: [244, 242, 238], brow: "soft", mouth: "smile", blush: true, lashes: true },
  dwight: { skin: "light", hairc: [64, 48, 28], hair: "styleShort", hairargs: { part: "L", recede: 1 }, cloth: "dressshirt", c1: [184, 155, 62], tie: [120, 82, 46], glasses: true, brow: "angry", mouth: "neutral" },
  kevin: { skin: "light", hairc: [58, 44, 30], hair: "styleBald", cloth: "polo", c1: [110, 140, 180], c2: [90, 120, 160], brow: "flat", mouth: "neutral", heavy: true },
  angela: { skin: "light", hairc: [186, 154, 90], hair: "styleBun", cloth: "cardigan", c1: [150, 146, 170], c2: [235, 233, 226], brow: "angry", mouth: "frown", lashes: true },
  oscar: { skin: "tan", hairc: [28, 22, 18], hair: "styleShort", hairargs: { part: "L" }, cloth: "sweater", c1: [122, 60, 74], brow: "flat", mouth: "smile" },
  stanley: { skin: "dark", hairc: [60, 54, 48], hair: "styleRecede", cloth: "dressshirt", c1: [150, 120, 86], tie: [120, 78, 52], glasses: true, facial: "mustache", brow: "flat", mouth: "neutral", heavy: true },
  phyllis: { skin: "light", hairc: [196, 162, 110], hair: "styleCurly", cloth: "blouse", c1: [202, 160, 192], glasses: true, brow: "soft", mouth: "smile", lashes: true, heavy: true },
  andy: { skin: "light", hairc: [74, 51, 32], hair: "styleShort", hairargs: { part: "R" }, cloth: "polo", c1: [176, 65, 58], c2: [150, 50, 46], brow: "raised", mouth: "smile" },
  kelly: { skin: "tan", hairc: [24, 18, 22], hair: "styleFrame", hairargs: { length: 20, vol: 1 }, cloth: "blouse", c1: [212, 90, 158], brow: "soft", mouth: "smile", blush: true, lashes: true },
  ryan: { skin: "light", hairc: [42, 32, 24], hair: "styleSpiky", cloth: "suit", c1: [58, 58, 68], tie: [40, 40, 50], brow: "flat", mouth: "neutral" },
  toby: { skin: "light", hairc: [106, 90, 66], hair: "styleShort", hairargs: { part: "L", recede: 1 }, cloth: "dressshirt", c1: [150, 150, 120], facial: "mustacheSm", brow: "soft", mouth: "frown" },
  creed: { skin: "light", hairc: [170, 166, 156], hair: "styleBald", cloth: "dressshirt", c1: [126, 130, 96], facial: "stubble", brow: "flat", mouth: "neutral" },
  meredith: { skin: "light", hairc: [154, 82, 46], hair: "styleMessy", hairargs: { length: 15 }, cloth: "blouse", c1: [176, 86, 74], brow: "raised", mouth: "smile", lashes: true }
};
function resolveRecipe(name) {
  const builtin = CAST_RECIPES[name];
  if (builtin) return builtin;
  if (isCustomAvatarId(name)) {
    const a = getCustomAvatar(name.slice(CUSTOM_PREFIX.length));
    if (a) return a.recipe;
  }
  const p = presetIndexOf(name);
  if (p !== null) return presetRecipe(p);
  return CAST_RECIPES.jim;
}
function drawHeadGroup(buf, r) {
  const skinBase = skinPal(r.skin).base;
  drawHead(buf, r.skin);
  drawFaceShape(buf, r.skin, r.face ?? "oval");
  drawFace(buf, r);
  if (r.facial) drawFacial(buf, r.facial, r.hairc);
  HAIR_FNS[r.hair](buf, r.hairc, skinBase, r.hairargs ?? {});
  if (r.glasses) drawGlasses(buf);
}
function defaultPants(r) {
  if (r.pants) return r.pants;
  return r.cloth === "suit" ? shades(r.c1)[2] : [54, 56, 70];
}
function compose(r, costume = null) {
  CUR_W = PORTRAIT_W;
  CUR_H = PORTRAIT_H;
  const buf = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  if (costume) r = migrateRecipe(costumeRecipe(r, costume));
  const c = garmentCtx(r);
  const art = GARMENT_ART[r.cloth];
  drawClothing(buf, r.cloth, r.c1, r.c2, r.tie, r.skin, c.heavy);
  art?.draw?.(buf, 19, c);
  collarNeck(buf, r.skin);
  drawHeadGroup(buf, r);
  art?.over?.(buf, c, false);
  if (costume) paintCostume(pxFor(buf), costume, { T: 19, scene: false, back: false, r });
  outlinePass(buf);
  return buf;
}
function composeScene(r, phase, back, costume = null) {
  CUR_W = SCENE_W;
  CUR_H = SCENE_H;
  const buf = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  if (costume) r = migrateRecipe(costumeRecipe(r, costume));
  const c = garmentCtx(r);
  const art = GARMENT_ART[r.cloth];
  drawSceneTorso(buf, r, back);
  if (!back) art?.draw?.(buf, 18, c);
  drawSceneLegs(buf, defaultPants(r), phase);
  art?.skirt?.(buf, c);
  if (back) drawHeadBackAny(buf, r);
  else drawHeadGroup(buf, r);
  if (!back) art?.over?.(buf, c, true);
  if (costume) paintCostume(pxFor(buf), costume, { T: 18, scene: true, back, r });
  outlinePass(buf);
  return buf;
}
const CACHE_CAP = 512;
const bufCache = /* @__PURE__ */ new Map();
const sceneCache = /* @__PURE__ */ new Map();
function pxFor(buf) {
  return {
    w: CUR_W,
    h: CUR_H,
    set: (x, y, c) => set(buf, x, y, c),
    clear: (x, y) => clear(buf, x, y),
    alpha: (x, y) => alphaAt(buf, x, y),
    rgb: (x, y) => rgbAt(buf, x, y)
  };
}
function costumesOn() {
  try {
    return globalThis.document?.documentElement?.dataset?.cthSeason === "halloween";
  } catch {
    return false;
  }
}
const CAST_NAME_OF = new Map(Object.entries(CAST_RECIPES).map(([n, r]) => [r, n]));
function costumeOf(recipe) {
  if (!costumesOn()) return null;
  const name = CAST_NAME_OF.get(recipe);
  return name && CAST_COSTUMES[name] || costumeForRecipe(recipe);
}
const cacheKey = (m, c) => c ? `${recipeKey(m)}|costume:${c}` : recipeKey(m);
function portraitBufFor(recipe) {
  const costume = costumeOf(recipe);
  const m = migrateRecipe(recipe);
  const k = cacheKey(m, costume);
  let buf = bufCache.get(k);
  if (!buf) {
    if (bufCache.size >= CACHE_CAP) bufCache.clear();
    buf = compose(m, costume);
    bufCache.set(k, buf);
  }
  return buf;
}
function portraitBuf(name) {
  return portraitBufFor(resolveRecipe(name));
}
function sceneFrameBufsFor(recipe) {
  const costume = costumeOf(recipe);
  const m = migrateRecipe(recipe);
  const k = cacheKey(m, costume);
  let frames = sceneCache.get(k);
  if (!frames) {
    if (sceneCache.size >= CACHE_CAP) sceneCache.clear();
    frames = {
      front: [0, 1, 2].map((ph) => composeScene(m, ph, false, costume)),
      back: [0, 1, 2].map((ph) => composeScene(m, ph, true, costume))
    };
    sceneCache.set(k, frames);
  }
  return frames;
}
function sceneFrameBufs(name) {
  return sceneFrameBufsFor(resolveRecipe(name));
}
function blit(ctx, buf, w, h, scale) {
  const stage = document.createElement("canvas");
  stage.width = w;
  stage.height = h;
  const sctx = stage.getContext("2d");
  const img = sctx.createImageData(w, h);
  img.data.set(buf);
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w * scale, h * scale);
  ctx.drawImage(stage, 0, 0, w, h, 0, 0, w * scale, h * scale);
}
function paintPortrait(ctx, name, scale = 2) {
  blit(ctx, portraitBuf(name), PORTRAIT_W, PORTRAIT_H, scale);
}
function paintRecipe(ctx, recipe, scale = 2) {
  blit(ctx, portraitBufFor(recipe), PORTRAIT_W, PORTRAIT_H, scale);
}
function paintSceneFrame(ctx, recipe, phase, back, scale = 2) {
  const frames = sceneFrameBufsFor(recipe);
  blit(ctx, (back ? frames.back : frames.front)[phase], SCENE_W, SCENE_H, scale);
}
export {
  CAST_RECIPES,
  PORTRAIT_H,
  PORTRAIT_W,
  SCENE_H,
  SCENE_W,
  SKIN_SWATCHES,
  costumeOf,
  costumesOn,
  paintPortrait,
  paintRecipe,
  paintSceneFrame,
  portraitBuf,
  portraitBufFor,
  resolveRecipe,
  sceneFrameBufs,
  sceneFrameBufsFor
};
