import { m as reactExports, k as jsxRuntimeExports, i as instance, a as createRoot } from "./index-CsK_GEYj.js";
import { bJ as useDirectionSync, bQ as useStore, T as IdePanel, aD as adoptAppTheme, aC as adoptAppSkin } from "./global-eDtrx50m.js";
function IdeWindowRoot() {
  useDirectionSync();
  const [ready, setReady] = reactExports.useState(false);
  reactExports.useEffect(() => {
    let alive = true;
    const s = useStore.getState();
    s.setIdeDetached(true);
    void window.cth.ideHandoff().then(({ handoff, agents }) => {
      if (!alive) return;
      const st = useStore.getState();
      if (agents.length > 0) st.mirrorAgents(agents);
      st.setIdeHandoff(handoff);
      const byRoot = handoff?.root ? useStore.getState().agents.find((a) => a.cwd === handoff.root)?.id ?? null : null;
      st.setIdeOpen(true, handoff?.agentId ?? byRoot);
      setReady(true);
    }, () => {
      if (!alive) return;
      useStore.getState().setIdeOpen(true);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  reactExports.useEffect(() => window.cth.onIdeOpen((req) => {
    const st = useStore.getState();
    if (req.path) st.openFileInIde(req.path);
    else if (req.agentId) st.setIdeOpen(true, req.agentId);
  }), []);
  reactExports.useEffect(() => window.cth.onIdeAgents((list) => useStore.getState().mirrorAgents(list)), []);
  reactExports.useEffect(() => {
    void window.cth.getConfig().then((c) => useStore.getState().setAvatars(c.avatars ?? []));
    return window.cth.onConfigChanged((c) => useStore.getState().setAvatars(c.avatars ?? []));
  }, []);
  reactExports.useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "cth.theme" && (e.newValue === "light" || e.newValue === "dark")) adoptAppTheme(e.newValue);
      else if (e.key === "cth.skin" && (e.newValue === "office" || e.newValue === "professional")) adoptAppSkin(e.newValue);
      else if (e.key === "cth.language" && e.newValue) void instance.changeLanguage(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  if (!ready) return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { width: "100vw", height: "100vh", background: "var(--cth-paper-100)" } });
  return /* @__PURE__ */ jsxRuntimeExports.jsx(IdePanel, {});
}
const root = document.getElementById("root");
if (!root) throw new Error("No root element");
createRoot(root).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(IdeWindowRoot, {}) })
);
