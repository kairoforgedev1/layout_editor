# Codebase Review — moderator_madness/web-sdk (lines game)

Review performed before building the Layout Editor, as the basis for its design.

## Project structure

- Turbo + pnpm monorepo (`web-sdk/`): one app (`apps/lines`) + ~25 workspace
  packages (`pixi-svelte`, `utils-layout`, `components-layout`,
  `components-ui-pixi`, `components-shared`, `state-shared`, `rgs-requests`, …).
- `apps/lines` is a SvelteKit SPA (`ssr = false`, `prerender = true`) served by
  Vite on port 3001 (`pnpm dev`, after `scripts/dev-url.js` prints the play URL).
- Real math files live in `apps/lines/static/data` (books + lookup tables); the
  Express **mock RGS** (`moderator_madness/mock-rgs-server`, port 3002) serves
  the Stake Engine wallet API against those files. The app selects the RGS via
  `?rgs_url=` / `VITE_RGS_URL` and authenticates with `?sessionID=`.

## Rendering

Everything visual is **PixiJS v8 on a single GPU canvas** (WebGPU preferred,
WebGL fallback) — there is no
per-element DOM. Svelte components from `pixi-svelte` (`Sprite`, `Text`,
`BitmapText`, `Container`, `SpineProvider`, `Rectangle`, `Graphics`,
`AnimatedSprite`, particles) each create one Pixi display object and:

1. sync every Svelte prop onto the object inside `propsSyncEffect()`
   (`packages/pixi-svelte/src/lib/utils.svelte.ts`) — one `$effect` per element
   through which **all** layout properties flow;
2. attach to their parent through `addToParent()`
   (`packages/pixi-svelte/src/lib/context.svelte.ts`) — the single choke point
   for scene-graph membership and destruction.

`pixi-svelte` is a built package (`svelte-package` → `dist`, consumed by the app
from dist with runes intact), so package edits need `pnpm --filter pixi-svelte build`.
The other component packages are consumed directly from source.

## Layout system

- `utils-layout/createLayout` derives a **`layoutType`** — `desktop` |
  `landscape` | `portrait` | `tablet` — from `window.innerWidth/innerHeight`
  (the Pixi app is `resizeTo: window`), via ratio + device-width breakpoints.
- `MainContainer` (components-layout) centers and uniformly scales a virtual
  space per layout type (from the app's `mainSizesMap`, e.g. desktop 1422×800),
  optionally edge-aligned. Backgrounds use ratio-based cover layouts.
- **Actual element positions are hard-coded inline in Svelte markup** — e.g.
  `LayoutDesktop.svelte` has `<Container y={DESKTOP_BASE_SIZE*0.5} x={220} scale={0.8}>`
  per button; game components compute positions from constants
  (`SYMBOL_SIZE`, board layout) or ad-hoc arithmetic. There is **no central
  layout data file** — values are scattered across the app and shared packages.
  This is exactly what makes manual layout tweaking slow, and it rules out
  "rewrite the components" as a save strategy.

## State / game flow

- xstate-style actor + `eventEmitter` (typed union per component:
  `freeSpinCounterShow`, `winShow`, `transition`, …) drive game states; UI state
  lives in `state-shared` runes stores. `Authenticate` (components-shared) does
  the RGS handshake before the game mounts. Book events map to emitter events in
  `bookEventHandlerMap.ts`.

## Conclusions that shaped the editor

1. **Selection/editing must happen at the Pixi display-object level** (no DOM).
   An in-page bridge walks the objects and hit-tests display bounds: `getBounds()`
   for ordinary nodes, and a fixed bounds-provider AABB for Spine so animations
   cannot move the hit area. Stage coordinates == CSS px because the canvas is
   unscaled at the root, so the bridge draws its overlay as DOM above the canvas.
2. **Overrides must be applied after prop sync** to reliably win over authored
   values and stay live under reactivity — so the runtime hooks the end of
   `propsSyncEffect` and re-runs on a reactive version counter. This also makes
   the same mechanism work in normal runs (saved data) and editor runs (live).
3. **Profiles = the game's own four layoutTypes + base.** The game already
   re-renders on viewport change; simulating a device is just sizing the iframe.
4. **Identity**: Pixi `label` where authored (asset keys give good free names for
   sprites/spine; a few one-line label additions cover the UI money texts);
   otherwise slot-stable auto ids (`container#12`). Anonymous Container slots are
   structural-only and never persisted; their named descendants remain editable.
   Labels are the way to give a source container durable identity.
5. **Persistence**: one generated TS data module in the app
   (`src/game/layoutOverrides.data.ts`, strict-JSON literal — the repo's
   tsconfig has `resolveJsonModule: false`, so a `.json` import was rejected),
   loaded by a small side-effect module wired into the existing `context.ts`,
   with an HMR accept hook so editor saves apply without reloading the game.
6. **Safe-to-edit surface**: positions/sizes/scales/anchors/visibility of
   display objects and text layout properties. Overriding props the game
   animates per-frame (reel symbols during spins, fade alpha) is possible but
   freezes those animations — the editor exposes `visible` (not `alpha`) and
   documents the caveat.
7. **Performance telemetry stays editor-only and opt-in.** The in-page bridge
   can attach constant-time probes to the Pixi application ticker, renderer
   lifecycle, and backend draw-submission path while its side panel is open. It
   reports 250 ms aggregates and detaches every hook when closed; it does not
   traverse display objects or claim GPU execution time.

## Limitations found

- Auto ids for unlabeled elements depend on mount order within a state
  (mitigated by slot reuse + labels).
- `width`/`height` on containers are bounds-derived in Pixi; the editor resizes
  containers via scale instead and reserves width/height for
  sprites/text (intrinsic size).
- Rebuilding `pixi-svelte` or editing app files triggers a Vite full reload of
  the game (session restarts); the editor re-syncs unsaved overrides on
  reconnect.
- The `sessionID` in `.env.local` expires when pointed at the real RGS; the
  mock RGS accepts anything.
