/** Central editor state + tiny event bus. Panels re-render on the events below. */

export const state = {
  config: {},
  project: null, // result of project:inspect
  procs: {
    dev: { status: "stopped", port: null },
    rgs: { status: "stopped", port: null },
  },
  preview: {
    status: "idle", // idle | starting | loading | ready
    connected: false, // bridge said hello
    layoutType: null, // desktop | landscape | portrait | tablet (authoritative, from game)
    gameW: 0,
    gameH: 0,
    url: null,
  },
  performance: {
    open: false,
    available: false,
    latest: null,
  },
  testCases: {
    open: false,
    scanStatus: "idle", // idle | loading | ready | error
    scanError: null,
    directory: null,
    directoryPresent: false,
    manifests: [],
    fileErrors: [],
    selectedManifestId: null,
    selectedBookKey: null,
    filter: "",
    runnerAvailable: false,
    running: false,
    runPhase: null, // null | preparing | starting
    lastResult: null,
  },
  mode: "preview", // 'edit' | 'preview'
  scope: "profile", // 'profile' | 'base'
  resolution: { width: 1280, height: 720, presetIndex: 10 },
  zoom: { fit: true, level: 1 },
  guides: {
    centers: true,
    safeArea: { enabled: false, top: 5, bottom: 5, left: 5, right: 5 },
    grid: { enabled: false, size: 50 },
    snap: true,
    boundsAll: false,
  },
  overrides: {
    working: { version: 1, profiles: {} },
    saved: { version: 1, profiles: {} },
    fileError: null,
  },
  tree: [],
  // Keep ids seen as anonymous Containers across mode/screen unmounts. A reused
  // runtime slot must stay non-persistent for the lifetime of this project.
  temporaryContainerIds: new Set(),
  collapsed: new Set(),
  selection: null, // element id
  values: null, // last values payload for selection
  gameEvents: [],
  gameState: "", // last triggered state action (informational)
  filters: {
    text: "",
    types: new Set(),
    visibleOnly: false,
    overriddenOnly: false,
    showRemoved: false,
  },
  undo: [],
  redo: [],
};

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) ?? []) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`listener for "${event}" failed`, error);
    }
  }
}

export const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function toast(msg, kind = "info", ms = 3500) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function log(source, line, level = null) {
  emit("log", { source, line, level });
}
