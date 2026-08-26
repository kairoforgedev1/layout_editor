# Layout Editor — Bridge Setup Guide

How to prepare a Stake Engine web-sdk game project for the Layout Editor, what
the integration consists of, and how to verify or restore it (e.g. after
starting from a fresh web-sdk copy).

For standard, unmodified web-sdk projects you normally don't need this guide:
open the project in the editor and use **Setup → Integration status → Install /
repair bridge**. The installer copies the editor-owned files, applies small
anchored patches (each patched file gets a one-time `.sle-backup`), and refuses
to touch any file that doesn't match the standard SDK shape. This guide is the
fallback for projects it refuses, and the reference for what everything does.

---

## How the integration works

The game renders everything through PixiJS display objects created by
`pixi-svelte` Svelte components. Two choke points exist in that package:

- **`propsSyncEffect()`** (`src/lib/utils.svelte.ts`) — every component prop
  (x, y, scale, anchor, style, …) flows through one `$effect` per element.
- **`addToParent()`** (`src/lib/context.svelte.ts`) — every display object is
  attached to the scene graph (and destroyed) through this function.

The Layout Editor hooks both:

1. **Override runtime** — `src/lib/layoutOverrides.svelte.ts` (editor-owned
   file). Holds per-profile override data (`base` + the game's four responsive
   `layoutType`s: desktop / landscape / portrait / tablet) in reactive runes
   state, an **element registry** of every display object with stable ids, and
   `applyLayoutOverrides(node)` which is called at the end of `propsSyncEffect`
   — *after* prop sync, so overrides always win and stay live. Ids come from
   the Pixi `label` (explicit labels and asset-key defaults) or slot-stable
   auto names (`container#12`). Anonymous Container ids are structural only:
   the editor never mutates or saves overrides for them, while their named
   descendants remain editable. A Sprite override may also select a texture by
   its `loadedAssets` key; Base supplies the shared image while a responsive
   profile can replace it for only that layout.

2. **Spawned elements runtime** — `src/lib/spawnedElements.svelte.ts`
   (editor-owned). Instantiates editor-created sprites, Spine animations, and
   containers from the saved data at runtime (editor and normal runs), attaches
   them to their
   chosen parent (stage root or any registered element — including
   state-specific containers, so they mount/unmount with the game state),
   registers them in the same registry, and reconciles reactively on data /
   app / asset / registry changes.

3. **Editor bridge** — `src/lib/editorBridge.ts` (editor-owned). Loaded
   dynamically **only** when the game URL contains `?editor` (activated from
   `InitialiseApplication.svelte`). Draws the selection overlay/guides in DOM
   above the canvas, handles pick/drag/resize/snapping, enumerates the
   registry into the hierarchy tree, lists `loadedAssets` for the asset
   browser (with `renderer.extract` thumbnails), reports Sprite descendants for
   selected containers, and talks to the Electron editor over
   `window.postMessage`. Its editor-only `performanceSampler.ts` companion is
   disabled until the Performance panel opens, then gathers constant-time Pixi
   ticker / renderer timing and draw-submission aggregates. Its
   `testBookRequest.ts` companion patches exactly one validated testcase
   `/wallet/play` request, then restores `fetch`. These editor bridge modules
   have zero footprint in normal production sessions.

4. **App-side loader** — `src/game/layoutOverrides.ts` +
   `src/game/layoutOverrides.data.ts` in the game app. The data file is the
   single generated artifact the editor saves into (strict-JSON object
   literal: `profiles` + `elements`). The loader calls
   `loadLayoutOverrides(data, () => stateLayoutDerived.layoutType())`, wires
   `wireSpawnedElements({ getApp, getLoadedAssets })` from the app's
   `stateApp`, registers the SDK's full fitted game-content frame with
   `registerGameLayout(() => stateLayoutDerived.mainLayout())`, optionally registers editor-only game-state actions
   (`registerEditorGameHooks`), and hot-accepts data-file changes so editor
   saves apply without reloading. It is imported for side effects from
   `src/game/context.ts`.

The Electron editor embeds the game (its own Vite dev server + mock RGS) in an
iframe sized to the simulated resolution; the game's own responsive logic
reacts to the iframe viewport, and the bridge reports the resulting
`layoutType` back as the active profile.

Asset replacement is deliberately texture-based. Any editor-created or
game-authored Sprite can select another loaded image in Base or an individual
layout profile, and the runtime reapplies that choice after authored Svelte
props sync. A selected Container exposes its descendant Sprites so the intended
image child can be edited directly. Pixi Graphics and raw Containers are not
converted into Sprites because doing so would change their authored class and
game behavior; use a Sprite descendant or add an image to a supported container.

## Full file inventory

**Editor-owned (copied whole; canonical copies ship in the editor's
`resources/bridge/`):**

| File | Purpose |
| --- | --- |
| `packages/pixi-svelte/src/lib/layoutOverrides.svelte.ts` | override runtime + registry (`LAYOUT_EDITOR_BRIDGE_VERSION`) |
| `packages/pixi-svelte/src/lib/spawnedElements.svelte.ts` | editor-created element runtime |
| `packages/pixi-svelte/src/lib/performanceSampler.ts` | opt-in editor performance sampler |
| `packages/pixi-svelte/src/lib/testBookRequest.ts` | guarded one-shot exact testcase request injector |
| `packages/pixi-svelte/src/lib/editorBridge.ts` | in-page editor bridge (`?editor` only) |

**Anchored patches to SDK files:**

| File | Change |
| --- | --- |
| `packages/pixi-svelte/src/lib/utils.svelte.ts` | import + `applyLayoutOverrides(targetInstance, assignedKeys)` at the end of the prop-sync `$effect` (undefined props are not mis-snapshotted as authored values) |
| `packages/pixi-svelte/src/lib/context.svelte.ts` | import + `registerLayoutNode(node)` after `addChild`, `unregisterLayoutNode(node)` in the cleanup before `destroy()` |
| `packages/pixi-svelte/src/lib/components/InitialiseApplication.svelte` | after init: dynamic-import the bridge when `?editor` is in the URL |
| `packages/pixi-svelte/src/lib/index.ts` | `export * from './layoutOverrides.svelte'` + `'./spawnedElements.svelte'` |
| `components/Sprite.svelte`, `components/SpineProvider.svelte` *(optional)* | default `label` to the asset `key` for readable names |
| `packages/components-ui-pixi/...` *(optional, manual)* | `editorId` prop on `UiLabel` + ids on `LabelBalance/Bet/Win/FreeSpinCounter`, labels on `UiGameName` |

**App files:**

| File | Change |
| --- | --- |
| `apps/<game>/src/game/layoutOverrides.data.ts` | generated data (create from template) |
| `apps/<game>/src/game/layoutOverrides.ts` | loader (create from template in `resources/bridge/app/`) |
| `apps/<game>/src/game/context.ts` | add `import './layoutOverrides';` |

**After any pixi-svelte change:** `pnpm --filter pixi-svelte build`
(the package is consumed from `dist/`).

## Manual setup steps

1. Copy the three editor-owned files from the editor's `resources/bridge/`
   into `packages/pixi-svelte/src/lib/`.
2. Add the two export lines to `packages/pixi-svelte/src/lib/index.ts`.
3. Apply the three required patches (utils / context / InitialiseApplication)
   following the table above — see the shipped reference project
   (`moderator_madness/web-sdk`) for the exact result.
4. Copy `resources/bridge/app/layoutOverrides.data.ts` and
   `layoutOverrides.ts` into `apps/<game>/src/game/` (the loader assumes the
   standard `stateLayout.ts` / `stateApp.ts` modules — adapt the imports if
   your app names them differently).
5. Import the loader from `src/game/context.ts` (or any module that always
   runs at startup).
6. `pnpm --filter pixi-svelte build`, then start the app dev server.
7. In the editor: **Setup → Verify connection…** — every check should pass.
8. Optionally add labels for stable names and
   `registerEditorGameHooks({ gameEvents: {...} })` entries for the States menu.

## Verifying the setup

The editor's **Setup → Verify connection…** runs a live report: project +
data-file parse, dev server + mock RGS, bridge hello + version, layout-profile
wiring, spawned-element wiring, hierarchy population, a selection round-trip,
a real override application (applies +11px to one element and reverts it), an
asset-browser query, file writability, and a hidden-window load of the game
**without** `?editor` (canvas renders, bridge stays inactive).

## Restoring after a fresh web-sdk copy

A fresh SDK copy wipes the pixi-svelte changes but usually keeps the app files
(`src/game/layoutOverrides.*` and your saved layout data). Open the project and
run **Setup → Integration status → Install / repair bridge** — it re-copies the
editor-owned files, re-applies the anchored patches and rebuilds. Saved layout
data is never touched by the installer.

## When automatic setup refuses

If a file diverges from the standard SDK shape (custom fork, renamed modules),
the installer marks it **manual** and leaves it alone. Apply the equivalent
change by hand using the tables above, or copy the AI setup prompt
(**Setup → Copy AI setup prompt**) into Fable/Claude Code opened in the target
project and let it recreate the integration against that project's
architecture.
