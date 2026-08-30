/**
 * Bridge integration analyzer + installer for Stake Engine web-sdk projects.
 *
 * Analysis inspects the target workspace/app and reports the state of every
 * integration piece. Installation only ever:
 *  - copies whole editor-owned files (layoutOverrides.svelte.ts, editorBridge.ts,
 *    performanceSampler.ts, testBookRequest.ts, spawnedElements.svelte.ts, and newly-created app loader/data files) from
 *    bundled templates,
 *  - applies small anchored patches to SDK files and the generated v5 app-loader
 *    registration, only when the file matches the known standard web-sdk shape.
 *    A file that does not match is reported as "manual" — it is never guessed at.
 * Every modified file gets a one-time `.sle-backup` copy next to it.
 */
const fs = require("fs");
const path = require("path");

const EXPECTED_BRIDGE_VERSION = 11; // Protocol stable; exact runtime is checked by revision
const EXPECTED_BRIDGE_REVISION = "2026-08-28-canvas-preinit-guard-v1";
const TEMPLATES_DIR = path.join(__dirname, "..", "..", "resources", "bridge");

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const normalizeSource = (value) => value?.replace(/\r\n/g, "\n").trimEnd();

const backupOnce = (p) => {
  const backup = `${p}.sle-backup`;
  if (fs.existsSync(p) && !fs.existsSync(backup)) fs.copyFileSync(p, backup);
};

const writePatched = (p, content) => {
  backupOnce(p);
  fs.writeFileSync(p, content, "utf8");
};

/** Whitespace-flexible exact snippet matcher: returns a RegExp for `snippet`. */
const flexibleRegex = (snippet) => {
  const escaped = snippet
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(escaped);
};

const insertAfterLastImport = (source, importLine) => {
  if (source.includes(importLine)) return source;
  const lines = source.split("\n");
  let lastImport = -1;
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inImport && /^\s*import(?:\s|['"])/.test(line)) inImport = true;
    if (!inImport) continue;
    const sideEffectDone = /^\s*import\s*['"][^'"]+['"]\s*;?\s*$/.test(line);
    const fromDone = /\bfrom\s*['"][^'"]+['"]\s*;?\s*$/.test(line);
    if (sideEffectDone || fromDone) {
      lastImport = i;
      inImport = false;
    }
  }
  lines.splice(lastImport + 1, 0, importLine);
  return lines.join("\n");
};

const PIXI_SVELTE_NAMED_IMPORT_RE =
  /import\s*\{([\s\S]*?)\}\s*from\s*(['"])pixi-svelte\2\s*;?/g;
const GAME_LAYOUT_LINE_RE =
  /^([ \t]*)registerGameLayout\s*\(\s*\(\s*\)\s*=>\s*stateLayoutDerived\s*\.\s*mainLayout\s*\(\s*\)\s*\)\s*;?[ \t]*(?=\r?$)/m;
const LEGACY_GAME_SCALE_LINE_RE =
  /^([ \t]*)registerGameScale\s*\(\s*\(\s*\)\s*=>\s*stateLayoutDerived\s*\.\s*mainLayout\s*\(\s*\)\s*\.\s*scale\s*\)\s*;?[ \t]*(?=\r?$)/m;

const pixiSvelteImportCount = (source, name) => {
  let count = 0;
  for (const match of source.matchAll(PIXI_SVELTE_NAMED_IMPORT_RE)) {
    count += match[1].match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
  }
  return count;
};

/**
 * Inspect (and, when safe, prepare an upgrade for) the v5 app loader.
 * Only the generated registration import + statement are changed. Everything
 * else in the loader, including project-specific editor hooks, is preserved.
 */
const inspectGameLayoutLoader = (source) => {
  if (!source) return { status: "missing" };
  if (
    pixiSvelteImportCount(source, "registerGameLayout") === 1 &&
    GAME_LAYOUT_LINE_RE.test(source)
  ) {
    return { status: "ok", source };
  }

  const legacyLines =
    source.match(new RegExp(LEGACY_GAME_SCALE_LINE_RE.source, "gm")) ?? [];
  if (
    legacyLines.length !== 1 ||
    pixiSvelteImportCount(source, "registerGameScale") !== 1
  ) {
    return { status: "manual", source };
  }

  let importReplacements = 0;
  let upgraded = source.replace(
    PIXI_SVELTE_NAMED_IMPORT_RE,
    (full, bindings) => {
      if (!/\bregisterGameScale\b/.test(bindings)) return full;
      importReplacements += 1;
      return full.replace(
        bindings,
        bindings.replace(/\bregisterGameScale\b/, "registerGameLayout"),
      );
    },
  );
  if (importReplacements !== 1) return { status: "manual", source };

  upgraded = upgraded.replace(
    LEGACY_GAME_SCALE_LINE_RE,
    (_line, indent) =>
      `${indent}registerGameLayout(() => stateLayoutDerived.mainLayout());`,
  );
  return { status: "upgradeable", source: upgraded };
};

// ---------------------------------------------------------------------------
// Patch definitions (anchored against the standard web-sdk sources)
// ---------------------------------------------------------------------------

const PATCHES = [
  {
    id: "utils-hook",
    title:
      "propsSyncEffect applies overrides (pixi-svelte/src/lib/utils.svelte.ts)",
    file: (ctx) => path.join(ctx.pixiSvelteLib, "utils.svelte.ts"),
    applied: (source) =>
      source.includes(
        "applyLayoutOverrides(targetInstance, assignedKeys as string[])",
      ),
    find: `(Object.keys(props) as (keyof TProps)[])
				.filter((key) => (ignore ? !ignore.includes(key) : true))
				.forEach((key) => {
					if (props[key] !== undefined) {
						// @ts-ignore
						targetInstance[key] = props[key];
					}
				});`,
    findAlternatives: [
      `(Object.keys(props) as (keyof TProps)[])
				.filter((key) => (ignore ? !ignore.includes(key) : true))
				.forEach((key) => {
					if (props[key] !== undefined) {
						// @ts-ignore
						targetInstance[key] = props[key];
					}
				});`,
      `const keys = (Object.keys(props) as (keyof TProps)[]).filter((key) =>
				ignore ? !ignore.includes(key) : true,
			);
			keys.forEach((key) => {
				if (props[key] !== undefined) {
					// @ts-ignore
					targetInstance[key] = props[key];
				}
			});
			// Layout Editor support: re-apply any layout overrides after prop sync so
			// overrides always win. No-op when the project has no overrides loaded.
			applyLayoutOverrides(targetInstance, keys as string[]);`,
    ],
    replace: `const keys = (Object.keys(props) as (keyof TProps)[]).filter((key) =>
				ignore ? !ignore.includes(key) : true,
			);
			const assignedKeys = keys.filter((key) => props[key] !== undefined);
			assignedKeys.forEach((key) => {
				// @ts-ignore
				targetInstance[key] = props[key];
			});
			// Layout Editor support: re-apply any layout overrides after prop sync so
			// overrides always win. No-op when the project has no overrides loaded.
			applyLayoutOverrides(targetInstance, assignedKeys as string[]);`,
    imports: [
      `import { applyLayoutOverrides } from './layoutOverrides.svelte';`,
    ],
  },
  {
    id: "context-hook",
    title:
      "addToParent registers nodes (pixi-svelte/src/lib/context.svelte.ts)",
    file: (ctx) => path.join(ctx.pixiSvelteLib, "context.svelte.ts"),
    applied: (source) => source.includes("registerLayoutNode(node)"),
    find: `context.parent.addChild(node);
			context.parent.sortChildren();`,
    replace: `context.parent.addChild(node);
			context.parent.sortChildren();
			registerLayoutNode(node); // Layout Editor registry`,
    secondFind: `return () => {
				if (node) node.destroy();`,
    secondReplace: `return () => {
				unregisterLayoutNode(node);
				if (node) node.destroy();`,
    imports: [
      `import { registerLayoutNode, unregisterLayoutNode } from './layoutOverrides.svelte';`,
    ],
  },
  {
    id: "init-hook",
    title: "Editor bridge activation (InitialiseApplication.svelte)",
    file: (ctx) =>
      path.join(
        ctx.pixiSvelteLib,
        "components",
        "InitialiseApplication.svelte",
      ),
    applied: (source) => source.includes("editorBridge"),
    find: `if (!initialised) await initialiseApplication();
			initialised = true;`,
    replace: `if (!initialised) await initialiseApplication();
			initialised = true;

			// Layout Editor support: the bridge only loads when the page is opened
			// with an \`?editor\` query param (i.e. inside the Layout Editor tool).
			if (new URLSearchParams(window.location.search).has('editor')) {
				const { initEditorBridge } = await import('../editorBridge');
				initEditorBridge({ getApp: () => context.stateApp.pixiApplication });
			}`,
    imports: [],
  },
  {
    id: "sprite-label",
    title: "Sprite label defaults to asset key (Sprite.svelte) — optional",
    optional: true,
    file: (ctx) => path.join(ctx.pixiSvelteLib, "components", "Sprite.svelte"),
    applied: (source) => /label=\{key\}/.test(source),
    find: `<BaseSprite {...baseSpriteProps} {texture} />`,
    replace: `<!-- Default the Pixi label to the asset key so the Layout Editor shows a recognizable name. -->
<BaseSprite label={key} {...baseSpriteProps} {texture} />`,
    imports: [],
  },
  {
    id: "spine-label",
    title:
      "Spine label defaults to asset key (SpineProvider.svelte) — optional",
    optional: true,
    file: (ctx) =>
      path.join(ctx.pixiSvelteLib, "components", "SpineProvider.svelte"),
    applied: (source) => /label=\{key\}/.test(source),
    find: `<BaseSpineProvider {...baseSpineProps} {scale} {pivot} {spineData}>`,
    replace: `<!-- Default the Pixi label to the asset key so the Layout Editor shows a recognizable name. -->
	<BaseSpineProvider label={key} {...baseSpineProps} {scale} {pivot} {spineData}>`,
    imports: [],
  },
];

const OWNED_FILES = [
  {
    id: "runtime",
    template: "layoutOverrides.svelte.ts",
    target: (ctx) => path.join(ctx.pixiSvelteLib, "layoutOverrides.svelte.ts"),
  },
  {
    id: "spawned",
    template: "spawnedElements.svelte.ts",
    target: (ctx) => path.join(ctx.pixiSvelteLib, "spawnedElements.svelte.ts"),
  },
  {
    id: "performance",
    template: "performanceSampler.ts",
    target: (ctx) => path.join(ctx.pixiSvelteLib, "performanceSampler.ts"),
  },
  {
    id: "test-book-request",
    template: "testBookRequest.ts",
    target: (ctx) => path.join(ctx.pixiSvelteLib, "testBookRequest.ts"),
  },
  {
    id: "bridge",
    template: "editorBridge.ts",
    target: (ctx) => path.join(ctx.pixiSvelteLib, "editorBridge.ts"),
  },
];

const INDEX_EXPORTS = [
  `export * from './layoutOverrides.svelte';`,
  `export * from './spawnedElements.svelte';`,
];

// ---------------------------------------------------------------------------

const makeContext = (project) => {
  const workspaceRoot = project.workspaceRoot;
  if (!workspaceRoot) return null;
  const pixiSvelteLib = path.join(
    workspaceRoot,
    "packages",
    "pixi-svelte",
    "src",
    "lib",
  );
  if (!fs.existsSync(pixiSvelteLib)) return null;
  return { workspaceRoot, appDir: project.appDir, pixiSvelteLib };
};

const detectVersion = (source) => {
  const match = source?.match(/LAYOUT_EDITOR_BRIDGE_VERSION\s*=\s*(\d+)/);
  return match ? Number(match[1]) : source ? 1 : 0;
};

const detectRevision = (source) =>
  source?.match(/LAYOUT_EDITOR_BRIDGE_REVISION\s*=\s*['"]([^'"]+)['"]/)?.[1] ??
  "";

function analyzeIntegration(project) {
  const checks = [];
  const add = (id, title, status, note = "") =>
    checks.push({ id, title, status, note });

  const ctx = makeContext(project);
  if (!ctx) {
    add(
      "structure",
      "Standard web-sdk structure (packages/pixi-svelte/src/lib)",
      "manual",
      "pixi-svelte source not found — this project needs a manual/AI-assisted setup.",
    );
    return {
      status: "manual",
      expectedVersion: EXPECTED_BRIDGE_VERSION,
      checks,
    };
  }
  add("structure", "Standard web-sdk structure", "ok");

  // editor-owned files
  const runtimeSource = read(
    path.join(ctx.pixiSvelteLib, "layoutOverrides.svelte.ts"),
  );
  const expectedRuntimeSource = read(
    path.join(TEMPLATES_DIR, "layoutOverrides.svelte.ts"),
  );
  const version = detectVersion(runtimeSource);
  if (!runtimeSource)
    add(
      "runtime",
      "Override runtime (layoutOverrides.svelte.ts)",
      "installable",
      "missing",
    );
  else if (
    normalizeSource(runtimeSource) !== normalizeSource(expectedRuntimeSource)
  )
    add(
      "runtime",
      "Override runtime (layoutOverrides.svelte.ts)",
      "outdated",
      `installed runtime does not match bundled v${EXPECTED_BRIDGE_VERSION} (${EXPECTED_BRIDGE_REVISION})`,
    );
  else
    add(
      "runtime",
      "Override runtime (layoutOverrides.svelte.ts)",
      "ok",
      `v${version} · ${EXPECTED_BRIDGE_REVISION}`,
    );

  for (const [id, file, title] of [
    ["spawned", "spawnedElements.svelte.ts", "Spawned elements runtime"],
    ["performance", "performanceSampler.ts", "Performance sampler"],
    ["test-book-request", "testBookRequest.ts", "Test-book request runner"],
    ["bridge", "editorBridge.ts", "Editor bridge"],
  ]) {
    const installed = read(path.join(ctx.pixiSvelteLib, file));
    const expected = read(path.join(TEMPLATES_DIR, file));
    const status =
      installed == null
        ? "installable"
        : expected != null &&
            normalizeSource(installed) === normalizeSource(expected)
          ? "ok"
          : "outdated";
    add(
      id,
      `${title} (${file})`,
      status,
      installed == null
        ? "missing"
        : status === "outdated"
          ? `does not match the bundled v${EXPECTED_BRIDGE_VERSION} bridge`
          : "",
    );
  }

  // index exports
  const indexSource = read(path.join(ctx.pixiSvelteLib, "index.ts")) ?? "";
  const exportsOk =
    indexSource.includes("./layoutOverrides.svelte") &&
    indexSource.includes("./spawnedElements.svelte");
  add(
    "exports",
    "Package exports (index.ts)",
    exportsOk ? "ok" : "installable",
    exportsOk ? "" : "missing export lines",
  );

  // anchored patches
  for (const patch of PATCHES) {
    const file = patch.file(ctx);
    const source = read(file);
    if (!source) {
      add(
        patch.id,
        patch.title,
        patch.optional ? "skip" : "manual",
        "file not found",
      );
      continue;
    }
    if (patch.applied(source)) {
      add(patch.id, patch.title, "ok");
    } else if (
      (patch.findAlternatives ?? [patch.find]).some((snippet) =>
        flexibleRegex(snippet).test(source),
      ) &&
      (!patch.secondFind || flexibleRegex(patch.secondFind).test(source))
    ) {
      add(
        patch.id,
        patch.title,
        "installable",
        "anchor matched — can patch automatically",
      );
    } else {
      add(
        patch.id,
        patch.title,
        patch.optional ? "skip" : "manual",
        "file does not match the standard web-sdk shape — needs a manual/AI-assisted change",
      );
    }
  }

  // app side
  const gameDir = path.join(ctx.appDir, "src", "game");
  const stateLayoutOk = fs.existsSync(path.join(gameDir, "stateLayout.ts"));
  const stateAppOk = fs.existsSync(path.join(gameDir, "stateApp.ts"));
  if (!stateLayoutOk || !stateAppOk) {
    add(
      "app-shape",
      "App exposes src/game/stateLayout.ts + stateApp.ts",
      "manual",
      "the generated loader needs these standard modules",
    );
  } else {
    add("app-shape", "App exposes src/game/stateLayout.ts + stateApp.ts", "ok");
  }
  const loaderPath = path.join(gameDir, "layoutOverrides.ts");
  add(
    "app-loader",
    "App loader (src/game/layoutOverrides.ts)",
    fs.existsSync(loaderPath)
      ? "ok"
      : stateLayoutOk && stateAppOk
        ? "installable"
        : "manual",
  );
  const loaderSource = read(loaderPath);
  const gameLayout = inspectGameLayoutLoader(loaderSource);
  add(
    "game-layout",
    "Game content frame registered (registerGameLayout)",
    gameLayout.status === "missing"
      ? "skip"
      : gameLayout.status === "ok"
        ? "ok"
        : gameLayout.status === "upgradeable"
          ? "installable"
          : "manual",
    gameLayout.status === "upgradeable"
      ? "v5 registerGameScale loader matched — can upgrade without replacing custom hooks"
      : gameLayout.status === "manual"
        ? "register the full MainContainer frame with registerGameLayout(() => stateLayoutDerived.mainLayout())"
        : "",
  );
  add(
    "app-data",
    "Layout data file (src/game/layoutOverrides.data.ts)",
    fs.existsSync(path.join(gameDir, "layoutOverrides.data.ts"))
      ? "ok"
      : "installable",
  );
  const contextSource = read(path.join(gameDir, "context.ts"));
  add(
    "app-import",
    "Loader imported from src/game/context.ts",
    contextSource == null
      ? "manual"
      : contextSource.includes("./layoutOverrides")
        ? "ok"
        : "installable",
    contextSource == null ? "context.ts not found" : "",
  );

  // built dist present?
  const distSource = read(
    path.join(
      ctx.workspaceRoot,
      "packages",
      "pixi-svelte",
      "dist",
      "layoutOverrides.svelte.js",
    ),
  );
  const distVersion = detectVersion(distSource);
  const distRevision = detectRevision(distSource);
  const distStatus = !distSource
    ? "installable"
    : distVersion === EXPECTED_BRIDGE_VERSION &&
        distRevision === EXPECTED_BRIDGE_REVISION
      ? "ok"
      : "outdated";
  add(
    "dist",
    "pixi-svelte built with the bridge (dist/)",
    distStatus,
    distStatus === "ok"
      ? `v${distVersion} · ${distRevision}`
      : "needs `pnpm --filter pixi-svelte build`",
  );

  const statuses = checks.map((check) => check.status);
  const status = statuses.includes("manual")
    ? "manual"
    : statuses.includes("outdated")
      ? "outdated"
      : statuses.includes("installable")
        ? checks.find((c) => c.id === "runtime")?.status === "ok"
          ? "incomplete"
          : "missing"
        : "ready";
  return { status, version, expectedVersion: EXPECTED_BRIDGE_VERSION, checks };
}

function installIntegration(project) {
  const results = [];
  const add = (id, action, note = "") => results.push({ id, action, note });
  const ctx = makeContext(project);
  if (!ctx)
    return {
      ok: false,
      error: "Project structure not compatible with automatic setup.",
      results,
    };
  if (!fs.existsSync(TEMPLATES_DIR)) {
    return {
      ok: false,
      error: `Bundled bridge templates not found at ${TEMPLATES_DIR}`,
      results,
    };
  }

  try {
    // 1. editor-owned files (copied whole; backup once)
    for (const owned of OWNED_FILES) {
      const target = owned.target(ctx);
      const template = read(path.join(TEMPLATES_DIR, owned.template));
      if (!template)
        return {
          ok: false,
          error: `template ${owned.template} missing`,
          results,
        };
      if (read(target) === template) {
        add(owned.id, "unchanged");
      } else {
        writePatched(target, template);
        add(
          owned.id,
          fs.existsSync(`${target}.sle-backup`) ? "updated" : "created",
        );
      }
    }

    // 2. index exports
    const indexPath = path.join(ctx.pixiSvelteLib, "index.ts");
    let indexSource = read(indexPath) ?? "";
    let indexChanged = false;
    for (const line of INDEX_EXPORTS) {
      if (!indexSource.includes(line)) {
        indexSource = indexSource.trimEnd() + "\n" + line + "\n";
        indexChanged = true;
      }
    }
    if (indexChanged) writePatched(indexPath, indexSource);
    add("exports", indexChanged ? "patched" : "unchanged");

    // 3. anchored patches
    for (const patch of PATCHES) {
      const file = patch.file(ctx);
      let source = read(file);
      if (!source) {
        add(patch.id, patch.optional ? "skipped" : "manual", "file not found");
        continue;
      }
      if (patch.applied(source)) {
        add(patch.id, "unchanged");
        continue;
      }
      const matchedFind = (patch.findAlternatives ?? [patch.find]).find(
        (snippet) => flexibleRegex(snippet).test(source),
      );
      const findRe = matchedFind ? flexibleRegex(matchedFind) : null;
      if (
        !findRe ||
        (patch.secondFind && !flexibleRegex(patch.secondFind).test(source))
      ) {
        add(
          patch.id,
          patch.optional ? "skipped" : "manual",
          "anchor not found — apply by hand (see setup guide)",
        );
        continue;
      }
      source = source.replace(findRe, () => patch.replace.trim());
      if (patch.secondFind)
        source = source.replace(flexibleRegex(patch.secondFind), () =>
          patch.secondReplace.trim(),
        );
      for (const importLine of patch.imports)
        source = insertAfterLastImport(source, importLine);
      writePatched(file, source);
      add(patch.id, "patched");
    }

    // 4. app side
    const gameDir = path.join(ctx.appDir, "src", "game");
    const dataPath = path.join(gameDir, "layoutOverrides.data.ts");
    if (!fs.existsSync(dataPath)) {
      const dataTemplate = read(
        path.join(TEMPLATES_DIR, "app", "layoutOverrides.data.ts"),
      );
      fs.writeFileSync(dataPath, dataTemplate, "utf8");
      add("app-data", "created");
    } else add("app-data", "unchanged");

    const loaderPath = path.join(gameDir, "layoutOverrides.ts");
    if (!fs.existsSync(loaderPath)) {
      if (
        fs.existsSync(path.join(gameDir, "stateLayout.ts")) &&
        fs.existsSync(path.join(gameDir, "stateApp.ts"))
      ) {
        const loaderTemplate = read(
          path.join(TEMPLATES_DIR, "app", "layoutOverrides.ts"),
        );
        fs.writeFileSync(loaderPath, loaderTemplate, "utf8");
        add("app-loader", "created");
        add("game-layout", "created");
      } else {
        add(
          "app-loader",
          "manual",
          "stateLayout.ts / stateApp.ts not found — write the loader by hand",
        );
        add(
          "game-layout",
          "manual",
          "register the game content frame in the app loader",
        );
      }
    } else {
      const gameLayout = inspectGameLayoutLoader(read(loaderPath));
      if (gameLayout.status === "upgradeable") {
        writePatched(loaderPath, gameLayout.source);
        add(
          "app-loader",
          "patched",
          "preserved existing game-specific loader hooks",
        );
        add(
          "game-layout",
          "patched",
          "registerGameScale upgraded to registerGameLayout",
        );
      } else {
        add("app-loader", "unchanged");
        add(
          "game-layout",
          gameLayout.status === "ok" ? "unchanged" : "manual",
          gameLayout.status === "ok"
            ? ""
            : "loader is customized and does not match the safe v5 registration upgrade",
        );
      }
    }

    const contextPath = path.join(gameDir, "context.ts");
    const contextSource = read(contextPath);
    if (contextSource == null) {
      add(
        "app-import",
        "manual",
        "src/game/context.ts not found — import ./layoutOverrides from your app entry",
      );
    } else if (contextSource.includes("./layoutOverrides")) {
      add("app-import", "unchanged");
    } else {
      writePatched(
        contextPath,
        insertAfterLastImport(
          contextSource,
          `\n// Layout Editor: loads saved layout overrides + editor hooks (side-effect import).\nimport './layoutOverrides';`,
        ),
      );
      add("app-import", "patched");
    }

    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error), results };
  }
}

module.exports = {
  analyzeIntegration,
  installIntegration,
  EXPECTED_BRIDGE_VERSION,
  EXPECTED_BRIDGE_REVISION,
};
