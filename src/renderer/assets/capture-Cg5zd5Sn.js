import { q as useTranslation, m as reactExports, k as jsxRuntimeExports, a as createRoot } from "./index-CsK_GEYj.js";
/* empty css                */
import { u as clampRegion, R as REGION_MIN } from "./puck-HlPOn73L.js";
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CURSOR = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
function resized(from, handle, dx, dy) {
  let { x, y, width, height } = from;
  if (handle.includes("e")) width = from.width + dx;
  if (handle.includes("s")) height = from.height + dy;
  if (handle.includes("w")) {
    x = from.x + dx;
    width = from.width - dx;
  }
  if (handle.includes("n")) {
    y = from.y + dy;
    height = from.height - dy;
  }
  if (width < REGION_MIN) {
    if (handle.includes("w")) x = from.x + from.width - REGION_MIN;
    width = REGION_MIN;
  }
  if (height < REGION_MIN) {
    if (handle.includes("n")) y = from.y + from.height - REGION_MIN;
    height = REGION_MIN;
  }
  return { x, y, width, height };
}
function CaptureApp() {
  const { t } = useTranslation();
  const [canvas, setCanvas] = reactExports.useState(null);
  const [region, setRegion] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const gesture = reactExports.useRef(null);
  reactExports.useEffect(() => window.cth.onPuckCaptureInit((init) => {
    setCanvas({ width: init.width, height: init.height });
    setRegion(init.region);
  }), []);
  const confirm = reactExports.useCallback(async () => {
    if (!region || busy) return;
    setBusy(true);
    const r = await window.cth.puckCaptureConfirm(region);
    if (!r.ok) setBusy(false);
  }, [region, busy]);
  const cancel = reactExports.useCallback(() => {
    void window.cth.puckCaptureCancel();
  }, []);
  reactExports.useEffect(() => window.cth.onPuckCaptureRequest(() => {
    void confirm();
  }), [confirm]);
  reactExports.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void confirm();
        return;
      }
      if (!region || !canvas) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (d[e.key]) {
        e.preventDefault();
        const [dx, dy] = d[e.key];
        setRegion(clampRegion({ ...region, x: region.x + dx, y: region.y + dy }, canvas.width, canvas.height));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [region, canvas, confirm, cancel]);
  const onDown = (e, g) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = g;
  };
  const onMove = (e) => {
    const g = gesture.current;
    if (!g || !canvas) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === "move") setRegion(clampRegion({ ...g.from, x: g.from.x + dx, y: g.from.y + dy }, canvas.width, canvas.height));
    else if (g.kind === "resize") setRegion(clampRegion(resized(g.from, g.handle, dx, dy), canvas.width, canvas.height));
    else {
      const x = Math.min(g.startX, e.clientX);
      const y = Math.min(g.startY, e.clientY);
      setRegion(clampRegion({ x, y, width: Math.abs(dx), height: Math.abs(dy) }, canvas.width, canvas.height));
    }
  };
  const onUp = () => {
    gesture.current = null;
  };
  if (!canvas || !region) return null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      style: { position: "absolute", inset: 0, fontFamily: "var(--cth-font-ui)", cursor: "crosshair", userSelect: "none" },
      onPointerDown: (e) => onDown(e, { kind: "draw", startX: e.clientX, startY: e.clientY }),
      onPointerMove: onMove,
      onPointerUp: onUp,
      onPointerCancel: onUp,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            style: {
              position: "absolute",
              left: region.x,
              top: region.y,
              width: region.width,
              height: region.height,
              boxShadow: "0 0 0 100000px rgba(26, 19, 32, 0.38)",
              outline: "1px solid #FFF8E7",
              outlineOffset: -1,
              cursor: "move"
            },
            onPointerDown: (e) => onDown(e, { kind: "move", startX: e.clientX, startY: e.clientY, from: region }),
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { position: "absolute", inset: 0, border: "1px dashed rgba(26,19,32,0.55)" } }),
              HANDLES.map((h) => {
                const cx = h.includes("w") ? 0 : h.includes("e") ? region.width : region.width / 2;
                const cy = h.includes("n") ? 0 : h.includes("s") ? region.height : region.height / 2;
                return /* @__PURE__ */ jsxRuntimeExports.jsx(
                  "div",
                  {
                    role: "presentation",
                    style: { position: "absolute", left: cx - 6, top: cy - 6, width: 12, height: 12, borderRadius: 3, background: "#FFF8E7", border: "1px solid #1A1320", cursor: CURSOR[h] },
                    onPointerDown: (e) => onDown(e, { kind: "resize", handle: h, startX: e.clientX, startY: e.clientY, from: region })
                  },
                  h
                );
              }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { position: "absolute", left: 0, top: -24, fontSize: 11, fontVariantNumeric: "tabular-nums", color: "#FFF8E7", textShadow: "0 1px 2px rgba(26,19,32,0.9)", whiteSpace: "nowrap" }, children: [
                region.width,
                " × ",
                region.height
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", padding: "6px 12px", borderRadius: 999, background: "rgba(26,19,32,0.82)", color: "#FFF8E7", fontSize: 12, whiteSpace: "nowrap" }, children: busy ? t("pro.puck.capture.capturing") : t("pro.puck.capture.hint") })
      ]
    }
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("No root element");
createRoot(root).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(CaptureApp, {}) })
);
