/** Bottom status bar + log panel. */
import { state, on, log } from "./state.js";
import { aspectString } from "./resolutions.js";
import { unsavedCount } from "./overrides.js";

const $ = (id) => document.getElementById(id);

const dot = (status) =>
  status === "ready" || status === "remote"
    ? '<span class="ok">●</span>'
    : status === "starting"
      ? '<span class="warn">●</span>'
      : status === "error"
        ? '<span class="bad">●</span>'
        : "○";

function renderStatus() {
  $("st-project").textContent = state.project
    ? state.project.appName
    : "no project";
  $("st-project").title = state.project?.appDir ?? "";
  $("st-dev").innerHTML =
    `dev ${dot(state.procs.dev.status)}${state.procs.dev.port ? " :" + state.procs.dev.port : ""}`;
  $("st-rgs").innerHTML =
    `rgs ${dot(state.procs.rgs.status)}${state.procs.rgs.port ? " :" + state.procs.rgs.port : ""}`;
  const { width, height } = state.resolution;
  $("st-res").textContent =
    `${width}×${height} (${aspectString(width, height)})`;
  const previewBit = state.preview.connected
    ? `profile: ${state.preview.layoutType}`
    : state.preview.status === "loading" || state.preview.status === "starting"
      ? `preview ${state.preview.status}…`
      : "preview off";
  $("st-profile").textContent =
    `${previewBit} · target: ${state.scope === "base" ? "base" : (state.preview.layoutType ?? "profile")} · ${state.mode} mode`;
  $("st-state").textContent = state.gameState
    ? `state: ${state.gameState}`
    : "";
  const values = state.values;
  $("st-sel").textContent =
    state.selection && values
      ? `${state.selection}  x:${Math.round(values.effective.x)} y:${Math.round(values.effective.y)} ` +
        `${Math.round(values.bounds?.width ?? 0)}×${Math.round(values.bounds?.height ?? 0)}px`
      : "";
  const unsaved = unsavedCount();
  const el = $("st-unsaved");
  el.textContent = unsaved
    ? `● ${unsaved} unsaved change(s)`
    : "all changes saved";
  el.classList.toggle("dirty", unsaved > 0);
}

// The game streams `values` ~60×/sec while an element is selected. Only the live
// selection read-out reflects it — recomputing the whole bar (incl. the unsaved
// diff, which idle animation can't change) every frame was wasted work and lag.
function updateLiveSelectionStatus() {
  const values = state.values;
  $("st-state").textContent = state.gameState
    ? `state: ${state.gameState}`
    : "";
  $("st-sel").textContent =
    state.selection && values
      ? `${state.selection}  x:${Math.round(values.effective.x)} y:${Math.round(values.effective.y)} ` +
        `${Math.round(values.bounds?.width ?? 0)}×${Math.round(values.bounds?.height ?? 0)}px`
      : "";
}

const MAX_LOG_LINES = 600;

const panel = () => $("logpanel");
const panelOpen = () => !panel().classList.contains("hidden");

let unseenErrors = 0;

function bumpErrorBadge(delta) {
  unseenErrors = Math.max(0, unseenErrors + delta);
  for (const el of [$("log-web-badge"), $("btn-logs")]) {
    el?.classList.toggle("has-errors", unseenErrors > 0);
  }
  const badge = $("log-web-badge");
  if (badge) {
    badge.textContent = unseenErrors > 99 ? "99+" : String(unseenErrors);
    badge.classList.toggle("hidden", unseenErrors === 0);
  }
}

/** True while the web-console tab is the one the user is actually looking at. */
const webTabVisible = () =>
  panelOpen() && $("log-web").classList.contains("active");

function selectTab(name) {
  const bodies = {
    dev: $("log-dev"),
    rgs: $("log-rgs"),
    editor: $("log-editor"),
    web: $("log-web"),
  };
  for (const b of document.querySelectorAll(".log-tabs button[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === name);
  }
  for (const b of document.querySelectorAll(".log-body"))
    b.classList.remove("active");
  const body = bodies[name] ?? bodies.dev;
  body.classList.add("active");
  body.scrollTop = body.scrollHeight;
  $("log-web-filter").classList.toggle("hidden", name !== "web");
  if (name === "web") bumpErrorBadge(-unseenErrors);
}

/** Open the panel (optionally on a given tab), or close it if already showing it. */
export function toggleLogPanel(tab = null) {
  if (panelOpen() && (!tab || $(`log-${tab}`).classList.contains("active"))) {
    panel().classList.add("hidden");
    return;
  }
  panel().classList.remove("hidden");
  // Opening with errors waiting should show them, not whichever tab was last used.
  const target = tab ?? (unseenErrors > 0 ? "web" : null);
  if (target) selectTab(target);
  else if (webTabVisible()) bumpErrorBadge(-unseenErrors);
}

function initLogPanel() {
  const bodies = {
    dev: $("log-dev"),
    rgs: $("log-rgs"),
    editor: $("log-editor"),
    web: $("log-web"),
  };
  on("log", ({ source, line, level }) => {
    const body = bodies[source] ?? bodies.editor;
    // Console text comes from the game, so build the row as a text node rather
    // than markup; the level only drives a CSS class used for colour + filtering.
    const row = document.createElement("div");
    row.className = `log-line${level ? ` lvl-${level}` : ""}`;
    row.textContent = line;
    body.appendChild(row);
    while (body.childElementCount > MAX_LOG_LINES)
      body.removeChild(body.firstElementChild);
    if (panelOpen() && body.classList.contains("active"))
      body.scrollTop = body.scrollHeight;
    if (level === "error" && !webTabVisible()) bumpErrorBadge(1);
  });
  for (const tab of document.querySelectorAll(".log-tabs button[data-tab]")) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  }
  $("chk-log-errors").addEventListener("change", (event) => {
    $("log-web").classList.toggle("errors-only", event.target.checked);
  });
  $("btn-log-clear").addEventListener("click", () => {
    document.querySelector(".log-body.active").replaceChildren();
  });
  $("btn-log-close").addEventListener("click", () => {
    panel().classList.add("hidden");
  });
}

/** "http://localhost:5173/src/game/Foo.svelte?t=17" -> "Foo.svelte". */
function shortSource(source) {
  if (!source) return "";
  const clean = source.split(/[?#]/)[0].replace(/\/$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

/** Mirror the game iframe's browser console into the "Web console" tab. */
function initWebConsole() {
  const host = window.editorHost;
  if (!host?.onConsoleMessage) return;
  host.onConsoleMessage(({ level, message, source, line }) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const file = shortSource(source);
    const where = file ? ` (${file}${line ? ":" + line : ""})` : "";
    log("web", `${time}  ${message}${where}`, level);
  });
}

export function initStatusbar() {
  for (const event of [
    "project",
    "proc",
    "preview",
    "overrides",
    "selection",
    "resolution",
    "mode",
    "scope",
  ]) {
    on(event, renderStatus);
  }
  on("values", updateLiveSelectionStatus);
  initLogPanel();
  initWebConsole();
  renderStatus();
}
