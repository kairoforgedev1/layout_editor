/**
 * Project inspection: given a folder the user picked, locate the game app,
 * the pnpm workspace root, the mock RGS server, and the layout override file.
 */
const fs = require("fs");
const path = require("path");

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const parseEnvFile = (p) => {
  const env = {};
  if (!exists(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
};

const isGameApp = (dir) => {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!deps["pixi-svelte"] && exists(path.join(dir, "src", "routes"));
};

const findWorkspaceRoot = (startDir) => {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const findGameApp = (pickedDir) => {
  if (isGameApp(pickedDir)) return pickedDir;
  const appsDir = path.join(pickedDir, "apps");
  if (exists(appsDir)) {
    for (const name of fs.readdirSync(appsDir)) {
      const candidate = path.join(appsDir, name);
      if (isGameApp(candidate)) return candidate;
    }
  }
  // picked a folder inside the app? walk up looking for a game app
  let dir = pickedDir;
  for (let i = 0; i < 5; i++) {
    if (isGameApp(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const findMockRgs = (workspaceRoot) => {
  if (!workspaceRoot) return null;
  const candidates = [
    // Preferred: mock RGS co-located inside the SDK repo under rgs/
    path.join(workspaceRoot, "rgs", "mock-rgs-server"),
    // Legacy layouts: sibling of the workspace, or directly at the workspace root
    path.join(path.dirname(workspaceRoot), "mock-rgs-server"),
    path.join(workspaceRoot, "mock-rgs-server"),
  ];
  for (const candidate of candidates) {
    const pkg = readJson(path.join(candidate, "package.json"));
    if (
      pkg &&
      (pkg.name === "mock-rgs-server" ||
        exists(path.join(candidate, "src", "index.js")))
    ) {
      return candidate;
    }
  }
  return null;
};

/**
 * `${rgsUrl}${'/wallet/authenticate'}` is how the SDK's rgs-fetcher builds every
 * request, so a VITE_RGS_URL that ends in "/" produces "//wallet/authenticate"
 * and the RGS answers 404 — the game then shows its auth error modal instead of
 * booting. Hand the game a base URL that concatenates cleanly.
 */
const normalizeRgsUrl = (value) => String(value).trim().replace(/\/+$/, "");

const parseDevPort = (appDir) => {
  const pkg = readJson(path.join(appDir, "package.json"));
  const script = pkg?.scripts?.dev ?? "";
  const match = script.match(/--port[= ](\d+)/);
  return match ? Number(match[1]) : 3001;
};

function inspectProject(pickedDir) {
  const appDir = findGameApp(pickedDir);
  if (!appDir) {
    return {
      ok: false,
      error:
        "No Stake Engine game app (with a pixi-svelte dependency and src/routes) found in the selected folder.",
    };
  }
  const workspaceRoot = findWorkspaceRoot(appDir);
  const pkg = readJson(path.join(appDir, "package.json"));
  const env = parseEnvFile(path.join(appDir, ".env.local"));
  const overridesPath = path.join(
    appDir,
    "src",
    "game",
    "layoutOverrides.data.ts",
  );
  const pixiSveltePatched = workspaceRoot
    ? exists(
        path.join(
          workspaceRoot,
          "packages",
          "pixi-svelte",
          "dist",
          "layoutOverrides.svelte.js",
        ),
      )
    : false;
  const loaderWired = exists(
    path.join(appDir, "src", "game", "layoutOverrides.ts"),
  );

  return {
    ok: true,
    appDir,
    appName: pkg?.name ?? path.basename(appDir),
    workspaceRoot,
    mockRgsDir: findMockRgs(workspaceRoot),
    devPort: parseDevPort(appDir),
    env: {
      sessionID: env.VITE_SESSION_ID ?? "layout-editor-session",
      rgsUrl: normalizeRgsUrl(env.VITE_RGS_URL ?? "http://localhost:3002"),
      lang: env.VITE_LANG ?? "en",
      currency: env.VITE_CURRENCY ?? "USD",
      device: env.VITE_DEVICE ?? "desktop",
      social: env.VITE_SOCIAL ?? "false",
      demo: env.VITE_DEMO ?? "true",
    },
    overridesPath,
    overridesExists: exists(overridesPath),
    integration: { pixiSveltePatched, loaderWired },
  };
}

module.exports = { inspectProject, parseEnvFile };
