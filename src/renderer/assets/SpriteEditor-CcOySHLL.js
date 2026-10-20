import { m as reactExports, k as jsxRuntimeExports, q as useTranslation } from "./index-CsK_GEYj.js";
import { b as PixelPanel, P as PixelButton } from "./index-CYoBaPLy.js";
import { paintSceneFrame, paintRecipe, SKIN_SWATCHES, SCENE_H, SCENE_W } from "./portraitArt-Bz9wz1UV.js";
import { bj as recipeKey, b6 as migrateRecipe, bS as wardrobeOf, Z as MAX_AVATAR_NAME, bi as randomRecipe, a5 as PRESET_COUNT, be as presetRecipe, ag as SKINS, F as FACES, E as EYES, x as EYE_COLOURS, bl as rgbToHex, B as BROWS, a1 as NOSES, _ as MOUTHS, X as LIP_COLOURS, y as FACIALS, M as HAIR_LABELS, N as HAIR_STYLES, L as HAIR_COLOURS, H as GARMENTS_MEN, I as GARMENTS_WOMEN, J as GARMENT_LABELS, h as CLOTH_COLOURS, O as HAS_C2, P as HAS_TIE, au as TIE_COLOURS, aw as TROUSER_COLOURS, a3 as PORTRAIT_H, a4 as PORTRAIT_W, aV as hexToRgb } from "./global-eDtrx50m.js";
import "./PuckFace-CCZUmqjS.js";
import "./puck-HlPOn73L.js";
const FACE_TITLES = { oval: "Oval", round: "Round", square: "Square", long: "Long", heart: "Heart", heavy: "Heavy" };
const EYE_TITLES = { normal: "Normal", wide: "Wide", dot: "Dot", squint: "Squint", happy: "Happy", lashed: "Lashed" };
const BROW_TITLES = { flat: "Flat", angry: "Angry", raised: "Raised", soft: "Soft", thick: "Thick", arched: "Arched" };
const NOSE_TITLES = { small: "Small", normal: "Normal", long: "Long", wide: "Wide" };
const MOUTH_TITLES = { neutral: "Neutral", smile: "Smile", frown: "Frown", grin: "Grin", open: "Open", smirk: "Smirk" };
const FACIAL_TITLES = { mustache: "Moustache", mustacheSm: "Small moustache", stubble: "Stubble", goatee: "Goatee" };
function SpriteEditor({ mode, initialName = "", initialRecipe, accent = "sky", onSave, onDelete, onClose, inline = false }) {
  const { t } = useTranslation();
  const [name, setName] = reactExports.useState(initialName);
  const [recipe, setRecipeState] = reactExports.useState(() => migrateRecipe(initialRecipe));
  const [wardrobe, setWardrobe] = reactExports.useState(() => wardrobeOf(initialRecipe.cloth));
  const [presetsOpen, setPresetsOpen] = reactExports.useState(false);
  const [confirmDelete, setConfirmDelete] = reactExports.useState(false);
  const [busy, setBusy] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const setRecipe = (patch) => setRecipeState((r) => migrateRecipe({ ...r, ...patch }));
  const setGarment = (cloth) => setRecipeState((r) => {
    const next = { ...r, cloth };
    if (!HAS_C2.has(cloth)) delete next.c2;
    if (!HAS_TIE.has(cloth)) delete next.tie;
    return migrateRecipe(next);
  });
  reactExports.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), recipe);
    } catch {
      setError(t("avatars.editor.saveFailed"));
      setBusy(false);
    }
  };
  const del = async () => {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch {
      setError(t("avatars.editor.saveFailed"));
      setBusy(false);
    }
  };
  const garments = wardrobe === "men" ? GARMENTS_MEN : GARMENTS_WOMEN;
  const noFacial = !recipe.facial;
  const panel = /* @__PURE__ */ jsxRuntimeExports.jsxs(
    PixelPanel,
    {
      variant: "dialog",
      title: mode === "edit" ? t("avatars.editor.titleEdit") : t("avatars.editor.title"),
      accent,
      style: { width: inline ? "100%" : "min(940px, 94vw)", height: inline ? "100%" : "min(660px, 88vh)", display: "flex", flexDirection: "column" },
      noPadding: true,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: {
            width: 236,
            flex: "0 0 auto",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "inset -1px 0 0 var(--cth-ink-100)",
            overflowY: "auto"
          }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: capStyle, children: t("avatars.editor.name") }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "input",
                {
                  value: name,
                  onChange: (e) => setName(e.target.value),
                  placeholder: t("avatars.editor.namePlaceholder"),
                  maxLength: MAX_AVATAR_NAME,
                  style: inputStyle,
                  autoFocus: mode === "create"
                }
              )
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 14, alignItems: "flex-end" }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: capStyle, children: t("avatars.editor.preview") }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: previewBox, children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe, scale: 5 }) })
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: capStyle, children: t("avatars.editor.onTheFloor") }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: previewBox, children: /* @__PURE__ */ jsxRuntimeExports.jsx(WalkPreview, { recipe, scale: 2 }) })
              ] })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "sm", variant: "secondary", onClick: () => setRecipeState(randomRecipe(Date.now() % 2147483647, wardrobe)), children: t("avatars.editor.randomise") }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "sm", variant: "secondary", onClick: () => setPresetsOpen((o) => !o), children: t("avatars.editor.presets") })
            ] }),
            presetsOpen && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" }, children: Array.from({ length: PRESET_COUNT }, (_, n) => /* @__PURE__ */ jsxRuntimeExports.jsx(
              OptionTile,
              {
                active: false,
                accent,
                title: t("avatars.picker.preset", { n: n + 1 }),
                onClick: () => {
                  const r = presetRecipe(n);
                  setRecipeState(r);
                  setWardrobe(wardrobeOf(r.cloth));
                },
                children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe: presetRecipe(n), scale: 1.5 })
              },
              n
            )) })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { flex: 1, minWidth: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label: t("avatars.editor.skin"), children: SKINS.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsx(Swatch, { rgb: SKIN_SWATCHES[s], active: recipe.skin === s, title: s, onClick: () => setRecipe({ skin: s }) }, s)) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.faceShape"),
                accent,
                recipe,
                options: FACES,
                titles: FACE_TITLES,
                value: recipe.face ?? "oval",
                variant: (face) => ({ face }),
                onPick: (face) => setRecipe({ face })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.eyes"),
                accent,
                recipe,
                options: EYES,
                titles: EYE_TITLES,
                value: recipe.eyes ?? "normal",
                variant: (eyes) => ({ eyes }),
                onPick: (eyes) => setRecipe({ eyes })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label: t("avatars.editor.eyeColour"), children: EYE_COLOURS.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
              Swatch,
              {
                rgb: c,
                active: sameRgb(recipe.eyec ?? EYE_COLOURS[0], c),
                title: rgbToHex(c),
                onClick: () => setRecipeState((r) => {
                  const n = { ...r };
                  if (i === 0) delete n.eyec;
                  else n.eyec = c;
                  return n;
                })
              },
              i
            )) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.brows"),
                accent,
                recipe,
                options: BROWS,
                titles: BROW_TITLES,
                value: recipe.brow ?? "flat",
                variant: (brow) => ({ brow }),
                onPick: (brow) => setRecipe({ brow })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.nose"),
                accent,
                recipe,
                options: NOSES,
                titles: NOSE_TITLES,
                value: recipe.nose ?? "normal",
                variant: (nose) => ({ nose }),
                onPick: (nose) => setRecipe({ nose })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.mouth"),
                accent,
                recipe,
                options: MOUTHS,
                titles: MOUTH_TITLES,
                value: recipe.mouth ?? "neutral",
                variant: (mouth) => ({ mouth }),
                onPick: (mouth) => setRecipe({ mouth })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label: t("avatars.editor.lipColour"), children: LIP_COLOURS.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
              Swatch,
              {
                rgb: c,
                active: sameRgb(recipe.mouthc ?? LIP_COLOURS[0], c),
                title: rgbToHex(c),
                onClick: () => setRecipeState((r) => {
                  const n = { ...r };
                  if (i === 0) delete n.mouthc;
                  else n.mouthc = c;
                  return n;
                })
              },
              i
            )) }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.extras"), children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Toggle, { on: !!recipe.blush, label: t("avatars.editor.blush"), onClick: () => setRecipe({ blush: !recipe.blush }) }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(Toggle, { on: !!recipe.glasses, label: t("avatars.editor.glasses"), onClick: () => setRecipe({ glasses: !recipe.glasses }) })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.facialHair"), children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                OptionTile,
                {
                  active: noFacial,
                  accent,
                  title: t("avatars.editor.none"),
                  onClick: () => setRecipeState((r) => {
                    const n = { ...r };
                    delete n.facial;
                    return n;
                  }),
                  children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe: { ...recipe, facial: void 0 }, scale: 2 })
                }
              ),
              FACIALS.map((f) => /* @__PURE__ */ jsxRuntimeExports.jsx(OptionTile, { active: recipe.facial === f, accent, title: FACIAL_TITLES[f], onClick: () => setRecipe({ facial: f }), children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe: { ...recipe, facial: f }, scale: 2 }) }, f))
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              Pictures,
              {
                label: t("avatars.editor.hair"),
                accent,
                recipe,
                options: HAIR_STYLES,
                titles: HAIR_LABELS,
                value: recipe.hair,
                variant: (hair) => ({ hair }),
                onPick: (hair) => setRecipe({ hair })
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.hairColour"), children: [
              Object.entries(HAIR_COLOURS).map(([k, c]) => /* @__PURE__ */ jsxRuntimeExports.jsx(Swatch, { rgb: c, active: sameRgb(recipe.hairc, c), title: k, onClick: () => setRecipe({ hairc: c }) }, k)),
              /* @__PURE__ */ jsxRuntimeExports.jsx(HexInput, { label: t("avatars.editor.hex"), value: recipe.hairc, onChange: (c) => setRecipe({ hairc: c }) })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.wardrobe"), children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(Toggle, { on: wardrobe === "men", label: t("avatars.editor.men"), onClick: () => setWardrobe("men") }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(Toggle, { on: wardrobe === "women", label: t("avatars.editor.women"), onClick: () => setWardrobe("women") })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label: t("avatars.editor.garment"), children: garments.map((g) => /* @__PURE__ */ jsxRuntimeExports.jsx(OptionTile, { active: recipe.cloth === g, accent, title: GARMENT_LABELS[g], onClick: () => setGarment(g), children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe: { ...recipe, cloth: g }, scale: 2 }) }, g)) }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.colour"), children: [
              Object.entries(CLOTH_COLOURS).map(([k, c]) => /* @__PURE__ */ jsxRuntimeExports.jsx(Swatch, { rgb: c, active: sameRgb(recipe.c1, c), title: k, onClick: () => setRecipe({ c1: c }) }, k)),
              /* @__PURE__ */ jsxRuntimeExports.jsx(HexInput, { label: t("avatars.editor.hex"), value: recipe.c1, onChange: (c) => setRecipe({ c1: c }) })
            ] }),
            HAS_C2.has(recipe.cloth) && /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.secondColour"), children: [
              Object.entries(CLOTH_COLOURS).map(([k, c]) => /* @__PURE__ */ jsxRuntimeExports.jsx(Swatch, { rgb: c, active: !!recipe.c2 && sameRgb(recipe.c2, c), title: k, onClick: () => setRecipe({ c2: c }) }, k)),
              /* @__PURE__ */ jsxRuntimeExports.jsx(HexInput, { label: t("avatars.editor.hex"), value: recipe.c2 ?? CLOTH_COLOURS.cream, onChange: (c) => setRecipe({ c2: c }) })
            ] }),
            HAS_TIE.has(recipe.cloth) && /* @__PURE__ */ jsxRuntimeExports.jsxs(Section, { label: t("avatars.editor.tie"), children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                Toggle,
                {
                  on: !recipe.tie,
                  label: t("avatars.editor.noTie"),
                  onClick: () => setRecipeState((r) => {
                    const n = { ...r };
                    delete n.tie;
                    return n;
                  })
                }
              ),
              TIE_COLOURS.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(Swatch, { rgb: c, active: !!recipe.tie && sameRgb(recipe.tie, c), title: rgbToHex(c), onClick: () => setRecipe({ tie: c }) }, i))
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label: t("avatars.editor.trousers"), children: TROUSER_COLOURS.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
              Swatch,
              {
                rgb: c,
                active: sameRgb(recipe.pants ?? TROUSER_COLOURS[0], c),
                title: rgbToHex(c),
                onClick: () => setRecipeState((r) => {
                  const n = { ...r };
                  if (i === 0) delete n.pants;
                  else n.pants = c;
                  return n;
                })
              },
              i
            )) })
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          boxShadow: "inset 0 1px 0 var(--cth-ink-100)"
        }, children: [
          mode === "edit" && onDelete && (confirmDelete ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontFamily: "var(--cth-font-ui)", fontSize: 12, color: "var(--cth-ink-700)" }, children: t("avatars.editor.deleteConfirm") }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "sm", variant: "destructive", onClick: () => {
              void del();
            }, disabled: busy, children: t("avatars.editor.delete") }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "sm", variant: "ghost", onClick: () => setConfirmDelete(false), children: t("avatars.editor.cancel") })
          ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "sm", variant: "ghost", onClick: () => setConfirmDelete(true), disabled: busy, children: t("avatars.editor.delete") })),
          error && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontFamily: "var(--cth-font-ui)", fontSize: 12, color: "var(--cth-status-blocked)" }, children: error }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 1 } }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "md", variant: "ghost", onClick: onClose, disabled: busy, children: t("avatars.editor.cancel") }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(PixelButton, { size: "md", variant: "primary", onClick: () => {
            void save();
          }, disabled: busy, children: t("avatars.editor.save") })
        ] })
      ]
    }
  );
  if (inline) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { width: "100%", height: "100%" }, children: panel });
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      onMouseDown: (e) => {
        if (e.target === e.currentTarget) onClose();
      },
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 600,
        background: "rgba(20, 18, 24, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      },
      children: panel
    }
  );
}
function RecipeCanvas({ recipe, scale, frame }) {
  const ref = reactExports.useRef(null);
  const key = reactExports.useMemo(() => recipeKey(recipe), [recipe]);
  const isScene = !!frame;
  const w = Math.round((isScene ? SCENE_W : PORTRAIT_W) * scale);
  const h = Math.round((isScene ? SCENE_H : PORTRAIT_H) * scale);
  reactExports.useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    if (frame) paintSceneFrame(ctx, recipe, frame.phase, frame.back, scale);
    else paintRecipe(ctx, recipe, scale);
  }, [key, scale, frame?.phase, frame?.back]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("canvas", { ref, width: w, height: h, style: { width: w, height: h, imageRendering: "pixelated", display: "block" } });
}
function WalkPreview({ recipe, scale }) {
  const [phase, setPhase] = reactExports.useState(0);
  reactExports.useEffect(() => {
    const seq = [0, 1, 0, 2];
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % seq.length;
      setPhase(seq[i]);
    }, 220);
    return () => clearInterval(id);
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 6, alignItems: "flex-end" }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe, scale, frame: { phase, back: false } }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe, scale, frame: { phase, back: true } })
  ] });
}
function Section({ label, children }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: capStyle, children: label }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }, children })
  ] });
}
function Pictures({ label, accent, recipe, options, titles, value, variant, onPick }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { label, children: options.map((opt) => /* @__PURE__ */ jsxRuntimeExports.jsx(OptionTile, { active: value === opt, accent, title: titles[opt], onClick: () => onPick(opt), children: /* @__PURE__ */ jsxRuntimeExports.jsx(RecipeCanvas, { recipe: { ...recipe, ...variant(opt) }, scale: 2 }) }, opt)) });
}
function OptionTile({ active, accent, title, onClick, children }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      type: "button",
      onClick,
      title,
      "aria-label": title,
      "aria-pressed": active,
      style: {
        padding: 3,
        border: "none",
        cursor: "pointer",
        background: active ? `var(--cth-${accent}-light)` : "var(--cth-cream-100)",
        boxShadow: active ? "inset 0 0 0 1.5px var(--cth-ink-500)" : "inset 0 0 0 1px var(--cth-ink-100)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center"
      },
      children
    }
  );
}
function Swatch({ rgb, active, title, onClick }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      type: "button",
      onClick,
      title,
      "aria-label": title,
      "aria-pressed": active,
      style: {
        width: 22,
        height: 22,
        padding: 0,
        border: "none",
        cursor: "pointer",
        background: rgbToHex(rgb),
        boxShadow: active ? "inset 0 0 0 2px var(--cth-paper-100), 0 0 0 1.5px var(--cth-ink-900)" : "inset 0 0 0 1px var(--cth-ink-300)"
      }
    }
  );
}
function Toggle({ on, label, onClick }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      type: "button",
      onClick,
      "aria-pressed": on,
      style: {
        padding: "3px 8px 1px",
        border: "none",
        cursor: "pointer",
        background: on ? "var(--cth-ink-900)" : "var(--cth-cream-100)",
        color: on ? "var(--cth-paper-100)" : "var(--cth-ink-900)",
        boxShadow: on ? "none" : "inset 0 0 0 1px var(--cth-ink-300)",
        fontFamily: "var(--cth-font-ui)",
        fontSize: 12
      },
      children: label
    }
  );
}
function HexInput({ label, value, onChange }) {
  const [text, setText] = reactExports.useState(rgbToHex(value));
  const current = rgbToHex(value);
  reactExports.useEffect(() => {
    setText(current);
  }, [current]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, marginInlineStart: 6 }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontFamily: "var(--cth-font-ui)", fontSize: 11, color: "var(--cth-ink-500)" }, children: label }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "input",
      {
        value: text,
        onChange: (e) => {
          setText(e.target.value);
          const c = hexToRgb(e.target.value);
          if (c) onChange(c);
        },
        spellCheck: false,
        style: { ...inputStyle, width: 82, fontFamily: "var(--cth-font-mono)", fontSize: 12, padding: "3px 6px 2px" }
      }
    )
  ] });
}
const sameRgb = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const capStyle = {
  fontFamily: "var(--cth-font-display)",
  fontSize: 8,
  lineHeight: "12px",
  color: "var(--cth-ink-700)",
  textTransform: "uppercase"
};
const inputStyle = {
  width: "100%",
  padding: "6px 8px 4px",
  boxSizing: "border-box",
  background: "var(--cth-paper-100)",
  border: "none",
  boxShadow: "inset 0 0 0 1px var(--cth-ink-100)",
  fontFamily: "var(--cth-font-ui)",
  fontSize: 16,
  color: "var(--cth-ink-900)",
  outline: "none"
};
const previewBox = {
  padding: 6,
  background: "var(--cth-cream-100)",
  boxShadow: "inset 0 0 0 1px var(--cth-ink-100)",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center"
};
export {
  RecipeCanvas,
  SpriteEditor
};
