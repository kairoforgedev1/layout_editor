const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("editorHost", {
  pickFolder: (defaultPath) =>
    ipcRenderer.invoke("dialog:pickFolder", { defaultPath }),
  inspectProject: (dir) => ipcRenderer.invoke("project:inspect", { dir }),
  readOverrides: (overridesPath) =>
    ipcRenderer.invoke("overrides:read", { overridesPath }),
  writeOverrides: (overridesPath, data, temporaryContainerIds = []) =>
    ipcRenderer.invoke("overrides:write", {
      overridesPath,
      data,
      temporaryContainerIds,
    }),
  startProc: (options) => ipcRenderer.invoke("proc:start", options),
  stopProc: (kind) => ipcRenderer.invoke("proc:stop", { kind }),
  checkPort: (port) => ipcRenderer.invoke("port:check", { port }),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  openPath: (target) => ipcRenderer.invoke("shell:openPath", { target }),
  capture: (outPath) => ipcRenderer.invoke("debug:capture", { outPath }),
  analyzeIntegration: (project) =>
    ipcRenderer.invoke("integration:analyze", { project }),
  installIntegration: (project) =>
    ipcRenderer.invoke("integration:install", { project }),
  rebuildBridge: (workspaceRoot) =>
    ipcRenderer.invoke("integration:rebuild", { workspaceRoot }),
  normalRunCheck: (url) =>
    ipcRenderer.invoke("integration:normalRunCheck", { url }),
  checkWritable: (target) =>
    ipcRenderer.invoke("integration:checkWritable", { target }),
  readDoc: (name) => ipcRenderer.invoke("integration:readDoc", { name }),
  scanAssets: (appDir, sinceMs) =>
    ipcRenderer.invoke("assets:scan", { appDir, sinceMs }),
  registerAssets: (appDir, entries) =>
    ipcRenderer.invoke("assets:register", { appDir, entries }),
  scanTestCases: (appDir) => ipcRenderer.invoke("testcases:scan", { appDir }),
  runTestCase: (options) => ipcRenderer.invoke("testcases:run", options),
  clearCache: () => ipcRenderer.invoke("cache:clear"),
  reloadEditor: () => ipcRenderer.invoke("editor:reload"),
  onProcEvent: (handler) => {
    ipcRenderer.on("proc:event", (_event, payload) => handler(payload));
  },
  onEditorHotkey: (handler) => {
    ipcRenderer.on("editor:hotkey", (_event, payload) => handler(payload));
  },
  onConsoleMessage: (handler) => {
    ipcRenderer.on("console:message", (_event, payload) => handler(payload));
  },
});
