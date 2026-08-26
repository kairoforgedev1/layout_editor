/**
 * Layout override runtime used by the Layout Editor desktop tool.
 *
 * The game keeps its authored layout values inline in Svelte markup. This module
 * lets a project apply per-profile overrides (position/size/scale/visibility,
 * Sprite texture and text layout) on top of those authored values without
 * touching the components.
 *
 * - Overrides are applied inside `propsSyncEffect` (after props are synced), so an
 *   override always wins over the authored prop value and stays reactive.
 * - Profiles map 1:1 to the game's responsive `layoutType` (desktop / landscape /
 *   portrait / tablet) plus a shared `base` profile. A profile value wins over base.
 * - The registry below tracks every display object created through pixi-svelte so
 *   the editor bridge can enumerate, name and hit-test them.
 *
 * In a normal (non-editor) run the only cost is one extra function call per prop
 * sync and the JSON file the app loads at startup.
 */

/** Bumped whenever the editor integration surface changes. The Layout Editor
 *  compares this against the version it expects to detect outdated bridges. */
export const LAYOUT_EDITOR_BRIDGE_VERSION = 11;
/** Exact solver/integration revision within a bridge protocol version. */
export const LAYOUT_EDITOR_BRIDGE_REVISION = '2026-08-21-spawned-runtime-hooks-v1';

export type GameLayoutType = 'desktop' | 'landscape' | 'portrait' | 'tablet';
export type LayoutProfileName = 'base' | GameLayoutType;

/**
 * Responsive layout config (an override field). Makes an element keep its
 * relationship to a reference rectangle as the viewport/parent resizes, so a
 * single profile arrangement stays aligned across resolutions.
 *
 * The reference rect is the game viewport (default) or the immediate parent's
 * area, expressed in the element's parent coordinate space.
 *
 * Per axis, exactly one behavior applies:
 *  - `stretchX`/`stretchY`: the element spans the reference minus pixel margins.
 *  - `x`/`y`: the element's origin is anchored at `anchor` (0..1) within the
 *    reference plus a pixel `offset` (a fixed margin from that anchor).
 *  - neither: the axis keeps its static/authored value.
 * `aspect` (sprites/spine) uniformly scales the element to contain/cover the ref.
 */
export type ResponsiveAxisAnchor = { anchor: number; offset: number };
export type ResponsiveStretch = { m0: number; m1: number };

/**
 * How an element's size reacts to viewport changes. Independent of position.
 *
 *  - `parent` (default / absent): no responsive scale — the element keeps its
 *    local scale and therefore naturally inherits whatever its parent does.
 *    This is the pre-existing behavior, so saved layouts are unaffected.
 *  - `game`: the element's *world* scale follows the game's own main-content
 *    scale (the exact scale returned by Stake's `mainLayout()`).
 *  - `fixed`: the world scale is held constant, so the element keeps the same
 *    on-screen size even when its parent scales.
 *
 * In every non-`parent` mode the local scale is derived as
 * `targetWorldScale / parentWorldScale`, which makes nesting double-scale-proof:
 * an element inside an already-scaling parent simply gets a constant local scale.
 */
export type ResponsiveScaleMode = 'parent' | 'game' | 'fixed';

export type ResponsiveConfig = {
	/** Stable rectangle used for responsive position/stretch calculations. */
	ref?: 'viewport' | 'game' | 'parent';
	/**
	 * What an x/y anchor aligns within the reference. `bounds` (default) aligns
	 * the visible AABB; `origin` pins node.x/y and is stable for containers whose
	 * child bounds animate or mount/unmount.
	 */
	positionMode?: 'bounds' | 'origin';
	x?: ResponsiveAxisAnchor;
	y?: ResponsiveAxisAnchor;
	stretchX?: ResponsiveStretch;
	stretchY?: ResponsiveStretch;
	aspect?: 'contain' | 'cover';
	/** Persisted mirror orientation for deterministic contain/cover sizing. */
	aspectSign?: { x: 1 | -1; y: 1 | -1 };
	/**
	 * Snapshot of an ordinary Pixi parent's local layout frame. Pixi Containers do
	 * not own a box (their bounds come from their children), so parent-relative
	 * rules must never continuously re-measure getLocalBounds(). Responsive editor
	 * containers provide a live logical frame instead and take precedence.
	 */
	parentRect?: ResponsiveRect;
	/** Fixed logical size for a container acting as a responsive parent. */
	logicalW?: number;
	logicalH?: number;
	/** Responsive sizing (see ResponsiveScaleMode). */
	scaleMode?: ResponsiveScaleMode;
	/** Target world scale when the mode's factor is 1 (captured on enable). */
	scaleBase?: { x: number; y: number };
};

/** An element created from the Layout Editor (not defined in game code). */
export type SpawnedElementDef = {
	id: string;
	kind: 'sprite' | 'spine' | 'container';
	/** loadedAssets key (textures for sprites, SkeletonData for Spine). */
	assetKey?: string;
	/** Track-0 animation played by editor-created Spine elements. */
	animationName?: string;
	/** Whether the selected Spine animation repeats. Defaults to true. */
	loop?: boolean;
	/** Registered element id to attach to; omitted/null = stage root. */
	parentId?: string | null;
	/** zIndex among siblings. */
	order?: number;
};

export type LayoutOverrideProps = {
	/**
	 * loadedAssets texture key used in place of a game-authored Sprite's texture.
	 * This is a virtual field: the authored texture is retained and restored when
	 * the override is cleared or a different layout profile becomes active.
	 */
	assetKey?: string;
	x?: number;
	y?: number;
	scaleX?: number;
	scaleY?: number;
	width?: number;
	height?: number;
	anchorX?: number;
	anchorY?: number;
	visible?: boolean;
	/** Pixi sibling layer order. Higher values render on top. */
	zIndex?: number;
	fontSize?: number;
	align?: 'left' | 'center' | 'right' | 'justify';
	/**
	 * Element removal (stronger than `visible`): forces the element invisible in
	 * every game state. In `base` it removes the element from all layouts; a
	 * profile can override with `removed: false` to restore it there. Applied at
	 * runtime as forced invisibility — game logic keeps running unaffected.
	 */
	removed?: boolean;
	/** Responsive positioning/sizing relative to the viewport or parent. */
	/** `false` explicitly disables a rule inherited from the base profile. */
	responsive?: ResponsiveConfig | false;
};

export type LayoutOverrideField = keyof LayoutOverrideProps;

export type LayoutOverridesData = {
	version: number;
	profiles: Partial<Record<LayoutProfileName, Record<string, LayoutOverrideProps>>>;
	/** Elements created from the Layout Editor. */
	elements?: SpawnedElementDef[];
};

/** A stable, game-authored host that the editor may offer as a parent. */
export type EditorParentTarget = {
	/** Short user-facing role name. */
	label: string;
	/** Truthful lifecycle and coordinate-space guidance for this host. */
	description: string;
	/** Display order in the editor's parent picker. */
	order: number;
	/** Native initial transform for a child newly attached to this host. */
	childDefaults?: {
		x?: number;
		y?: number;
		anchorX?: number;
		anchorY?: number;
	};
};

export type EditorGameHooks = {
	/** Named, editor-triggerable game actions (usually eventEmitter broadcasts). */
	gameEvents?: Record<string, (payload?: unknown) => unknown | Promise<unknown>>;
	/**
	 * Stable, source-authored attachment points keyed by their registered layout
	 * id. This is descriptive metadata only; lifecycle stays owned by the game.
	 */
	parentTargets?: Record<string, EditorParentTarget>;
};

// Application order matters: scale before width/height (width assignment adjusts
// scale on sprites), position after visibility so bounds stay coherent.
const FIELD_ORDER: LayoutOverrideField[] = [
	'visible',
	'zIndex',
	'x',
	'y',
	'anchorX',
	'anchorY',
	'scaleX',
	'scaleY',
	'width',
	'height',
	'fontSize',
	'align',
];

// Which component prop feeds each overridable field. When a prop with that name is
// present, the authored snapshot for the field is refreshed on every sync (the prop
// assignment ran just before us), so "reset to default" tracks live authored values.
const FIELD_PROP_SOURCE: Record<LayoutOverrideField, string> = {
	// `assetKey` is virtual. The authored Pixi texture is captured separately and
	// the loaded-asset resolver applies it before size/responsive layout is solved.
	assetKey: 'texture',
	x: 'x',
	y: 'y',
	scaleX: 'scale',
	scaleY: 'scale',
	width: 'width',
	height: 'height',
	anchorX: 'anchor',
	anchorY: 'anchor',
	visible: 'visible',
	zIndex: 'zIndex',
	fontSize: 'style',
	align: 'style',
	// `removed` is virtual — it resolves into `visible` before field application
	// (see applyLayoutOverrides) and never appears in FIELD_ORDER.
	removed: 'visible',
	// `responsive` is virtual — it computes x/y/width/height/scale and never
	// appears in FIELD_ORDER; its source props are position/scale/size.
	responsive: 'x',
};

// `version` bumps on override-data edits; `viewport` bumps on resize so that
// responsive elements recompute against the new viewport/parent size.
const runtime = $state({ version: 0, viewport: 0 });

let data: LayoutOverridesData = { version: 1, profiles: {} };
let getLayoutType: () => GameLayoutType = () => 'desktop';
let layoutTypeWired = false;
let editorGameHooks: EditorGameHooks = {};
const sampleTexts = new Map<string, string>();
let resolveLayoutTexture: ((assetKey: string) => unknown | null) | null = null;

const bump = () => {
	runtime.version += 1;
};

/**
 * Wire the game's loaded texture catalog into the layout override runtime.
 * Kept as a resolver callback so this core module does not import Pixi or create
 * a cycle with spawnedElements.svelte.ts.
 */
export function registerLayoutAssetResolver(
	resolver: ((assetKey: string) => unknown | null) | null,
) {
	resolveLayoutTexture = resolver;
	bump();
}

/**
 * Remove values that the v3 solver does not read and migrate the old captured-
 * viewport mode to Stake's authoritative game layout. Keeping this at every
 * data boundary means old override files remain loadable but are saved cleanly.
 */
const removeResponsiveOwnedGeometry = (entry: AnyNode, cfg: AnyNode) => {
	if (cfg.x || cfg.stretchX) delete entry.x;
	if (cfg.y || cfg.stretchY) delete entry.y;
	if (cfg.stretchX) delete entry.width;
	if (cfg.stretchY) delete entry.height;
	if (cfg.aspect || cfg.scaleMode) {
		delete entry.width;
		delete entry.height;
		delete entry.scaleX;
		delete entry.scaleY;
	}
	return entry;
};

export function compactLayoutOverrideEntry(source: LayoutOverrideProps): LayoutOverrideProps {
	const entry: AnyNode = { ...source };
	const raw = entry.responsive;
	if (!raw || typeof raw !== 'object') return entry;

	const cfg: AnyNode = { ...raw };
	if (cfg.scaleMode === 'screen') cfg.scaleMode = 'game';
	delete cfg.scaleRefW;
	delete cfg.scaleRefH;
	if (cfg.scaleMode === 'parent') delete cfg.scaleMode;
	if (!cfg.scaleMode) delete cfg.scaleBase;
	if (!cfg.aspect) delete cfg.aspectSign;
	if (cfg.positionMode !== 'origin') delete cfg.positionMode;
	if (cfg.ref !== 'parent') delete cfg.parentRect;

	// Responsive geometry is the final owner of these properties. Removing dead
	// static values prevents an old width/position from resurfacing after reload.
	removeResponsiveOwnedGeometry(entry, cfg);
	entry.responsive = cfg;
	return entry;
}

const compactProfiles = (
	profiles: LayoutOverridesData['profiles'] | undefined,
): LayoutOverridesData['profiles'] => {
	const result: LayoutOverridesData['profiles'] = {};
	for (const [profile, entries] of Object.entries(profiles ?? {})) {
		const nextEntries: Record<string, LayoutOverrideProps> = {};
		for (const [id, entry] of Object.entries(entries ?? {})) {
			nextEntries[id] = compactLayoutOverrideEntry(entry);
		}
		if (Object.keys(nextEntries).length) {
			result[profile as LayoutProfileName] = nextEntries;
		}
	}
	const baseEntries = result.base ?? {};
	for (const profile of ['desktop', 'landscape', 'portrait', 'tablet'] as GameLayoutType[]) {
		const entries = result[profile];
		for (const [id, entry] of Object.entries(entries ?? {})) {
			if (entry.responsive !== undefined) continue;
			const inherited = baseEntries[id]?.responsive;
			if (inherited && typeof inherited === 'object') {
				removeResponsiveOwnedGeometry(entry, inherited);
				if (Object.keys(entry).length === 0) delete entries![id];
			}
		}
		if (entries && Object.keys(entries).length === 0) delete result[profile];
	}
	return result;
};

/** Reactive read of the viewport version (bumped on resize). */
export function getViewportVersion() {
	return runtime.viewport;
}

/** Editor bridge hook: recompute every responsive node for one settled frame. */
export function refreshViewportLayout() {
	runtime.viewport += 1;
}

let viewportWatchInstalled = false;
/**
 * Bump the viewport signal on window resize so responsive elements recompute.
 * A short rAF burst follows each resize so parent transforms (which settle over
 * a frame or two after a resize) are fresh by the time we read them.
 */
function installViewportWatch() {
	if (viewportWatchInstalled || typeof window === 'undefined') return;
	viewportWatchInstalled = true;
	let raf = 0;
	const onResize = () => {
		refreshViewportLayout();
		if (raf) cancelAnimationFrame(raf);
		let n = 0;
		const tick = () => {
			refreshViewportLayout();
			if (++n < 6) raf = requestAnimationFrame(tick);
			else raf = 0;
		};
		raf = requestAnimationFrame(tick);
	};
	window.addEventListener('resize', onResize);
	// ResizeObserver catches programmatic iframe/document sizing without keeping a
	// permanent requestAnimationFrame loop alive in normal game runs.
	if (typeof ResizeObserver !== 'undefined' && document?.documentElement) {
		const observer = new ResizeObserver(onResize);
		observer.observe(document.documentElement);
	}
}

/** Load persisted override data. Called once by the game project at startup. */
export function loadLayoutOverrides(
	next: LayoutOverridesData | undefined,
	layoutTypeGetter?: () => GameLayoutType,
) {
	if (next && typeof next === 'object' && next.profiles) {
		data = {
			version: next.version ?? 1,
			profiles: compactProfiles(next.profiles),
			elements: Array.isArray(next.elements) ? next.elements : [],
		};
	}
	if (layoutTypeGetter) {
		getLayoutType = layoutTypeGetter;
		layoutTypeWired = true;
	}
	installViewportWatch();
	bump();
}

/** Reactive read of the override data version (for effects outside prop sync). */
export function getLayoutOverridesVersion() {
	return runtime.version;
}

/**
 * Register the game's own main-content scale (the factor it already uses to fit
 * its design-size content to the canvas — e.g. `stateLayoutDerived.mainLayout().scale`).
 * Elements in `game` scale mode follow exactly this, so editor-added assets grow
 * and shrink in step with the reels and UI instead of staying a fixed pixel size.
 */
export type GameLayoutFrame = {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
	anchor?: number | { x?: number; y?: number };
};

let getGameScaleFn: (() => number) | null = null;
let getGameLayoutFn: (() => GameLayoutFrame) | null = null;

export function registerGameScale(getter: () => number) {
	getGameScaleFn = getter;
}

/**
 * Register the exact virtual frame used by Stake's MainContainer. This gives
 * editor-managed stage elements the same centered design space as reels/game
 * content for both position and size. registerGameScale remains supported for
 * older integrations, but it cannot provide edge/corner geometry.
 */
export function registerGameLayout(getter: () => GameLayoutFrame) {
	getGameLayoutFn = getter;
}

export function isGameScaleWired() {
	return !!getGameLayoutFn || !!getGameScaleFn;
}

export function isGameLayoutWired() {
	return !!getGameLayoutFn;
}

export function getGameLayout(): GameLayoutFrame | null {
	if (!getGameLayoutFn) return null;
	try {
		const value = getGameLayoutFn();
		if (
			!value ||
			![value.x, value.y, value.width, value.height, value.scale].every(Number.isFinite) ||
			value.width <= 0 ||
			value.height <= 0 ||
			value.scale <= 0
		) return null;
		return value;
	} catch {
		return null;
	}
}

/** The game's main-content scale, or null when the project hasn't wired one. */
export function getGameScale(): number | null {
	const layout = getGameLayout();
	if (layout) return layout.scale;
	if (!getGameScaleFn) return null;
	try {
		const value = getGameScaleFn();
		return Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		return null;
	}
}

/** Register editor-only hooks (e.g. events that jump the game into a state). */
export function registerEditorGameHooks(hooks: EditorGameHooks) {
	editorGameHooks = {
		gameEvents: { ...editorGameHooks.gameEvents, ...hooks.gameEvents },
		parentTargets: { ...editorGameHooks.parentTargets, ...hooks.parentTargets },
	};
}

export function getEditorGameHooks() {
	return editorGameHooks;
}

export function isLayoutTypeWired() {
	return layoutTypeWired;
}

export function getActiveLayoutType(): GameLayoutType {
	return getLayoutType();
}

export function getLayoutOverridesData(): LayoutOverridesData {
	return data;
}

/** Replace the whole override set (editor bridge full sync). */
export function replaceLayoutOverrides(
	profiles: LayoutOverridesData['profiles'],
	elements?: SpawnedElementDef[],
) {
	data = {
		version: data.version ?? 1,
		profiles: compactProfiles(profiles),
		elements: Array.isArray(elements) ? elements : (data.elements ?? []),
	};
	bump();
}

// ---------------------------------------------------------------------------
// Spawned (editor-created) element marking
// ---------------------------------------------------------------------------

const spawnedNodes = new WeakSet<object>();
const spawnedDefinitionIds = new WeakMap<object, string>();

export function markSpawnedNode(node: object, definitionId?: string) {
	spawnedNodes.add(node);
	if (definitionId) spawnedDefinitionIds.set(node, definitionId);
}

export function isSpawnedNode(node: object) {
	return spawnedNodes.has(node);
}

export function getSpawnedDefinitionId(node: object) {
	return spawnedDefinitionIds.get(node) ?? null;
}

/**
 * Merge (or delete, when a value is null/undefined) override props for one element
 * in one profile. Used by the editor bridge during drag/resize gestures.
 */
export function setLayoutOverride(
	profile: LayoutProfileName,
	id: string,
	props: { [K in LayoutOverrideField]?: LayoutOverrideProps[K] | null },
) {
	const profileMap = (data.profiles[profile] = data.profiles[profile] ?? {});
	const entry = (profileMap[id] = profileMap[id] ?? {});
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined) {
			delete entry[key as LayoutOverrideField];
		} else {
			// @ts-ignore - schema is validated by the editor
			entry[key as LayoutOverrideField] = value;
		}
	}
	profileMap[id] = compactLayoutOverrideEntry(entry);
	if (Object.keys(profileMap[id]).length === 0) delete profileMap[id];
	if (Object.keys(profileMap).length === 0) delete data.profiles[profile];
	bump();
}

/** Editor-only: preview a different text on a text element. Never persisted. */
export function setSampleText(id: string, text: string | null) {
	if (text === null) sampleTexts.delete(id);
	else sampleTexts.set(id, text);
	bump();
}

export function getMergedOverride(id: string): LayoutOverrideProps {
	const layoutType = getLayoutType();
	return { ...data.profiles.base?.[id], ...data.profiles[layoutType]?.[id] };
}

// ---------------------------------------------------------------------------
// Element registry
// ---------------------------------------------------------------------------

type AnyNode = any;

const liveNodes = new Set<AnyNode>();
const nodeIds = new WeakMap<AnyNode, string>();
const nodeBaseNames = new WeakMap<AnyNode, string>();
// base name -> slot array. A node keeps its slot for its lifetime; freed slots are
// reused by the next same-named node, keeping ids stable across state changes.
const nameSlots = new Map<string, (AnyNode | undefined)[]>();
const registryListeners = new Set<() => void>();
let postMountLayoutRefreshQueued = false;

/**
 * Responsive props can run before pixi-svelte's onMount callback attaches a
 * node to its Pixi parent. Re-solve once after the whole mount batch so
 * game-relative transforms and content-derived bounds use the settled tree.
 */
const schedulePostMountLayoutRefresh = () => {
	if (postMountLayoutRefreshQueued) return;
	postMountLayoutRefreshQueued = true;
	const refresh = () => {
		postMountLayoutRefreshQueued = false;
		refreshViewportLayout();
	};
	if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refresh);
	else queueMicrotask(refresh);
};

const notifyRegistry = () => {
	registryListeners.forEach((listener) => {
		try {
			listener();
		} catch (error) {
			console.error(error);
		}
	});
};

export function onLayoutRegistryChange(listener: () => void) {
	registryListeners.add(listener);
	return () => registryListeners.delete(listener);
}

export function registerLayoutNode(node: AnyNode) {
	if (!node) return;
	const needsPostMountLayoutRefresh = node.__sleNeedsPostMountLayoutRefresh === true;
	node.__sleNeedsPostMountLayoutRefresh = undefined;
	liveNodes.add(node);
	notifyRegistry();
	if (needsPostMountLayoutRefresh) schedulePostMountLayoutRefresh();
}

export function unregisterLayoutNode(node: AnyNode) {
	if (!node) return;
	liveNodes.delete(node);
	const baseName = nodeBaseNames.get(node);
	if (baseName) {
		const slots = nameSlots.get(baseName);
		const index = slots ? slots.indexOf(node) : -1;
		if (slots && index >= 0) slots[index] = undefined;
	}
	notifyRegistry();
}

export function getRegisteredLayoutNodes(): AnyNode[] {
	// Self-heal the registry. A node destroyed without unregisterLayoutNode() (e.g.
	// a Pixi object torn down imperatively rather than by its Svelte component's
	// teardown) would otherwise be retained forever by this strong Set — leaking its
	// whole subtree/textures AND making this scan, which the editor bridge runs every
	// frame, progressively slower until the preview stalls. Purge destroyed nodes here
	// instead of merely filtering them out of the returned array. Deleting the current
	// element mid-iteration is well-defined for a Set.
	const alive: AnyNode[] = [];
	for (const node of liveNodes) {
		if (node.destroyed) {
			liveNodes.delete(node);
			const baseName = nodeBaseNames.get(node);
			if (baseName) {
				const slots = nameSlots.get(baseName);
				const index = slots ? slots.indexOf(node) : -1;
				if (slots && index >= 0) slots[index] = undefined;
			}
		} else {
			alive.push(node);
		}
	}
	return alive;
}

const isTextLike = (node: AnyNode) => typeof node?.text === 'string' && !!node?.style;

const autoBaseName = (node: AnyNode): string => {
	if (typeof node.label === 'string' && node.label) return node.label;
	if (node.skeleton) return 'spine';
	if (isTextLike(node)) return 'text';
	if (node.texture && node.anchor) return 'sprite';
	if (typeof node.fill === 'function' || node.context) return 'graphics';
	return 'container';
};

const temporaryLayoutContainerIds = new Set<string>();

/** Anonymous/reserved Containers are runtime slots, not persistent targets. */
export function isTemporaryLayoutContainerNode(node: AnyNode): boolean {
	if (!node) return false;
	const id = ensureLayoutId(node);
	if (temporaryLayoutContainerIds.has(id)) return true;
	if (node.texture || isTextLike(node) || node.context || node.skeleton) return false;
	const label = typeof node?.label === 'string' ? node.label.trim() : '';
	if (/^container#\d+$/.test(id)) temporaryLayoutContainerIds.add(id);
	if (!isSpawnedNode(node) && !label) temporaryLayoutContainerIds.add(id);
	return temporaryLayoutContainerIds.has(id);
}

/** Assign (once) and return the stable element id for a display object. */
export function ensureLayoutId(node: AnyNode): string {
	const existing = nodeIds.get(node);
	if (existing) return existing;
	const baseName = autoBaseName(node);
	const slots = nameSlots.get(baseName) ?? [];
	let slot = slots.indexOf(undefined);
	if (slot === -1) slot = slots.length;
	slots[slot] = node;
	nameSlots.set(baseName, slots);
	const id = slot === 0 ? baseName : `${baseName}#${slot + 1}`;
	nodeIds.set(node, id);
	nodeBaseNames.set(node, baseName);
	return id;
}

// ---------------------------------------------------------------------------
// Override application (called from propsSyncEffect, inside an $effect)
// ---------------------------------------------------------------------------

const readField = (node: AnyNode, field: LayoutOverrideField): unknown => {
	switch (field) {
		case 'x':
			return node.x;
		case 'y':
			return node.y;
		case 'scaleX':
			return node.scale?.x;
		case 'scaleY':
			return node.scale?.y;
		case 'width':
			return node.skeleton ? getLayoutDisplaySize(node)?.width : node.width;
		case 'height':
			return node.skeleton ? getLayoutDisplaySize(node)?.height : node.height;
		case 'anchorX':
			return node.anchor?.x;
		case 'anchorY':
			return node.anchor?.y;
		case 'visible':
			return node.visible;
		case 'zIndex':
			return node.zIndex ?? 0;
		case 'fontSize':
			return node.style?.fontSize;
		case 'align':
			return node.style?.align;
	}
};

/**
 * Read a baseline value before the editor owns it. A Spine dimension may become
 * available after a scale override was already staged, so derive that dimension
 * from the captured authored scale instead of the currently overridden scale.
 */
const readAuthoredField = (
	node: AnyNode,
	field: LayoutOverrideField,
	authored: Partial<Record<LayoutOverrideField, unknown>>,
): unknown => {
	if (node?.skeleton && (field === 'width' || field === 'height')) {
		const bounds = getLayoutLocalBounds(node);
		if (!bounds) return undefined;
		const axis = field === 'width' ? 'x' : 'y';
		const scaleField = field === 'width' ? 'scaleX' : 'scaleY';
		const capturedScale = Number(authored[scaleField]);
		const liveScale = Number(node.scale?.[axis]);
		const scale = Number.isFinite(capturedScale) ? capturedScale : liveScale;
		if (!Number.isFinite(scale)) return undefined;
		return (field === 'width' ? bounds.width : bounds.height) * Math.abs(scale);
	}
	return readField(node, field);
};

const writeField = (node: AnyNode, field: LayoutOverrideField, value: unknown) => {
	if (value === undefined) return;
	switch (field) {
		case 'x':
			node.x = value;
			break;
		case 'y':
			node.y = value;
			break;
		case 'scaleX':
			if (node.scale) node.scale.x = value;
			break;
		case 'scaleY':
			if (node.scale) node.scale.y = value;
			break;
		case 'width':
			if (node.skeleton) writeSpineDisplaySize(node, 'x', value);
			else node.width = value;
			break;
		case 'height':
			if (node.skeleton) writeSpineDisplaySize(node, 'y', value);
			else node.height = value;
			break;
		case 'anchorX':
			if (node.anchor) node.anchor.x = value;
			break;
		case 'anchorY':
			if (node.anchor) node.anchor.y = value;
			break;
		case 'visible':
			node.visible = value;
			break;
		case 'zIndex': {
			node.zIndex = Number(value) || 0;
			if (node.parent) {
				node.parent.sortableChildren = true;
				node.parent.sortDirty = true;
				node.parent.sortChildren?.();
			}
			break;
		}
		case 'fontSize':
			if (node.style) node.style.fontSize = value;
			break;
		case 'align':
			if (node.style) node.style.align = value;
			break;
	}
};

// width/height on containers is computed from bounds (expensive + dynamic), so
// authored values for these are only captured when actually needed.
const LAZY_FIELDS: LayoutOverrideField[] = ['width', 'height', 'fontSize', 'align'];

export function getAuthoredValues(node: AnyNode): Partial<Record<LayoutOverrideField, unknown>> {
	return node.__sleAuthored ?? {};
}

/** The game-authored texture retained underneath a Sprite asset override. */
export function getAuthoredTexture(node: AnyNode): unknown | null {
	return node?.__sleHasAuthoredTexture ? node.__sleAuthoredTexture : null;
}

/**
 * Refresh only the authored display dimensions after a Sprite's texture changes.
 * Its live scale may currently be override-owned, so derive the new baseline
 * from local texture bounds and the already-captured authored scale.
 */
export function refreshAuthoredDisplaySize(node: AnyNode) {
	const authored: Partial<Record<LayoutOverrideField, unknown>> | undefined = node?.__sleAuthored;
	if (!authored || !node?.texture) return;
	try {
		const bounds = node.getLocalBounds?.();
		if (!validRect(bounds)) return;
		const authoredScaleX = Number(authored.scaleX);
		const authoredScaleY = Number(authored.scaleY);
		authored.width = bounds.width * (Number.isFinite(authoredScaleX) ? Math.abs(authoredScaleX) : 1);
		authored.height = bounds.height * (Number.isFinite(authoredScaleY) ? Math.abs(authoredScaleY) : 1);
	} catch {
		// Keep the previous baseline until the texture exposes valid local bounds.
	}
}

/**
 * Refresh the texture baseline after the owning component (or a spawned element
 * definition) assigns its real texture. Asset overrides are always layered on
 * top of this value and never destroy it.
 */
export function refreshAuthoredTexture(node: AnyNode) {
	if (!node || !('texture' in node)) return;
	node.__sleAuthoredTexture = node.texture;
	node.__sleHasAuthoredTexture = true;
	refreshAuthoredDisplaySize(node);
}

// ---------------------------------------------------------------------------
// Responsive layout
// ---------------------------------------------------------------------------

export type ResponsiveRect = { x: number; y: number; width: number; height: number };

const isContainerLike = (node: AnyNode) =>
	!node.texture && !isTextLike(node) && !node.context && !node.skeleton;

type VisualMetrics = {
	width: number;
	height: number;
	origin: { x: number; y: number };
};

/**
 * Visual AABB size in the node's parent coordinate space, plus the position of
 * node.x/y inside it. A scale override lets a pin use the size that will be
 * applied later in the same responsive solve instead of the previous frame's
 * size. This generalises Sprite anchor math to pivoted, rotated and mirrored
 * Text, Spine, Graphics and Container objects.
 */
const visualMetrics = (node: AnyNode, scaleOverride?: { x: number; y: number }): VisualMetrics => {
	try {
		node?.updateLocalTransform?.();
		const bounds = getLayoutLocalBounds(node);
		const matrix = node.getLocalTransform?.() ?? node.localTransform;
		if (validRect(bounds) && matrix) {
			let { a, b, c, d, tx, ty } = matrix;
			if (scaleOverride) {
				const currentX = node.scale?.x ?? 1;
				const currentY = node.scale?.y ?? 1;
				if (Math.abs(currentX) > 1e-9 && Math.abs(currentY) > 1e-9) {
					const ratioX = scaleOverride.x / currentX;
					const ratioY = scaleOverride.y / currentY;
					a *= ratioX;
					b *= ratioX;
					c *= ratioY;
					d *= ratioY;
					const pivotX = node.pivot?.x ?? 0;
					const pivotY = node.pivot?.y ?? 0;
					const originX = node.x ?? matrix.tx;
					const originY = node.y ?? matrix.ty;
					tx = originX - pivotX * a - pivotY * c;
					ty = originY - pivotX * b - pivotY * d;
				}
			}
			const point = (x: number, y: number) => ({
				x: a * x + c * y + tx,
				y: b * x + d * y + ty,
			});
			const points = [
				point(bounds.x, bounds.y),
				point(bounds.x + bounds.width, bounds.y),
				point(bounds.x + bounds.width, bounds.y + bounds.height),
				point(bounds.x, bounds.y + bounds.height),
			];
			const left = Math.min(...points.map((entry) => entry.x));
			const right = Math.max(...points.map((entry) => entry.x));
			const top = Math.min(...points.map((entry) => entry.y));
			const bottom = Math.max(...points.map((entry) => entry.y));
			return {
				width: Math.max(0, right - left),
				height: Math.max(0, bottom - top),
				origin: {
					x: right > left ? ((node.x ?? matrix.tx) - left) / (right - left) : (node.anchor?.x ?? 0),
					y: bottom > top ? ((node.y ?? matrix.ty) - top) / (bottom - top) : (node.anchor?.y ?? 0),
				},
			};
		}
	} catch {
		// use Sprite/Text-style anchor fallback below
	}
	const fixedSpineSize = node.skeleton ? getLayoutDisplaySize(node) : null;
	const currentScaleX = Math.abs(node.scale?.x ?? 1);
	const currentScaleY = Math.abs(node.scale?.y ?? 1);
	const targetScaleX = Math.abs(scaleOverride?.x ?? node.scale?.x ?? 1);
	const targetScaleY = Math.abs(scaleOverride?.y ?? node.scale?.y ?? 1);
	const width = (node.skeleton ? (fixedSpineSize?.width ?? 0) : Math.abs(node.width ?? 0)) *
		(currentScaleX > 1e-9 ? targetScaleX / currentScaleX : 1);
	const height = (node.skeleton ? (fixedSpineSize?.height ?? 0) : Math.abs(node.height ?? 0)) *
		(currentScaleY > 1e-9 ? targetScaleY / currentScaleY : 1);
	const anchorX = node.anchor?.x ?? 0;
	const anchorY = node.anchor?.y ?? 0;
	return {
		width,
		height,
		origin: {
			x: (scaleOverride?.x ?? node.scale?.x ?? 1) < 0 ? 1 - anchorX : anchorX,
			y: (scaleOverride?.y ?? node.scale?.y ?? 1) < 0 ? 1 - anchorY : anchorY,
		},
	};
};

const visualOriginRatio = (node: AnyNode, scaleOverride?: { x: number; y: number }) =>
	visualMetrics(node, scaleOverride).origin;

/** Parent-local offset from the transformed local (0,0) frame to node.x/y. */
const localFrameOriginOffset = (node: AnyNode) => {
	try {
		const matrix = node.getLocalTransform?.() ?? node.localTransform;
		if (matrix) return { x: (node.x ?? matrix.tx) - matrix.tx, y: (node.y ?? matrix.ty) - matrix.ty };
	} catch {
		// zero-offset container fallback below
	}
	return { x: 0, y: 0 };
};

/** Natural (unscaled) display size of a node in its parent's units. */
const naturalSize = (node: AnyNode) => {
	if (node?.skeleton) {
		const bounds = getLayoutLocalBounds(node);
		if (bounds) return { w: bounds.width, h: bounds.height };
		return { w: 0, h: 0 };
	}
	const sx = Math.abs(node.scale?.x || 1);
	const sy = Math.abs(node.scale?.y || 1);
	return { w: Math.abs(node.width || 0) / sx, h: Math.abs(node.height || 0) / sy };
};

/**
 * Parent-local node-origin coordinate for an anchored responsive axis before
 * its saved offset is added. Start/centre/end always align the node's visible
 * AABB, independent of its Pixi anchor/pivot, mirror sign or responsive scale.
 */
export function getResponsiveAxisBase(
	node: AnyNode,
	cfg: ResponsiveConfig,
	ref: ResponsiveRect,
	axis: 'x' | 'y',
	anchor: number,
) {
	const refStart = axis === 'x' ? ref.x : ref.y;
	const refSize = axis === 'x' ? ref.width : ref.height;
	if (cfg.aspect && !isContainerLike(node) && !isTextLike(node)) {
		const natural = naturalSize(node);
		if (natural.w > 0 && natural.h > 0) {
			const scale = cfg.aspect === 'cover'
				? Math.max(ref.width / natural.w, ref.height / natural.h)
				: Math.min(ref.width / natural.w, ref.height / natural.h);
			const displaySize = (axis === 'x' ? natural.w : natural.h) * scale;
			const aspectScale = {
				x: scale * (cfg.aspectSign?.x ?? (Math.sign(node.scale?.x ?? 1) || 1)),
				y: scale * (cfg.aspectSign?.y ?? (Math.sign(node.scale?.y ?? 1) || 1)),
			};
			const origin = visualOriginRatio(node, aspectScale)[axis];
			return refStart + anchor * (refSize - displaySize) + origin * displaySize;
		}
	}
	if (cfg.positionMode === 'origin' && isContainerLike(node)) {
		return refStart + anchor * refSize;
	}
	const metrics = visualMetrics(node, getResponsiveScaleOverride(node, cfg));
	const displaySize = axis === 'x' ? metrics.width : metrics.height;
	const origin = metrics.origin[axis];
	if (displaySize > 0 && Number.isFinite(displaySize) && Number.isFinite(origin)) {
		return refStart + anchor * (refSize - displaySize) + origin * displaySize;
	}
	return refStart + anchor * refSize;
}

/**
 * Accumulated world scale of a node's ancestors, from their *local* scales.
 * (Deliberately not read from `worldTransform`, which only updates on render and
 * would lag a frame behind a resize.)
 */
export function getParentWorldScale(node: AnyNode): { x: number; y: number } {
	let sx = 1;
	let sy = 1;
	let parent = node?.parent;
	let guard = 0;
	while (parent && guard++ < 64) {
		sx *= Math.abs(parent.scale?.x ?? 1);
		sy *= Math.abs(parent.scale?.y ?? 1);
		parent = parent.parent;
	}
	return { x: sx || 1, y: sy || 1 };
}

/** The scale factor a mode multiplies `scaleBase` by (1 when not applicable). */
export function getScaleFactor(cfg: ResponsiveConfig): number {
	if (cfg.scaleMode === 'game') {
		const gameScale = getGameScale();
		return gameScale ?? 1;
	}
	return 1; // 'fixed'
}

/**
 * Local scale that responsive sizing will apply later in this solve. Position
 * pins need this up front so a growing top/right-pinned asset cannot overflow.
 */
function getResponsiveScaleOverride(
	node: AnyNode,
	cfg: ResponsiveConfig,
): { x: number; y: number } | undefined {
	if (
		!cfg.scaleMode ||
		cfg.scaleMode === 'parent' ||
		cfg.aspect ||
		cfg.stretchX ||
		cfg.stretchY ||
		!cfg.scaleBase
	) return undefined;
	const factor = getScaleFactor(cfg);
	const parentScale = getParentWorldScale(node);
	return {
		x: (factor * cfg.scaleBase.x) / (parentScale.x || 1),
		y: (factor * cfg.scaleBase.y) / (parentScale.y || 1),
	};
}

export const responsiveEnabled = (
	cfg?: ResponsiveConfig | false,
): cfg is ResponsiveConfig =>
	!!cfg &&
	(!!cfg.x || !!cfg.y || !!cfg.stretchX || !!cfg.stretchY || !!cfg.aspect ||
		cfg.logicalW != null || cfg.logicalH != null ||
		(!!cfg.scaleMode && cfg.scaleMode !== 'parent'));

export function getResponsiveConfig(id: string): ResponsiveConfig | false | undefined {
	return getMergedOverride(id).responsive;
}

const validRect = (rect?: Partial<ResponsiveRect> | null): rect is ResponsiveRect =>
	!!rect &&
	[rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
	(rect.width ?? 0) > 0 &&
	(rect.height ?? 0) > 0;

/**
 * Spine's Pixi bounds are dynamic by default: every query measures the current
 * animation frame. Layout must instead use one stable local rectangle so pins,
 * fit/cover, selection and resize geometry cannot move while an animation plays.
 *
 * Prefer the setup-pose AABB calculated by the installed Spine integration.
 * This is important because the runtime's parser scale and Y-down coordinate
 * conversion are not reliably represented by SkeletonData's raw metadata.
 * If no fixed provider can produce a rectangle, layout geometry stays unavailable
 * instead of sampling an arbitrary animation frame. Only the untransformed local
 * rectangle is cached; later position, pivot, rotation and scale edits still take
 * effect normally.
 */
type FixedSpineBoundsCacheEntry = {
	skeletonData: unknown;
	boundsProvider: unknown;
	bounds: ResponsiveRect | null;
};

let fixedSpineLocalBounds = new WeakMap<object, FixedSpineBoundsCacheEntry>();
let resolveSpineLayoutBounds: ((node: AnyNode) => ResponsiveRect | null) | null = null;

/** Install the Spine-runtime-specific setup-pose bounds calculation. */
export function registerSpineLayoutBoundsResolver(
	resolver: ((node: AnyNode) => ResponsiveRect | null) | null,
) {
	resolveSpineLayoutBounds = resolver;
	// A late bridge/runtime registration must retry nodes inspected before the
	// Spine integration module finished loading.
	fixedSpineLocalBounds = new WeakMap<object, FixedSpineBoundsCacheEntry>();
}

export function getLayoutLocalBounds(node: AnyNode): ResponsiveRect | null {
	if (!node) return null;
	if (node.skeleton) {
		const skeletonData = node.skeleton?.data ?? null;
		const boundsProvider = node.boundsProvider ?? null;
		const cached = fixedSpineLocalBounds.get(node);
		if (cached && cached.skeletonData === skeletonData && cached.boundsProvider === boundsProvider) {
			return cached.bounds;
		}

		let candidate: Partial<ResponsiveRect> | null = null;
		// Respect a game-supplied fixed provider first. An invalid or throwing
		// provider must not prevent the setup-pose provider from being tried.
		try {
			candidate = boundsProvider?.calculateBounds?.(node) ?? null;
		} catch {
			candidate = null;
		}
		if (!validRect(candidate)) {
			try {
				candidate = resolveSpineLayoutBounds?.(node) ?? null;
			} catch {
				candidate = null;
			}
		}

		const fixed = validRect(candidate)
			? { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height }
			: null;
		// Cache null too: a missing/empty setup pose should not rebuild a temporary
		// skeleton every layout tick. Replacing the provider or SkeletonData object
		// invalidates this entry and performs one fresh fixed-bounds calculation.
		fixedSpineLocalBounds.set(node, { skeletonData, boundsProvider, bounds: fixed });
		return fixed;
	}

	try {
		const bounds = node.getLocalBounds?.();
		const rect = bounds?.rectangle ?? bounds;
		return validRect(rect) ? rect : null;
	} catch {
		return null;
	}
}

/** Stable displayed size in the node's parent-local units. */
export function getLayoutDisplaySize(node: AnyNode): { width: number; height: number } | null {
	const bounds = getLayoutLocalBounds(node);
	if (!bounds) return null;
	const scaleX = Number(node.scale?.x ?? 1);
	const scaleY = Number(node.scale?.y ?? 1);
	if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
	return {
		width: bounds.width * Math.abs(scaleX),
		height: bounds.height * Math.abs(scaleY),
	};
}

/**
 * Pixi's Spine width/height setters also query the current pose. Reproduce their
 * scale-based sizing against the fixed layout AABB while retaining mirror signs.
 */
const writeSpineDisplaySize = (
	node: AnyNode,
	axis: 'x' | 'y',
	value: unknown,
): boolean => {
	if (!node?.skeleton || !node.scale) return false;
	const bounds = getLayoutLocalBounds(node);
	const natural = axis === 'x' ? bounds?.width : bounds?.height;
	const requested = Number(value);
	if (!natural || !Number.isFinite(requested)) return false;
	const current = Number(node.scale[axis] ?? 1);
	const sign = Math.sign(current) || 1;
	node.scale[axis] = sign * Math.abs(requested) / natural;
	return true;
};

/** A one-time fallback for legacy parent rules that predate persisted frames. */
const capturedParentRects = new WeakMap<object, ResponsiveRect>();

/** Minimal affine shape used to compose fresh Pixi local transforms. */
type MatrixLike = { a: number; b: number; c: number; d: number; tx: number; ty: number };

const validMatrix = (matrix: AnyNode): matrix is MatrixLike =>
	!!matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty].every(Number.isFinite);

const multiplyMatrices = (parent: MatrixLike, local: MatrixLike): MatrixLike => ({
	a: parent.a * local.a + parent.c * local.b,
	b: parent.b * local.a + parent.d * local.b,
	c: parent.a * local.c + parent.c * local.d,
	d: parent.b * local.c + parent.d * local.d,
	tx: parent.a * local.tx + parent.c * local.ty + parent.tx,
	ty: parent.b * local.tx + parent.d * local.ty + parent.ty,
});

const currentLocalTransform = (node: AnyNode): MatrixLike | null => {
	try {
		// Pixi v8 keeps localTransform cached; update only this node without
		// recursively touching the scene from a prop-sync effect.
		node?.updateLocalTransform?.();
		const matrix = node?.getLocalTransform?.() ?? node?.localTransform;
		if (validMatrix(matrix)) {
			return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, tx: matrix.tx, ty: matrix.ty };
		}
	} catch {
		// Fall back to the last rendered world transform below.
	}
	return null;
};

/**
 * Compose the current local transforms instead of reading Pixi's last rendered
 * worldTransform. Stake's Svelte layout updates local MainContainer props before
 * Pixi's next render; composing them here keeps position and size on one resize
 * generation without forcing Pixi's recursive transform updater from an effect.
 */
export const globalTransformOf = (node: AnyNode): AnyNode => {
	if (!node) return null;
	const chain: AnyNode[] = [];
	let current = node;
	let guard = 0;
	while (current && guard++ < 64) {
		chain.push(current);
		current = current.parent;
	}
	let world: MatrixLike = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
	for (let i = chain.length - 1; i >= 0; i--) {
		const local = currentLocalTransform(chain[i]);
		if (!local) return node.worldTransform ?? null;
		world = multiplyMatrices(world, local);
	}
	return world;
};

const parentTransform = (parent: AnyNode) => globalTransformOf(parent);

/** Convert a global/canvas rectangle into the coordinate space where node.x/y live. */
const globalRectToParent = (node: AnyNode, rect: ResponsiveRect): ResponsiveRect => {
	const wt = parentTransform(node?.parent);
	if (!wt) return { ...rect };
	const det = wt.a * wt.d - wt.b * wt.c;
	if (!det) return { ...rect };
	const inv = (gx: number, gy: number) => {
		const dx = gx - wt.tx;
		const dy = gy - wt.ty;
		return {
			x: (wt.d * dx - wt.c * dy) / det,
			y: (wt.a * dy - wt.b * dx) / det,
		};
	};
	const points = [
		inv(rect.x, rect.y),
		inv(rect.x + rect.width, rect.y),
		inv(rect.x + rect.width, rect.y + rect.height),
		inv(rect.x, rect.y + rect.height),
	];
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const viewportRect = (node: AnyNode): ResponsiveRect =>
	globalRectToParent(node, {
		x: 0,
		y: 0,
		width: typeof window !== 'undefined' ? window.innerWidth : 1280,
		height: typeof window !== 'undefined' ? window.innerHeight : 720,
	});

const gameRect = (node: AnyNode): ResponsiveRect | null => {
	const layout = getGameLayout();
	if (!layout) return null;
	const anchor = typeof layout.anchor === 'number'
		? { x: layout.anchor, y: layout.anchor }
		: { x: layout.anchor?.x ?? 0.5, y: layout.anchor?.y ?? 0.5 };
	const width = layout.width * layout.scale;
	const height = layout.height * layout.scale;
	return globalRectToParent(node, {
		x: layout.x - anchor.x * width,
		y: layout.y - anchor.y * height,
		width,
		height,
	});
};

/**
 * Capture an ordinary parent's stable local frame once. Explicit hit areas and
 * MainContainer's centered pivot are preferred over content-derived bounds.
 */
export function captureParentRect(node: AnyNode): ResponsiveRect {
	const parent = node?.parent;
	if (!parent || !parent.parent) return viewportRect(node);
	if (validRect(parent.__sleRefRect)) return { ...parent.__sleRefRect };
	const hitArea = parent.hitArea;
	if (validRect(hitArea)) return { x: hitArea.x, y: hitArea.y, width: hitArea.width, height: hitArea.height };
	const pivotX = Number(parent.pivot?.x ?? 0);
	const pivotY = Number(parent.pivot?.y ?? 0);
	if (pivotX > 0 && pivotY > 0) {
		// Stake MainContainer pivots a 0..width / 0..height virtual frame at 0.5.
		return { x: 0, y: 0, width: pivotX * 2, height: pivotY * 2 };
	}
	try {
		const bounds = getLayoutLocalBounds(parent);
		if (validRect(bounds)) {
			return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
		}
	} catch {
		// fall through to the viewport
	}
	return viewportRect(node);
}

/**
 * Reference rectangle expressed in the node's parent coordinate space.
 * Parent frames are live only when the parent explicitly publishes a logical
 * frame; ordinary Pixi content bounds are captured once to avoid feedback.
 */
export function getReferenceRect(
	node: AnyNode,
	config?: ResponsiveConfig | false | 'viewport' | 'game' | 'parent',
): ResponsiveRect {
	const cfg: ResponsiveConfig = typeof config === 'string' ? { ref: config } : (config || {});
	if (cfg.ref === 'game') return gameRect(node) ?? viewportRect(node);
	if (cfg.ref === 'parent') {
		const parent = node?.parent;
		if (validRect(parent?.__sleRefRect)) return { ...parent.__sleRefRect };
		if (validRect(cfg.parentRect)) return { ...cfg.parentRect };
		const cached = capturedParentRects.get(node);
		if (cached) return { ...cached };
		const captured = captureParentRect(node);
		capturedParentRects.set(node, captured);
		return { ...captured };
	}
	return viewportRect(node);
}

/**
 * Convert an offset/margin between persisted responsive units and the node's
 * parent-local units. Game values are stored in Stake design units (the same
 * coordinates used inside MainContainer), viewport values in screen pixels,
 * and parent values in the parent's published local frame.
 */
export function getResponsiveUnitScale(
	node: AnyNode,
	cfg: ResponsiveConfig,
	ref: ResponsiveRect,
	axis: 'x' | 'y',
): number {
	if (cfg.ref === 'parent') return 1;
	const layout = cfg.ref === 'game' ? getGameLayout() : null;
	const logicalSize = cfg.ref === 'game'
		? axis === 'x' ? layout?.width : layout?.height
		: typeof window !== 'undefined'
			? axis === 'x' ? window.innerWidth : window.innerHeight
			: undefined;
	if (!logicalSize) return 1;
	const localSize = axis === 'x' ? ref.width : ref.height;
	const scale = localSize / logicalSize;
	return Number.isFinite(scale) && Math.abs(scale) > 1e-9 ? Math.abs(scale) : 1;
}

export const responsiveLengthToLocal = (
	node: AnyNode,
	cfg: ResponsiveConfig,
	ref: ResponsiveRect,
	axis: 'x' | 'y',
	value: number,
) => value * getResponsiveUnitScale(node, cfg, ref, axis);

export const localLengthToResponsive = (
	node: AnyNode,
	cfg: ResponsiveConfig,
	ref: ResponsiveRect,
	axis: 'x' | 'y',
	value: number,
) => value / getResponsiveUnitScale(node, cfg, ref, axis);

/**
 * Compute responsive geometry for a node into a partial field map (x/y/width/
 * height/scaleX/scaleY). Also stamps `__sleRefRect` on responsive containers so
 * their children can use them as a `parent` reference.
 */
export function computeResponsive(
	node: AnyNode,
	cfg: ResponsiveConfig,
): { out: Partial<Record<LayoutOverrideField, number>>; ref: ResponsiveRect } {
	const ref = getReferenceRect(node, cfg);
	const out: Partial<Record<LayoutOverrideField, number>> = {};
	const containerLike = isContainerLike(node);
	const textLike = isTextLike(node);
	const stretchOrigin = !containerLike && (cfg.stretchX || cfg.stretchY)
		? visualOriginRatio(node)
		: { x: 0, y: 0 };
	const frameOrigin = containerLike && (cfg.stretchX || cfg.stretchY)
		? localFrameOriginOffset(node)
		: { x: 0, y: 0 };

	// Uniform-scale aspect fit/cover (sprites, spine, graphics with a natural size).
	if (cfg.aspect && !containerLike && !textLike) {
		const nat = naturalSize(node);
		if (nat.w > 0 && nat.h > 0) {
			const sx = ref.width / nat.w;
			const sy = ref.height / nat.h;
			const s = cfg.aspect === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
			out.scaleX = s * (cfg.aspectSign?.x ?? (Math.sign(node.scale?.x ?? 1) || 1));
			out.scaleY = s * (cfg.aspectSign?.y ?? (Math.sign(node.scale?.y ?? 1) || 1));
			const aspectOrigin = visualOriginRatio(node, { x: out.scaleX, y: out.scaleY });
			const displayW = nat.w * s;
			const displayH = nat.h * s;
			if (cfg.x) {
				const align = cfg.x.anchor ?? 0.5;
				out.x = ref.x + align * (ref.width - displayW) + aspectOrigin.x * displayW +
					responsiveLengthToLocal(node, cfg, ref, 'x', cfg.x.offset ?? 0);
			}
			if (cfg.y) {
				const align = cfg.y.anchor ?? 0.5;
				out.y = ref.y + align * (ref.height - displayH) + aspectOrigin.y * displayH +
					responsiveLengthToLocal(node, cfg, ref, 'y', cfg.y.offset ?? 0);
			}
		}
		return { out, ref };
	}

	let logicalW: number | undefined;
	let logicalH: number | undefined;

	// X axis
	if (cfg.stretchX) {
		const m0 = responsiveLengthToLocal(node, cfg, ref, 'x', cfg.stretchX.m0 ?? 0);
		const m1 = responsiveLengthToLocal(node, cfg, ref, 'x', cfg.stretchX.m1 ?? 0);
		const dispW = Math.max(1, ref.width - m0 - m1);
		if (containerLike) {
			out.x = ref.x + m0 + frameOrigin.x;
			logicalW = dispW;
		} else {
			out.width = dispW;
			out.x = ref.x + m0 + stretchOrigin.x * dispW;
		}
	} else if (cfg.x) {
		out.x = getResponsiveAxisBase(node, cfg, ref, 'x', cfg.x.anchor ?? 0) +
			responsiveLengthToLocal(node, cfg, ref, 'x', cfg.x.offset ?? 0);
	}

	// Y axis
	if (cfg.stretchY) {
		const m0 = responsiveLengthToLocal(node, cfg, ref, 'y', cfg.stretchY.m0 ?? 0);
		const m1 = responsiveLengthToLocal(node, cfg, ref, 'y', cfg.stretchY.m1 ?? 0);
		const dispH = Math.max(1, ref.height - m0 - m1);
		if (containerLike) {
			out.y = ref.y + m0 + frameOrigin.y;
			logicalH = dispH;
		} else {
			out.height = dispH;
			out.y = ref.y + m0 + stretchOrigin.y * dispH;
		}
	} else if (cfg.y) {
		out.y = getResponsiveAxisBase(node, cfg, ref, 'y', cfg.y.anchor ?? 0) +
			responsiveLengthToLocal(node, cfg, ref, 'y', cfg.y.offset ?? 0);
	}

	// Responsive sizing: derive a local scale from a target *world* scale, so an
	// element inside an already-scaling parent is not scaled twice. Skipped when
	// `aspect` or a text/stretch fit already determined the scale.
	if (
		cfg.scaleMode &&
		cfg.scaleMode !== 'parent' &&
		!cfg.aspect &&
		!cfg.stretchX &&
		!cfg.stretchY &&
		out.scaleX === undefined &&
		out.scaleY === undefined &&
		cfg.scaleBase
	) {
		const responsiveScale = getResponsiveScaleOverride(node, cfg);
		if (responsiveScale) {
			out.scaleX = responsiveScale.x;
			out.scaleY = responsiveScale.y;
		}
	}

	// Container logical rect (from stretch, or an explicit fixed logical size).
	// Expressed in the container's own local units, so a scaled container still
	// hands its children a rect that maps 1:1 to their coordinate space.
	if (containerLike) {
		const lw = logicalW ?? cfg.logicalW;
		const lh = logicalH ?? cfg.logicalH;
		if (lw != null || lh != null) {
			const ownScaleX = (out.scaleX ?? node.scale?.x ?? 1) || 1;
			const ownScaleY = (out.scaleY ?? node.scale?.y ?? 1) || 1;
			let localBounds: ResponsiveRect | undefined;
			try {
				const bounds = node.getLocalBounds?.();
				if (validRect(bounds)) localBounds = bounds;
			} catch {
				// a frame can still be published when both dimensions are explicit
			}
			const width = lw != null ? lw / Math.abs(ownScaleX) : localBounds?.width;
			const height = lh != null ? lh / Math.abs(ownScaleY) : localBounds?.height;
			if ((width ?? 0) > 0 && (height ?? 0) > 0) {
				node.__sleRefRect = { x: 0, y: 0, width, height };
			} else {
				node.__sleRefRect = undefined;
			}
		} else {
			node.__sleRefRect = undefined;
		}
	}

	return { out, ref };
}

/**
 * Apply the merged override for `node`. Runs inside the component's prop-sync
 * $effect: reading `runtime.version` + the layout type getter makes every element
 * react to override edits and viewport/profile changes.
 */
export function applyLayoutOverrides(node: AnyNode, propKeys?: string[]) {
	runtime.version; // reactive dependency: re-run all prop syncs when overrides change
	if (!node || node.destroyed) return;

	const id = ensureLayoutId(node);
	// These anonymous structural wrappers can reuse their id for another object
	// after a mode/screen remount. Never apply saved data to them in standalone or
	// editor runs; their named descendants remain independent and editable.
	if (isTemporaryLayoutContainerNode(node)) {
		const authored: Partial<Record<LayoutOverrideField, unknown>> | undefined = node.__sleAuthored;
		const applied: Set<LayoutOverrideField> | undefined = node.__sleApplied;
		// pixi-svelte has already assigned this render's authored props. Refresh any
		// editor-owned baselines before releasing them, otherwise becoming anonymous
		// in the same render as an authored prop update would restore an older value.
		if (authored && propKeys) {
			for (const field of FIELD_ORDER) {
				const directProp = propKeys.includes(FIELD_PROP_SOURCE[field]);
				const coupledDimension = !isContainerLike(node) && (
					((field === 'width' || field === 'height') && propKeys.includes('scale')) ||
					(field === 'scaleX' && propKeys.includes('width')) ||
					(field === 'scaleY' && propKeys.includes('height'))
				);
				if ((directProp || coupledDimension) && applied?.has(field)) {
					const value = readAuthoredField(node, field, authored);
					if (value === undefined) delete authored[field];
					else authored[field] = value;
				}
			}
		}
		if (authored && applied) {
			for (const field of FIELD_ORDER) {
				if (applied.has(field)) writeField(node, field, authored[field]);
			}
			applied.clear();
		}
		if (node.__sleAssetOverrideKey && node.__sleHasAuthoredTexture) {
			node.texture = node.__sleAuthoredTexture;
			refreshAuthoredDisplaySize(node);
		}
		node.__sleAssetOverrideKey = undefined;
		node.__sleMissingAssetKey = undefined;
		node.__sleRefRect = undefined;
		node.__sleNeedsPostMountLayoutRefresh = undefined;
		return;
	}

	let authored: Partial<Record<LayoutOverrideField, unknown>> = node.__sleAuthored;
	if (!authored) {
		authored = node.__sleAuthored = {};
		for (const field of FIELD_ORDER) {
			// Display-object dimensions are cheap and coupled to scale in Pixi. Capture
			// them before any override scale is staged; only child-derived Container
			// width/height need to remain lazy.
			const eagerDisplayDimension =
				!isContainerLike(node) && (field === 'width' || field === 'height');
			if (!LAZY_FIELDS.includes(field) || eagerDisplayDimension) {
				const value = readAuthoredField(node, field, authored);
				if (value !== undefined) authored[field] = value;
			}
		}
	} else if (propKeys) {
		// Props were just re-assigned; refresh the authored snapshot for the fields
		// those props control so resets restore the live authored value.
		for (const field of FIELD_ORDER) {
			const directProp = propKeys.includes(FIELD_PROP_SOURCE[field]);
			const coupledDimension = !isContainerLike(node) && (
				((field === 'width' || field === 'height') && propKeys.includes('scale')) ||
				(field === 'scaleX' && propKeys.includes('width')) ||
				(field === 'scaleY' && propKeys.includes('height'))
			);
			if (directProp || coupledDimension) {
				const value = readAuthoredField(node, field, authored);
				if (value === undefined) delete authored[field];
				else authored[field] = value;
			}
		}
	}

	const textureNode = !!node.anchor && 'texture' in node;
	// pixi-svelte has just assigned the component's real texture when `texture`
	// appears in propKeys. Keep that authored value underneath any saved asset
	// override so a reset/profile switch is always lossless.
	const authoredTextureChanged =
		propKeys?.includes('texture') && node.texture !== node.__sleAuthoredTexture;
	if (textureNode && (!node.__sleHasAuthoredTexture || authoredTextureChanged)) {
		refreshAuthoredTexture(node);
	}

	const merged = getMergedOverride(id);
	const replacementAssetKey =
		textureNode && typeof merged.assetKey === 'string' && merged.assetKey
			? merged.assetKey
			: null;
	// `removed` is not a node property — it resolves into a forced-invisible state
	// (winning over any `visible` override). `removed: false` in a profile restores
	// the element there even when base removes it.
	if (merged.removed !== undefined) {
		if (merged.removed) merged.visible = false;
		delete merged.removed;
	}

	// Responsive layout has to see the effective *static* transform (especially
	// anchor/mirror/pivot) rather than whatever authored or previous responsive
	// values happened to be on the node when this prop effect started.
	const final: Record<string, unknown> = { ...merged };
	const responsiveConfig = responsiveEnabled(merged.responsive) ? merged.responsive : undefined;
	// pixi-svelte attaches authored nodes in onMount, after their initial prop
	// effect. Remember only responsive nodes that actually solved too early;
	// transient non-responsive mounts (notably spinning reel symbols) must not
	// invalidate the whole game layout.
	if (!node.parent) node.__sleNeedsPostMountLayoutRefresh = !!responsiveConfig;
	if (responsiveConfig) {
		// A single sizing owner is allowed. Width/height setters mutate Pixi scale,
		// so stale static dimensions must not run after scale/aspect owns the size.
		if (responsiveConfig.aspect || (
			responsiveConfig.scaleMode && responsiveConfig.scaleMode !== 'parent'
		)) {
			delete final.width;
			delete final.height;
			delete final.scaleX;
			delete final.scaleY;
		}
		if (responsiveConfig.stretchX) delete final.width;
		if (responsiveConfig.stretchY) delete final.height;
	} else if (node.__sleRefRect) {
		node.__sleRefRect = undefined;
	}
	delete final.responsive;
	delete final.assetKey;

	const applied: Set<LayoutOverrideField> =
		node.__sleApplied ?? (node.__sleApplied = new Set<LayoutOverrideField>());
	// A static lazy field must also be captured before another staged field (most
	// notably scale) can mutate its live value.
	for (const field of LAZY_FIELDS) {
		if (final[field] !== undefined && !(field in authored)) {
			const value = readAuthoredField(node, field, authored);
			if (value !== undefined) authored[field] = value;
		}
	}

	// Restore every previously owned field first, then stage the merged static
	// transform. computeResponsive can now safely inspect live anchor/scale/bounds.
	for (const field of FIELD_ORDER) {
		if (applied.has(field)) {
			writeField(node, field, authored[field]);
			applied.delete(field);
		}
	}

	// Restore the source texture before resolving the new profile's key. A missing
	// or not-yet-loaded key is deliberately non-destructive: the authored Sprite
	// remains visible and the reactive loaded-assets getter can retry later.
	if (textureNode) {
		if (node.__sleAssetOverrideKey && node.__sleHasAuthoredTexture) {
			node.texture = node.__sleAuthoredTexture;
			refreshAuthoredDisplaySize(node);
		}
		node.__sleAssetOverrideKey = undefined;
		node.__sleMissingAssetKey = undefined;
		if (replacementAssetKey) {
			let replacement: unknown | null = null;
			try {
				replacement = resolveLayoutTexture?.(replacementAssetKey) ?? null;
			} catch {
				// A transient game asset-loader failure must not blank an authored Sprite.
			}
			if (replacement) {
				node.texture = replacement;
				node.__sleAssetOverrideKey = replacementAssetKey;
				refreshAuthoredDisplaySize(node);
			} else {
				node.__sleMissingAssetKey = replacementAssetKey;
			}
		}
	}

	for (const field of FIELD_ORDER) {
		const value = final[field];
		if (value !== undefined) {
			if (!(field in authored)) {
				const authoredValue = readAuthoredField(node, field, authored);
				if (authoredValue !== undefined) authored[field] = authoredValue;
			}
			writeField(node, field, value);
			applied.add(field);
		}
	}

	let responsiveOut: Partial<Record<LayoutOverrideField, number>> = {};
	if (responsiveConfig) {
		runtime.viewport; // reactive dependency: recompute on viewport/parent resize
		responsiveOut = computeResponsive(node, responsiveConfig).out;
	}
	// The solver is the final sizing/position owner and therefore always applies
	// after the staged static transform.
	for (const field of FIELD_ORDER) {
		const value = responsiveOut[field];
		if (value !== undefined) {
			if (!(field in authored)) {
				const authoredValue = readAuthoredField(node, field, authored);
				if (authoredValue !== undefined) authored[field] = authoredValue;
			}
			writeField(node, field, value);
			applied.add(field);
		}
	}

	// Editor-only sample text preview (never persisted).
	if (isTextLike(node)) {
		const sample = sampleTexts.get(id);
		if (sample !== undefined) {
			if (node.__sleSampleWasSet === undefined) node.__sleSampleWasSet = node.text;
			node.text = sample;
		} else if (node.__sleSampleWasSet !== undefined) {
			if (!propKeys?.includes('text')) node.text = node.__sleSampleWasSet;
			node.__sleSampleWasSet = undefined;
		}
	}
}
