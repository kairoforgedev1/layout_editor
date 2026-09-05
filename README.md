# Stake Layout Editor

A Windows desktop tool (Electron) for visually editing the layout of Stake Engine
Svelte games built on `pixi-svelte` — currently wired to the
`moderator_madness/web-sdk` `lines` game.

It renders the **real game** (dev server + mock RGS + real math files) inside the
editor, lets you click any sprite / text / container in the running game, drag,
resize, scale, hide or retype-preview it per device profile, and saves the result
back into the game project as one reviewable file.

---

## Requirements

- Node.js ≥ 22, `pnpm` (for the game workspace) and `npm`.
- A game project that contains the Layout Editor integration (the `lines` app in
  `moderator_madness/web-sdk` already does — see [Integration](#integration)).
- The mock RGS server folder (`mock-rgs-server`) next to the `web-sdk` workspace
  (auto-detected), or an already-running RGS.

## Getting started

```bash
cd layout_editor
npm install
npm start          # or: npm run start:debug (opens devtools + local control channel)
```

1. **Open Project** → select the game app folder
   (e.g. `C:\ichiwoah\sidelines\moderator_madness\web-sdk\apps\lines`)
   or the `web-sdk` workspace root.
2. **Start Preview** — the editor attaches to an already-running dev server /
   mock RGS on their ports, or spawns `pnpm dev` and `npm start` itself. Logs are
   in the **Logs** panel.
3. Click through the game's loading screen in **Play** mode.
4. Pick a resolution preset (or type a custom width × height), toggle
   portrait/landscape with **⟳**.
5. Switch to **Edit** mode: click elements in the preview (click again to cycle
   through overlapping elements, Alt+click also cycles), or pick them in the left
   hierarchy. Drag to move, use the corner/edge handles to resize, edit exact
   values in the right inspector.
6. **Save…** shows a summary of every changed element per profile, then writes
   the data file into the game project.
7. Run the game normally (`pnpm dev` in the app) — the saved layout is applied.

## Live performance monitor

Press **Performance** in the top-right toolbar to dock a live monitor beside the
inspector. It graphs the latest 24 seconds of:

- frame rate;
- Pixi application-ticker CPU update time;
- Pixi renderer CPU submission time; and
- draw submissions per rendered frame, including min / average / max values.

Collection is off by default and fully detaches when the panel closes. While
open it performs constant-time instrumentation only—there is no scene-tree or
bounds traversal—and sends one aggregate sample every 250 ms. Render time is
CPU command-generation/submission time, not GPU execution time. Draw calls show
`N/A` if the active renderer does not expose a safely instrumentable submission
path. Opening or closing the dock also refits the preview when zoom is set to
**Fit**.

## Muting the preview

The 🔊 button in the top-right toolbar (or `Ctrl+M`) silences the game preview.
It mutes the editor window itself, so it works whatever audio stack the game
uses and needs no bridge support or game-side changes. The setting is remembered
between sessions and survives a game reload, an editor reload, and a mock RGS
restart — if you left it muted, it stays muted until you turn it back on.

## Forced testcase books

Put the published `*_test_books.json` manifests directly in the opened app's
`testcases` folder. The editor scans that folder when the project opens. Press
**Simulator** to choose a manifest, filter its scenarios, select one book, and
press **Start Round**. No book is selected automatically.

Two manifest versions are read. Prefer **v2** — it is the portable one:

| | `formatVersion: 1` | `formatVersion: 2` |
| --- | --- | --- |
| `kind` | `math-checker-test-book-manifest` | `game-test-book-manifest` |
| books located by | `gameFolder` — an **absolute** path on the publishing machine | `booksDirectory` — **relative to the manifest**, and must stay inside the app |
| works for teammates | only if they have that exact path | yes, wherever the project is checked out |

A v1 manifest resolves only on the machine that generated it; everyone else gets
an error naming the folder it wanted. A rejected manifest never blocks the
others — it is reported per file, so a bad `formatVersion` shows up as a scan
error rather than an empty list with no explanation.

The manifest is only an index. The books themselves live in the folder it names
(`index.json` plus `books_<mode>.jsonl.zst`) and typically run to hundreds of
megabytes, so they are usually **gitignored**. Committing the manifest alone
gives teammates the list but not the rounds: **Start Round** then reports that
the books folder is missing. Copy that folder to them out of band.

The manifest is a compact index, not the round itself. On Start Round the editor
validates its source token, streams the exact `(mode, bookId)` from the published
`books_*.jsonl.zst` named by the manifest, and injects that one outcome into the
game's next normal `/wallet/play` request. The game then follows its ordinary
XState, balance, presentation, and `/wallet/end-round` flow. A mismatched mode,
changed manifest, unsupported mock RGS, busy game, or malformed book fails closed
instead of falling back to a random round.

This tool requires the current Layout Editor bridge, a local mock RGS advertising
`forcedTestBooks`, and a game hook named `__layoutEditorStartTestBook`. The Lines
integration supplies both. Extraction uses the system Node executable because
Electron 33's embedded Node does not decode the Zstandard math export; Node 22.15+
or Node 24 is recommended. The Simulator and Performance docks are mutually
exclusive so the preview retains usable width.

## Layout profiles

The game's own responsive system resolves one of four `layoutType`s from the
viewport — `desktop`, `landscape`, `portrait`, `tablet`. The editor uses exactly
those as override profiles, plus a shared **base** profile:

- effective value = authored component value ← `base` override ← active-profile override
- The **Edit target** selector decides whether your edits write to the current
  profile (default) or to `base`.
- The inspector marks every field with its source: `P` profile override,
  `B` base override, `·` authored default. The `×` next to a field removes that
  override.
- Which profile is active is decided by the *game* at the current preview
  resolution (shown in the status bar; the preset row shows the expected one).

Copy helpers live in the **Layout ▾** menu (copy the whole current profile to
another) and at the bottom of the inspector (copy one element's overrides).

## Where the data is saved

One file in the game project:

```
apps/lines/src/game/layoutOverrides.data.ts
```

It exports a strict-JSON object literal (easy diffs in source control):

```ts
export const layoutOverridesData: LayoutOverridesData = {
	"version": 1,
	"profiles": {
		"portrait": {
			"balanceValue": { "x": 12, "y": -40 },
			"leftDecoration": { "visible": false }
		}
	}
};
```

Supported per-element properties: `x`, `y`, `width`, `height`, `scaleX`,
`scaleY`, `anchorX`, `anchorY`, `visible`, sibling `zIndex`, Sprite `assetKey`, and for text
`fontSize`, `align`.

While the dev server runs, saving hot-swaps the file into the game via Vite HMR —
no reload, the session keeps running.

## Element names

- **Sprites / Spine** are automatically named by their asset key
  (`frame_bg.png`, `foregroundAnimation`, …).
- **UI money texts** are labelled `balanceLabel/balanceValue`,
  `betLabel/betValue`, `winLabel/winValue`, `freeSpinCounterLabel/...Value`,
  plus `gameName`.
- Anything else gets an automatic id like `container#12` or `text#3` (shown in
  italics). Auto ids are stable for a given screen state but can shift if the
  mount order changes. Anonymous Container slots (the first bare `container`
  and later `container#N` rows) are therefore structural and read-only: their
  named children remain editable, but no override is saved for the temporary
  wrapper. **Give a source element an explicit label before
  overriding it if you want a guaranteed-stable id** (see below).

### Making an element editable with a stable name

Every `pixi-svelte` component already registers itself — you only add a *name*.
Pass a Pixi `label` prop to any pixi-svelte component in the game:

```svelte
<Sprite key="logo.png" label="gameLogo" ... />
<Text label="totalWinValue" ... />
<Container label="spinControls"> ... </Container>
```

For the shared `UiLabel` component, pass `editorId="myThing"` to get
`myThingLabel` / `myThingValue` ids.

## Responsive layout (adapting across resolutions)

A profile keeps one arrangement, but a fixed pixel position drifts as the
viewport changes size *within* that profile (e.g. desktop 1280×720 vs
1920×1080). The **Responsive layout** inspector section makes an element keep
its relationship to a reference area instead:

- **Frame** chooses the stable rectangle used by the rule:
  - *Viewport* is the full canvas (good for edge UI and full-screen backgrounds).
  - *Game content* is Stake's real fitted `MainContainer` frame, registered with
    `registerGameLayout(() => stateLayoutDerived.mainLayout())`. It follows the
    reels/game design area, including its centre, virtual size and fit scale.
  - *Parent layout* uses a responsive container's logical frame or a one-time
    captured parent frame. It never continuously measures child-derived Pixi
    bounds, so children cannot make their own reference drift.
- **Horizontal** and **Vertical** are independent. Each axis can keep its local
  coordinate, pin to its start/centre/end edge, or stretch between both edges.
  Mixed rules such as `Stretch width + Pin bottom` are first-class; changing one
  axis does not destroy the other.
- **Stretch both (keep margins)** and **Fill frame (zero margins)** update both
  axes atomically (one undo step). Responsive containers publish the stretched
  logical frame to children. Text deliberately offers pin/local rules rather
  than glyph-distorting stretch.
- **Size behavior** has exactly one owner:
  - *Inherit parent (native)* is Stake/Pixi's existing behavior. No extra scale
    is applied, so an element inside `MainContainer` inherits its fit exactly once.
  - *Follow Stake game layout* uses the exact SDK `mainLayout()` scale. When the
    game frame is selected it also materialises both position axes in Stake
    design coordinates, matching an element placed inside `MainContainer`.
  - *Keep screen-pixel size* cancels ancestor scale for readable fixed-size UI.
  - *Fit inside reference* / *Cover reference* uniformly contain or cover a
    sprite/Spine/graphics asset. They are alternatives to stretch and scale modes.

  Enabling, changing or removing a size behavior captures the live geometry so
  static width/height/scale fields cannot resurface and make the asset jump.
- **Offsets / margins** — the gap kept from the anchor or edges, editable
  as plain numbers. Game-frame values use Stake design units, viewport values
  use screen pixels, and parent values use that parent's local frame.
- **Convert to local/native** preserves the live position and size, then removes
  the responsive rule. In a profile, **Disable in profile** can explicitly block
  an inherited Base rule; **Use Base rule** restores inheritance.

For a logo, prefer the game's published **UI logo slot**. Stake's UI layout owns
the top-right canvas position; a logo child stays at local `x: 0`, `y: 0` with a
right/top anchor (`1, 0`). New image assets placed directly in that slot receive
those native defaults automatically. Add only the desired size behavior, such
as **Follow Stake game layout**—do not add a second viewport-position rule.

If a custom game has no native logo slot, put viewport pins on one outer
container and leave its sprite children on local/native position and size. Use
**Game content** instead of **Viewport** only when the whole group should follow
the centered Stake design frame. Do not make both a group and its child own the
same position or scale rule.

Behavior notes:

- Position and size remain independently editable after setup. Selecting
  *Follow Stake game layout* with the game frame intentionally creates both
  centered axes once, so the element enters the same design space as `MainContainer`.
- Drag, keyboard nudge, align and resize update offsets/margins/size bases rather
  than writing dead static fields. Switching rules and reparenting editor-created
  elements preserve the current visible result.
- Pin and Fit/Cover alignment use visual bounds, including anchor, pivot,
  mirroring and responsive scale. A right/top pin therefore keeps the visible
  right/top edges in place even while the asset grows. Spine elements use a
  fixed provider AABB (the setup pose by default), so animation frames cannot
  shift layout geometry.
- Responsive settings live in the same override entry, so they work per
  profile, undo/redo, save, revert, removal and reload like everything else.
  Source badges show authored (`·`), Base (`B`) or profile (`P`). Geometry-based
  Base controls pause when the active profile shadows Base, preventing the wrong
  live geometry from being captured.
- Editor-only **guides** show the reference rectangle, the anchor point + a
  connector to the element, and stretch arrows for the selected element.
- The editor explicitly synchronises each iframe resize with the SDK layout,
  Pixi renderer and override solver, then reveals the settled frame. The normal
  runtime still reacts to resize events/`ResizeObserver` without permanent polling.
- Save first flushes pending bridge edits and verifies the generated data by
  reading it back, so a quick edit-then-save cannot omit the last responsive rule.

## Adding new elements (assets & containers)

**＋ Add** (toolbar) creates new visual elements from assets already loaded by
the game — no Svelte code involved:

- **Image asset**: browse every texture in the game's `loadedAssets` (atlas
  frames included) with live thumbnails, search and refresh; pick an asset,
  give the element a stable name, choose a parent.
- **Spine animation**: browse every loaded Spine skeleton with a live preview,
  choose one of its exported animations and whether it loops, then place and
  responsively lay it out like any other Pixi element.
- **Container (group)**: an empty group for organizing/moving/scaling several
  elements together.
- **Parent** can be the **Pixi stage — persistent attachment**, an editor-created
  container, or a game-owned target explicitly published by the game. Stage
  attachment keeps an element mounted while the game runs, but loading,
  transition, and feature overlays can still cover it.
- Right-click a named live Container or Graphics object in the Layout tree and choose
  **Add child element…** to open the same Add window with that exact object
  preselected as Parent. Automatic runtime ids such as `Graphics#15` work in
  the current preview but are marked with a warning because a unique Pixi label
  is required for the saved parent relationship to remain reliable after reload.
- Anonymous Container slots (including the first bare `container` and later
  `container#N` rows) cannot be edited or used as saved parents. Their
  stable children remain independently editable. **Add separate named root…**
  creates a persistent editor Container at the stage origin; editor-created
  elements can then choose it in their Parent field. Game-authored children stay
  in their source hierarchy, so label the authored Container when that hierarchy
  itself needs a durable root.
- The hierarchy context menu always shows **Add child element…**, **Delete
  element…**, and a **Hide/Show in current layout** visibility toggle. Actions
  that do not apply to the selected object remain visible but greyed out. The
  visibility toggle uses a normal override, so it also works on automatic live
  `Graphics#` objects (but not temporary anonymous Container wrappers) and can be
  restored with Undo or Reset.
- Drag a mounted row above or below another row with the same parent to reorder
  their render layers in the current Base/profile target. Siblings are assigned
  normalized `zIndex` values. Siblings are shown front-to-back, so the first
  sibling marked **TOP** renders over the others; dragging upward brings an
  object forward. Cross-parent dragging is intentionally ignored
  because it would be a reparent operation rather than a layer reorder.
- Every selected object also has a **Layer order** inspector property with an
  editable `zIndex` and forward/back buttons. Pixi compares `zIndex` only among
  siblings: when visuals live under different containers, adjust the parent
  containers' layer order to move the complete groups above or below each other.
- Game-owned choices describe their real transform and lifecycle behavior in the
  picker. A stable-looking label alone is not treated as a parent contract:
  automatic mount-order parents such as `container#59` and unmarked game
  containers are excluded because they can identify a different object or have
  lifecycle behavior the editor cannot safely promise after a reload.
- A game publishes these choices as metadata for uniquely labeled containers;
  the metadata describes existing Stake behavior and does not create a separate
  screen-scope or scene-lifecycle system.

New elements are ordinary registry elements: select, drag, resize, scale,
hide, per-profile overrides, undo/redo, reset/revert and save all work exactly
like for game-defined elements. They are marked with a green **+** in the
hierarchy and an `editor` tag in the inspector, which also gains an **Editor
element** section: rename, reparent, choose a Spine asset/animation/loop,
z-order (▲▼), duplicate, delete (children of a deleted container are
reparented, not lost).

Parent relationships are global, while geometry overrides can differ by
profile. Reparenting preserves the currently rendered edit target exactly; if
other profiles contain their own geometry, the editor warns which profiles may
need review instead of silently implying that every unrendered layout was
converted.

Definitions are saved in the same data file under `"elements"` and are
instantiated at runtime in the editor **and in normal game runs** by
`spawnedElements.svelte.ts` (wired via `wireSpawnedElements` in the app
loader). Deleting a container in the editor never deletes game code.

### Replacing sprite assets

Every Sprite in the hierarchy can use another image texture already loaded by
the game. This includes both editor-created images and Sprites authored in the
game's Svelte source. Select the Sprite, open its image-asset property, and use
the same searchable thumbnail browser used by **Add**. Atlas frames and loose
image assets are both available.

For a game-authored Sprite, the replacement is a normal layout override. Choose
**Base** to make the image the shared default for all layouts, or edit the active
desktop / landscape / portrait / tablet profile to replace it only there. A
profile replacement wins over Base, and resetting that property reveals the
Base or source-authored texture again. The replacement is saved in
`layoutOverrides.data.ts`, so it also applies when the game runs without the
editor.

Selecting a Container exposes the descendant Sprites it contains, making it
possible to choose the actual image child to replace without hunting through a
large hierarchy. The Container itself is not converted into a Sprite. Raw Pixi
`Graphics` and `Container` objects do not own an image texture, so the editor
does not class-convert them; replace one of their Sprite descendants or add a
new image to a supported container instead.

## Removing elements

**Hide from standalone game…** / **Delete element…** (inspector, hierarchy
right-click, or the **Delete** key) opens a dialog that states the element's
name, type, origin, and child count, and offers:

- **Hide only in the current profile** — e.g. hide a decoration in portrait
  while it stays in desktop.
- **Hide in all layouts** — works for *any* stably named element, including
  code-defined ones (logos, buttons, labels, containers). Persisted as a
  `removed` flag in the override data; at runtime the element is forced
  invisible in every game state (stronger than a `visible` override — it wins
  over game logic), while the game logic itself keeps running untouched. No
  Svelte code is modified, and everything is restorable.
- **Delete permanently** (editor-created elements only) — removes the element
  definition and all its overrides from the project data. For containers you
  choose whether children are deleted too or moved to the container's parent.

Game-authored nodes stay in their Svelte source; hiding them is persistent
runtime suppression applied equally in the editor preview and standalone game.
A game-authored node with an automatic mount-order id cannot be persistently
removed: first add a unique Pixi `label`, then reload the editor. This guard
prevents a saved removal from targeting a different node after a standalone
reload.

Removal details:

- Removing a container removes everything inside it; restoring brings the
  subtree back.
- Removed elements disappear from the preview and the normal hierarchy. The
  **removed** filter chip lists them (struck-through, ✕) so they can be
  restored via right-click or the inspector's red status banner
  (*Restore in "profile"* / *Restore in all layouts*). A profile-level restore
  can also override an all-layouts removal (`removed: false`).
- Saved editor-created elements remain listed even if their runtime object or
  game-owned parent failed to mount. These detached rows can always be
  permanently deleted, so a reserved name never becomes impossible to release.
- Removal ≠ hidden by game state ≠ `visible` override: the hierarchy shows
  state-hidden elements dimmed, per-profile visibility via the eye toggle, and
  removed elements only under the *removed* chip.
- All removal/restore actions are normal undo/redo steps and appear in the
  save summary as “element removed” / “element restored”. Permanently deleted
  editor elements are restorable via Undo until you save.
- In normal (non-editor) runs, removed elements never render; the rest of the
  game is unaffected. If a removed element is still driven by game logic
  (e.g. a counter that updates its text), the logic simply runs invisibly.

## Rechecking for new assets

The asset browser lists what the *running game* has loaded. When you export or
copy a **new asset folder** into the project (e.g. a fresh atlas), it won't
appear until it is registered in the game's asset map. The **Recheck project…**
button in the asset browser bar handles that:

1. It rescans `static/assets/` on disk and parses `src/game/assets.ts` (the
   file whose entries the game actually loads at startup).
2. It shows a summary of what it found: new spritesheet atlases (with frame
   counts, missing-image and frame-name-collision warnings), new standalone
   images, and concrete Spine skeletons (`.json` or `.skel`) paired with their
   atlas. Spine parser scale is inferred from the project and remains editable.
   Incompatible JSON export/runtime versions and missing atlas pages are blocked.
   Pre-select what to register with the checkboxes.
3. **Register & reload** appends the selected entries to `assets.ts`
   (append-only, one-time `.sle-backup`, keys suggested from the file/folder
   name) and does a full preview reload so the game loads them. Unsaved layout
   edits survive the reload.
4. The new atlas frames and Spine skeletons then appear in their matching asset
   browser and work with Add Element, responsive layouts, saving, and normal
   game runs.

Notes:
- **Replaced files are detected too.** Registration keys off filenames, so
  repainting an image that is already registered — most commonly a page image
  inside an existing atlas — adds nothing "new". The recheck additionally reports
  asset files whose contents changed on disk since the last check (atlas page
  images are labelled as such) and offers **Reload game**, which clears the HTTP
  cache so the new pixels actually load. `Ctrl+R` does the same thing directly.
- Only folders under `static/assets/` following the project's structure are
  considered. Loose images are only offered from folders without an atlas
  JSON / Spine atlas / `index.ts` (folders with those typically contain atlas
  pages or format variants, not standalone sprites).
- Folder-level `index.ts` exports (produced by some asset exporters) are not
  executed by this project's loader. Recheck may use their import names only as
  a conservative pairing/key hint, then registers through `assets.ts`.
- If a project registers assets in an unfamiliar way, the recheck refuses to
  guess: **Copy details** puts a note on the clipboard describing what was
  detected and what likely needs updating, ready to paste into Fable/Claude
  Code.

## Preparing another game / fresh web-sdk (Setup menu)

**Setup → Integration status…** analyzes the open project and reports each
integration piece as ok / installable / outdated / manual, with an overall
status (Ready, Bridge missing, Bridge incomplete, Bridge outdated, Manual
setup required). For standard web-sdk projects, **Install / repair bridge**:

- copies the editor-owned bridge files (canonical copies ship in
  `resources/bridge/`),
- applies small anchored patches to the SDK files — only when they match the
  standard web-sdk shape (each patched file gets a one-time `.sle-backup`),
- creates the app loader + data file and the `context.ts` import,
- rebuilds `pixi-svelte`.

Files that don't match are reported as **manual** and never touched. For
those cases use **Setup → Open setup guide** ([SETUP_GUIDE.md](SETUP_GUIDE.md))
or **Copy AI setup prompt** ([AI_SETUP_PROMPT.md](AI_SETUP_PROMPT.md)) — a
ready-made prompt for Fable/Claude Code that recreates the integration against
the target project's own architecture.

**Setup → Verify connection…** runs a live report: data file parse, dev
server + mock RGS, bridge hello + version, profile/spawn wiring, hierarchy,
a selection round-trip, a real override application (applied and reverted),
asset listing, file writability, and a hidden-window load of the game
*without* editor mode (canvas renders, bridge stays off).

## Game states while editing

The **States ▾** menu lists actions the game registered for the editor
(`apps/lines/src/game/layoutOverrides.ts` → `registerEditorGameHooks`), e.g.
`freeSpinCounterShow`, `winShow`, `freeSpinIntroShow`. They broadcast the game's
own emitter events so state-specific elements mount and become editable. Add more
hooks there as needed — they never run outside the editor.

You can also simply play the game in **Play** mode (spins run against the mock
RGS with the real math files) and switch to **Edit** mode at any moment.

## Keyboard

| Keys | Action |
| --- | --- |
| Arrows | nudge selected element 1px (Shift = 10, Alt = 0.1) |
| Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z | undo / redo |
| Ctrl+S | save (with summary) |
| Ctrl+R | reload the **game** preview, clearing the HTTP cache first |
| Ctrl+Shift+R | reload the **whole editor** and restart its managed mock RGS (prompts if there are unsaved changes) |
| Ctrl+M | mute / unmute the game preview |
| Delete | remove selected element (opens the removal dialog) |
| Esc | clear selection |
| click again / Alt+click | cycle overlapping elements |
| Shift while resizing | keep aspect ratio (corners always keep it) |

In Edit mode the game does not receive keyboard/pointer input; in Play mode the
editor does not intercept anything. The reload and mute shortcuts are the
exception — they are handled by the main process, so they work even while the
game iframe has focus.

**Use Ctrl+R after replacing an asset file in place.** Repainting an image that is
already registered (for example a page image inside an existing atlas) changes no
filename, so nothing new appears in *Recheck project…* — but the old pixels stay
cached until the game is reloaded with the cache cleared, which is exactly what
Ctrl+R does.

## Guides & snapping

**Guides ▾**: center lines, safe-area (percent insets), grid (+ size), snapping
toggle, all-bounds overlay. Snapping targets screen edges/center, safe-area
edges, grid lines, and nearby element edges/centers. Guides exist only in the
editor overlay — never in the game.

## Integration

The integration lives in the game workspace (already applied to
`moderator_madness/web-sdk`):

| File | Change |
| --- | --- |
| `packages/pixi-svelte/src/lib/layoutOverrides.svelte.ts` | **new** — override runtime + element registry (`LAYOUT_EDITOR_BRIDGE_VERSION`) |
| `packages/pixi-svelte/src/lib/spawnedElements.svelte.ts` | **new** — runtime for editor-created elements |
| `packages/pixi-svelte/src/lib/performanceSampler.ts` | **new** — opt-in editor-only FPS, CPU timing, and draw-submission sampler |
| `packages/pixi-svelte/src/lib/testBookRequest.ts` | **new** — guarded one-shot exact-book injection for local testcase rounds |
| `packages/pixi-svelte/src/lib/editorBridge.ts` | **new** — in-page editor bridge, only loads with `?editor` in the URL |
| `packages/pixi-svelte/src/lib/utils.svelte.ts` | `propsSyncEffect` applies overrides after prop sync |
| `packages/pixi-svelte/src/lib/context.svelte.ts` | `addToParent` registers/unregisters nodes |
| `packages/pixi-svelte/src/lib/components/InitialiseApplication.svelte` | loads the bridge when `?editor` is present |
| `packages/pixi-svelte/src/lib/components/Sprite.svelte`, `SpineProvider.svelte` | default `label` = asset key |
| `packages/components-ui-pixi/.../UiLabel.svelte` + `Label*.svelte`, `UiGameName.svelte` | stable labels for UI texts |
| `apps/lines/src/game/layoutOverrides.data.ts` | **new** — the saved layout data (generated) |
| `apps/lines/src/game/layoutOverrides.ts` | **new** — loads the data + registers editor game hooks |
| `apps/lines/src/game/context.ts` | one side-effect import of the loader |

After changing anything in `packages/pixi-svelte`, rebuild it:
`pnpm --filter pixi-svelte build`.

In a normal (non-editor) game run the only extra work is one function call per
prop sync and loading the data file — the bridge module is never even fetched.

## Troubleshooting

- **Preview never connects** — check the Logs panel. The game URL needs a valid
  `VITE_SESSION_ID` in the app's `.env.local` when using the real RGS; with the
  local mock RGS any session id works.
- **Port already in use** — the editor *attaches* to whatever already listens on
  the app's dev port / RGS port instead of spawning a second copy. Before
  attaching to a dev server it did not start, it compares a sweep of the opened
  project's `static/assets` manifests against the ones the server returns. If
  they disagree the attach is refused with the conflicting file named, because
  game apps hardcode the same `--port` and a leftover server from another
  project would otherwise render *that* game while your edits saved into this
  one. Stop the other server and press **Start Preview** again.
- **Switching projects still shows the previous game's assets** — fixed: opening
  a different app now stops the servers this editor started for the old one,
  clears the cached asset list and thumbnails, and re-resolves the dev port.
  The asset grid comes from the *running game* over the bridge, not from disk,
  so it can only ever show what the preview is actually serving.
- **Game reloads while editing** — editing files in the workspace (or rebuilding
  `pixi-svelte`) triggers Vite reload; the editor reconnects and re-applies your
  unsaved overrides automatically.
- **Auto ids shifted after a big game-state change** — give those elements
  explicit `label`s (see above); ids from labels never shift.
- **Overriding animated elements** — overriding `x/y/scale` on an element the
  game animates through those same props freezes that animation for the element;
  prefer overriding a parent container, or its width/height.

## Building a Windows executable

```bash
npm run dist    # electron-builder → release/ (NSIS installer + portable exe)
```

## Scope

By design this tool edits layout only: position, size, scale, anchor,
per-profile visibility, text layout properties and loaded-image replacement for
Sprites — plus adding simple visual elements (sprites and Spine skeletons from
existing game assets, and grouping containers). It can select an exported Spine
animation and its loop flag; it does not class-convert raw Graphics/Containers,
author or edit animation timelines, sounds, math or game logic, or create new
asset files or Svelte components.
