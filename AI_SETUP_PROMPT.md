# AI Setup Prompt — Stake Layout Editor bridge

Copy everything below the line into Fable / Claude Code (or another coding
agent) opened in the target game project. Before running it, replace the
angle-bracket placeholders with paths that are valid on the current machine.
The projects may live anywhere and do not need to be sibling directories.

---

Integrate the Stake Layout Editor bridge into this game project.

Project locations:

- Target game project: `<TARGET_PROJECT_ROOT>` (normally the coding agent's
  current workspace/repository root).
- Layout Editor checkout: `<LAYOUT_EDITOR_ROOT>` (contains the canonical bridge
  files in `resources/bridge/` and the full documentation in `SETUP_GUIDE.md`).
- Optional working reference game: `<REFERENCE_PROJECT_ROOT>`. If no verified
  reference project is available, set this to `NONE` and use the Layout
  Editor's bundled bridge files and templates as the canonical implementation.

Resolve and validate these locations before editing. Do not assume a Windows
drive letter, a user home directory, or any particular parent/sibling folder
structure. If a required location cannot be resolved, ask the user for it.

## Mandatory first step

Review THIS target project completely before changing anything: how the Svelte
app boots, how the PixiJS (pixi-svelte) rendering works, how props reach
display objects, how objects join the scene graph, how responsive layout
types are computed, how assets load, and how the mock RGS is connected. Then
compare it against `<REFERENCE_PROJECT_ROOT>` when one was provided. Otherwise,
compare it against the canonical files and templates under
`<LAYOUT_EDITOR_ROOT>/resources/bridge/`. Note every architectural difference.

## What to integrate

1. Copy the five editor-owned modules from the Layout Editor's
   `resources/bridge/` into this project's `packages/pixi-svelte/src/lib/`:
   `layoutOverrides.svelte.ts` (override runtime + element registry),
   `spawnedElements.svelte.ts` (editor-created element runtime),
   `performanceSampler.ts` (opt-in editor-only performance telemetry),
   `testBookRequest.ts` (guarded one-shot exact testcase request injection),
   `editorBridge.ts` (in-page bridge, only loads when the URL has `?editor`).
   Export both `.svelte.ts` modules from the package index. If this project's
   pixi-svelte diverges from the standard SDK, adapt these files to it — do
   not force the project to match the reference.

2. Hook the two choke points (adapt to this project's actual code):
   - In the function that syncs Svelte props onto Pixi objects (standard SDK:
     `propsSyncEffect` in `src/lib/utils.svelte.ts`), call
     `applyLayoutOverrides(targetInstance, assignedPropKeys)` at the END of the
     effect, after props are assigned, so overrides win and stay reactive. Pass
     only keys whose values were actually written (exclude `undefined`).
   - In the function that attaches display objects to their parent (standard
     SDK: `addToParent` in `src/lib/context.svelte.ts`), call
     `registerLayoutNode(node)` after attach and `unregisterLayoutNode(node)`
     in the unmount cleanup before the node is destroyed.

3. Activate the bridge after the Pixi application initialises (standard SDK:
   `components/InitialiseApplication.svelte`): when
   `new URLSearchParams(window.location.search).has('editor')`, dynamically
   import `../editorBridge` and call
   `initEditorBridge({ getApp: () => <the PIXI.Application> })`.

4. App side (in the game app, e.g. `apps/<game>/src/game/`): create
   `layoutOverrides.data.ts` and `layoutOverrides.ts` from the templates in
   the Layout Editor's `resources/bridge/app/`. The loader must:
   - `loadLayoutOverrides(layoutOverridesData, () => <the game's reactive layoutType getter>)`
     (standard SDK: `stateLayoutDerived.layoutType()`),
   - `registerGameLayout(() => <the game's full reactive MainContainer layout>)`
     (standard SDK: `stateLayoutDerived.mainLayout()`; return x/y/width/height/scale/anchor, not only scale),
   - `wireSpawnedElements({ getApp: () => stateApp.pixiApplication, getLoadedAssets: () => stateApp.loadedAssets })`,
   - keep the `import.meta.hot` accept block for live saves.
   Import the loader for side effects from a module that always runs at
   startup (standard SDK: `src/game/context.ts`).

5. Optional but recommended: default the Pixi `label` to the asset `key` in
   `Sprite.svelte` and `SpineProvider.svelte`; add stable labels to important
   UI texts (balance/bet/win); register a few
   `registerEditorGameHooks({ gameEvents: {...} })` actions that broadcast the
   game's own emitter events to reach states like free spins or win
   presentation.

6. Rebuild the package (`pnpm --filter pixi-svelte build`) — it is consumed
   from `dist/`.

## Constraints

- Preserve normal game behavior exactly: in a run WITHOUT `?editor`, the only
  added work is loading the (initially empty) data file and cheap no-op calls.
  Never let the bridge, overlays or editor input handling load in normal runs.
- Do not scatter generated values through Svelte components; the only saved
  artifact is `layoutOverrides.data.ts` (strict-JSON object literal).
- Keep all changes minimal and anchored to this project's existing style.

## Verify before finishing

- Start the mock RGS and the game dev server; open
  `http://localhost:<port>/?sessionID=<id>&rgs_url=<rgs>&...&editor=1` and
  confirm in the console that `window.__SLE_BRIDGE__` exists and posts a
  `hello` message.
- Load the same URL WITHOUT `editor=1` and confirm the game plays normally and
  `window.__SLE_BRIDGE__` is undefined.
- Open the project in the Stake Layout Editor and run
  **Setup → Verify connection…** — all checks must pass (selection
  round-trip, live override, asset list, normal-run check).
- Document every place where this project differed from the reference and how
  you adapted the integration.
