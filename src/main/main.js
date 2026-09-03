const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { inspectProject } = require("./projects");
const { readOverrides, writeOverrides } = require("./overridesFile");
const {
  startProc,
  restartProc,
  stopProc,
  stopAll,
  probePort,
} = require("./processes");
const { analyzeIntegration, installIntegration } = require("./integration");
const { scanAssets, registerAssets } = require("./assetScan");
const { scanTestCases } = require("./testCases");
const { runTestCase, stopTestCaseExtractions } = require("./testCaseRunner");
const { verifyDevServer } = require("./devServerIdentity");

let win = null;

const configPath = () =>
  path.join(app.getPath("userData"), "layout-editor-config.json");

const loadConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
};

const saveConfig = (partial) => {
  const next = { ...loadConfig(), ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, "\t"));
  return next;
};

/**
 * Muting the window mutes the game iframe with it. The editor page itself is
 * silent, so this is exactly "mute the preview" without needing the game to
 * cooperate — it works whatever audio stack the game happens to use.
 */
const applyAudioMute = (muted) => {
  win?.webContents.setAudioMuted(!!muted);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: "#16181d",
    title: "Stake Layout Editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Local dev tool: allows the file:// editor page to embed the
      // http://localhost game iframe and use module scripts.
      webSecurity: false,
    },
  });
  win.removeMenu();

  applyAudioMute(loadConfig().muted);
  // The mute flag lives on the WebContents, so re-assert it after every load.
  // An editor reload or a game navigation must not quietly bring sound back.
  win.webContents.on("did-finish-load", () => applyAudioMute(loadConfig().muted));

  // Global hotkeys. Handled here (not in the renderer) so they also fire while
  // focus is inside the game iframe, which swallows its own keydown events.
  //   Ctrl/Cmd+R        -> reload just the game preview (cache bypassed)
  //   Ctrl/Cmd+Shift+R  -> reload the editor + its managed mock RGS
  //   Ctrl/Cmd+M        -> mute / unmute the game preview
  // The renderer decides what to do, so it can guard unsaved layout changes.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (!(input.control || input.meta)) return;
    const key = input.key.toLowerCase();
    if (key === "r") {
      event.preventDefault();
      win.webContents.send("editor:hotkey", {
        action: input.shift ? "reloadEditor" : "reloadGame",
      });
    } else if (key === "m" && !input.shift) {
      event.preventDefault();
      win.webContents.send("editor:hotkey", { action: "toggleMute" });
    }
  });

  forwardConsoleMessages(win);

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.env.SLE_DEBUG === "1")
    win.webContents.openDevTools({ mode: "detach" });
}

// Chromium reports console output (and uncaught errors / rejections) from every
// frame of the window, the game iframe included. Forwarding it to the renderer
// gives the log panel a web console, so an in-game crash is visible without
// opening DevTools.
const CONSOLE_LEVELS = ["debug", "info", "warning", "error"];

function forwardConsoleMessages(target) {
  target.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      // Electron >= 35 passes a single event object; 33 uses positional args.
      const details =
        event && typeof event === "object" && "message" in event ? event : null;
      const text = String((details ? details.message : message) ?? "");
      const source = String((details ? details.sourceId : sourceId) ?? "");
      const rawLevel = details ? details.level : level;
      const fromGame =
        details?.frame && target.webContents.mainFrame
          ? details.frame !== target.webContents.mainFrame
          : // Without a frame handle, the origin tells them apart: the editor page
            // is file://, the game is served over http from the dev server.
            /^https?:/i.test(source);
      // Editor-frame output stays out: the renderer's own console.error runs inside
      // the log dispatcher, so echoing it back would be a feedback loop.
      if (!fromGame) return;
      target.webContents.send("console:message", {
        level:
          typeof rawLevel === "number"
            ? (CONSOLE_LEVELS[rawLevel] ?? "info")
            : String(rawLevel ?? "info"),
        message: text,
        source,
        line: Number((details ? details.lineNumber : line) ?? 0),
      });
    },
  );
}

const sendProcEvent = (event) => {
  win?.webContents.send("proc:event", event);
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle("dialog:pickFolder", async (_event, { defaultPath } = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: "Select a Stake Engine game project (app folder or workspace root)",
    defaultPath: defaultPath || undefined,
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("project:inspect", (_event, { dir }) => inspectProject(dir));

ipcMain.handle("overrides:read", (_event, { overridesPath }) =>
  readOverrides(overridesPath),
);

ipcMain.handle(
  "overrides:write",
  (_event, { overridesPath, data, temporaryContainerIds }) => {
    try {
      return writeOverrides(overridesPath, data, { temporaryContainerIds });
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  },
);

ipcMain.handle(
  "proc:start",
  (_event, { kind, cwd, command, args, expectedPort }) =>
    startProc({ kind, command, args, cwd, expectedPort, send: sendProcEvent }),
);

ipcMain.handle("proc:stop", (_event, { kind }) => {
  stopProc(kind);
  return { ok: true };
});

ipcMain.handle("port:check", (_event, { port }) => probePort(port));

// Is the server already on this port serving the project the editor has open?
ipcMain.handle("dev:verify", async (_event, { appDir, port }) => {
  try {
    return await verifyDevServer({ appDir, port });
  } catch (error) {
    return { ok: false, verified: false, error: String(error.message ?? error) };
  }
});

ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:set", (_event, partial) => saveConfig(partial));

ipcMain.handle("audio:get", () => ({
  muted: win ? win.webContents.isAudioMuted() : false,
}));

// Report the flag actually in effect rather than the one requested, so a
// renderer that lost its window cannot leave the button showing a lie.
ipcMain.handle("audio:setMuted", (_event, { muted }) => {
  const next = !!muted;
  saveConfig({ muted: next });
  applyAudioMute(next);
  return { ok: true, muted: win ? win.webContents.isAudioMuted() : next };
});

ipcMain.handle("shell:openPath", (_event, { target }) =>
  shell.openPath(target),
);

// Drop the HTTP cache so replaced asset files (atlas page images, spine PNGs)
// are refetched from the dev server instead of served from cache.
ipcMain.handle("cache:clear", async () => {
  try {
    await session.defaultSession.clearCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
});

ipcMain.handle("editor:reload", () => {
  // A whole-editor reload should also give an editor-managed mock RGS a fresh
  // process. Do not touch an RGS that the editor merely attached to: it has no
  // managed process entry, so restartProc returns null. Starting is synchronous
  // up to the readiness poll, allowing the renderer to reload immediately while
  // the replacement server comes online in the background.
  const rgsRestart = restartProc("rgs", sendProcEvent);
  rgsRestart?.catch((error) => {
    sendProcEvent({
      kind: "rgs",
      event: "log",
      line: `[editor] mock RGS restart failed: ${String(error.message ?? error)}`,
    });
  });
  win?.webContents.reloadIgnoringCache();
  return { ok: true, restartingRgs: !!rgsRestart };
});

ipcMain.handle("assets:scan", (_event, { appDir, sinceMs }) => {
  try {
    return scanAssets({ appDir, sinceMs });
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
});

ipcMain.handle("assets:register", (_event, { appDir, entries }) => {
  try {
    return registerAssets({ appDir, entries });
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
});

ipcMain.handle("testcases:scan", (_event, { appDir }) => {
  try {
    return scanTestCases({ appDir });
  } catch (error) {
    return {
      ok: false,
      error: String(error.message ?? error),
      manifests: [],
      fileErrors: [],
    };
  }
});

ipcMain.handle("testcases:run", async (_event, options) => {
  try {
    return await runTestCase(options);
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
});

// ---------------------------------------------------------------------------
// Bridge integration / verification
// ---------------------------------------------------------------------------
ipcMain.handle("integration:analyze", (_event, { project }) =>
  analyzeIntegration(project),
);

ipcMain.handle("integration:install", (_event, { project }) =>
  installIntegration(project),
);

// One-shot rebuild of pixi-svelte after installing/updating the bridge.
ipcMain.handle("integration:rebuild", (_event, { workspaceRoot }) => {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const child = spawn("pnpm", ["--filter", "pixi-svelte", "build"], {
      cwd: workspaceRoot,
      shell: true,
      windowsHide: true,
    });
    let output = "";
    const onChunk = (chunk) => {
      output += chunk.toString();
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim())
          sendProcEvent({
            kind: "dev",
            event: "log",
            line: `[rebuild] ${line.slice(0, 400)}`,
          });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code) =>
      resolve({ ok: code === 0, code, output: output.slice(-2000) }),
    );
    child.on("error", (error) => resolve({ ok: false, error: String(error) }));
  });
});

// Load the game WITHOUT ?editor in a hidden window and confirm it still runs
// normally (canvas present, no bridge active).
ipcMain.handle(
  "integration:normalRunCheck",
  async (_event, { url, timeoutMs = 25000 }) => {
    let hidden = null;
    try {
      hidden = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
        },
      });
      await hidden.loadURL(url);
      const deadline = Date.now() + timeoutMs;
      let result = { canvas: false, bridgeAbsent: true };
      while (Date.now() < deadline) {
        result = await hidden.webContents.executeJavaScript(
          `({ canvas: !!document.querySelector('canvas'), bridgeAbsent: typeof window.__SLE_BRIDGE__ === 'undefined' })`,
          true,
        );
        if (result.canvas) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { ok: result.canvas && result.bridgeAbsent, ...result };
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    } finally {
      hidden?.destroy();
    }
  },
);

ipcMain.handle("integration:checkWritable", (_event, { target }) => {
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// Setup docs bundled with the editor.
const DOCS_DIR = path.join(__dirname, "..", "..");
ipcMain.handle("integration:readDoc", (_event, { name }) => {
  const allowed = { guide: "SETUP_GUIDE.md", prompt: "AI_SETUP_PROMPT.md" };
  const file = allowed[name];
  if (!file) return { ok: false, error: "unknown doc" };
  try {
    return {
      ok: true,
      path: path.join(DOCS_DIR, file),
      text: fs.readFileSync(path.join(DOCS_DIR, file), "utf8"),
    };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
});

ipcMain.handle("debug:capture", async (_event, { outPath } = {}) => {
  const image = await win.webContents.capturePage();
  const target =
    outPath || path.join(app.getPath("temp"), `sle-capture-${Date.now()}.png`);
  fs.writeFileSync(target, image.toPNG());
  return { ok: true, path: target };
});

// Test-only control server used by automated verification (curl -> eval/capture).
// Never enabled unless the editor is explicitly launched with SLE_DEBUG=1.
// Binds to localhost only.
if (process.env.SLE_DEBUG === "1") {
  const http = require("http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const respond = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const { action, code, frameUrlIncludes, outPath } = JSON.parse(
          body || "{}",
        );
        if (action === "eval") {
          let target = win.webContents.mainFrame;
          if (frameUrlIncludes) {
            const frame = win.webContents.mainFrame.frames.find((f) =>
              f.url.includes(frameUrlIncludes),
            );
            if (!frame) throw new Error("frame not found");
            target = frame;
          }
          const result = await target.executeJavaScript(code, true);
          respond({ ok: true, result });
        } else if (action === "capture") {
          const image = await win.webContents.capturePage();
          const target =
            outPath || path.join(app.getPath("temp"), `sle-${Date.now()}.png`);
          fs.writeFileSync(target, image.toPNG());
          respond({ ok: true, result: target });
        } else {
          respond({ ok: false, error: "unknown action" });
        }
      } catch (error) {
        respond({ ok: false, error: String(error) });
      }
    });
  });
  server.listen(39876, "127.0.0.1");
}

app.whenReady().then(createWindow);

app.on("before-quit", () => {
  stopTestCaseExtractions();
  stopAll();
});
app.on("window-all-closed", () => {
  stopTestCaseExtractions();
  stopAll();
  app.quit();
});
