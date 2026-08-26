/**
 * Runtime for Layout-Editor-created elements ("spawned elements").
 *
 * The editor saves element definitions (sprite/Spine-from-asset or empty
 * container) into the project's layout override data. This module instantiates
 * them as plain Pixi objects at runtime — in the editor AND in normal game runs — and
 * registers them in the layout registry so every existing editor feature
 * (selection, drag, resize, profiles, save) works on them unchanged. Their
 * position/size/scale/visibility come entirely from the normal override system.
 *
 * The game project wires this once at startup:
 *
 *   wireSpawnedElements({
 *     getApp: () => stateApp.pixiApplication,
 *     getLoadedAssets: () => stateApp.loadedAssets,
 *   });
 *
 * Reconciliation is reactive: it re-runs when the override data changes, when
 * the Pixi app / assets become available (stateApp is runes state) and when the
 * element registry changes (so elements parented to game containers re-attach
 * when their parent's state mounts, and detach when it unmounts).
 */
import * as PIXI from 'pixi.js';
import * as SPINE_PIXI from '@esotericsoftware/spine-pixi-v8';

import {
	applyLayoutOverrides,
	ensureLayoutId,
	getLayoutOverridesData,
	getLayoutOverridesVersion,
	getRegisteredLayoutNodes,
	getViewportVersion,
	isTemporaryLayoutContainerNode,
	markSpawnedNode,
	onLayoutRegistryChange,
	refreshAuthoredTexture,
	registerLayoutAssetResolver,
	registerLayoutNode,
	registerSpineLayoutBoundsResolver,
	unregisterLayoutNode,
	type SpawnedElementDef,
} from './layoutOverrides.svelte';

type AnyNode = any;

// Spine-Pixi's default bounds measure the current animation frame. Calculate a
// setup-pose AABB from a separate skeleton instead, and let the shared layout
// runtime cache that local rectangle. The shared helper checks an explicit fixed
// provider supplied by the game before calling this setup-pose resolver.
registerSpineLayoutBoundsResolver((node: AnyNode) => {
	const SetupPoseBoundsProvider = (SPINE_PIXI as AnyNode).SetupPoseBoundsProvider;
	if (typeof SetupPoseBoundsProvider !== 'function') return null;
	return new SetupPoseBoundsProvider().calculateBounds(node);
});

/** Optional game behavior for a spawned sprite used as a control. */
export type SpawnedSpriteInteraction = {
	disabled?: boolean;
	hitPadding?:
		| number
		| { x?: number; y?: number; top?: number; right?: number; bottom?: number; left?: number };
	onpress: () => void;
};

type WireOptions = {
	getApp: () => PIXI.Application | undefined;
	getLoadedAssets: () => Record<string, unknown>;
	/** Optionally choose a spawned sprite's texture from reactive game state. */
	resolveSpriteAssetKey?: (def: SpawnedElementDef) => string | undefined;
	/** Optionally control whether a spawned element participates in rendering. */
	resolveRenderable?: (def: SpawnedElementDef) => boolean | undefined;
	/** Optionally turn a spawned sprite into a padded, directly clickable control. */
	resolveSpriteInteraction?: (def: SpawnedElementDef) => SpawnedSpriteInteraction | undefined;
};

let options: WireOptions | null = null;
const liveObjects = new Map<string, AnyNode>();
let reconciling = false;

/** Hover art is authored as a sibling sprite (for example btnMenuHover). */
const isHoverChild = (def: SpawnedElementDef) => def.kind === 'sprite' && /hover/i.test(def.id);

const setSiblingHoverVisible = (node: AnyNode, visible: boolean) => {
	for (const child of node.__sleHoverChildren ?? []) {
		if (child.destroyed) continue;
		const allowed = visible && child.__sleHoverSuppressed !== true;
		child.visible = allowed;
		child.renderable = allowed;
	}
};

/** Centre of a sprite's artwork in its parent's coordinate space. */
const spriteLocalCentre = (node: AnyNode) => {
	const width = node.texture?.orig?.width ?? node.texture?.width ?? 0;
	const height = node.texture?.orig?.height ?? node.texture?.height ?? 0;
	return {
		x: node.x + (0.5 - (node.anchor?.x ?? 0)) * width * (node.scale?.x ?? 1),
		y: node.y + (0.5 - (node.anchor?.y ?? 0)) * height * (node.scale?.y ?? 1),
	};
};

const alignHoverToOwner = (hover: AnyNode, owner: AnyNode | undefined) => {
	if (!owner || owner.destroyed || hover.destroyed) return;
	const centre = spriteLocalCentre(owner);
	const width = hover.texture?.orig?.width ?? hover.texture?.width ?? 0;
	const height = hover.texture?.orig?.height ?? hover.texture?.height ?? 0;
	hover.x = centre.x - (0.5 - (hover.anchor?.x ?? 0)) * width * (hover.scale?.x ?? 1);
	hover.y = centre.y - (0.5 - (hover.anchor?.y ?? 0)) * height * (hover.scale?.y ?? 1);
};

export function isSpawnedElementsWired() {
	return !!options;
}

/** Used by the editor bridge for the asset browser. */
export function getSpawnedRuntime() {
	return { wired: !!options, getLoadedAssets: options?.getLoadedAssets };
}

const resolveTexture = (assetKey?: string): PIXI.Texture | null => {
	if (!assetKey || !options) return null;
	const asset = options.getLoadedAssets()?.[assetKey] as AnyNode;
	if (
		asset instanceof PIXI.Texture ||
		(asset?.source && typeof asset.width === 'number' && typeof asset.height === 'number')
	) return asset as PIXI.Texture;
	return null;
};

const resolveSpineData = (assetKey?: string): SPINE_PIXI.SkeletonData | null => {
	if (!assetKey || !options) return null;
	const asset = options.getLoadedAssets()?.[assetKey] as AnyNode;
	return asset?.bones && asset?.slots ? (asset as SPINE_PIXI.SkeletonData) : null;
};

const destroyLiveObject = (id: string, node: AnyNode) => {
	liveObjects.delete(id);
	unregisterLayoutNode(node);
	if (!node.destroyed) node.destroy();
};

/**
 * Keep track 0 in sync without restarting it on every responsive reconciliation.
 * A non-looping animation therefore remains on its final frame after completion.
 */
const syncSpineAnimation = (node: AnyNode, def: SpawnedElementDef) => {
	const animationName = def.animationName || '';
	const loop = def.loop !== false;
	const signature = `${animationName}\u0000${loop}`;
	if (node.__sleAnimationSignature === signature) return;
	node.__sleAnimationSignature = signature;
	const current = node.state?.getCurrent?.(0);
	try {
		if (!animationName) {
			node.state?.clearTrack?.(0);
			node.skeleton?.setToSetupPose?.();
			node.update?.(0);
			return;
		}
		if (current?.animation?.name === animationName) {
			current.loop = loop;
			return;
		}
		node.state?.setAnimation?.(0, animationName, loop);
		node.update?.(0);
	} catch (error) {
		console.warn(
			`Layout Editor Spine "${def.id}" could not play animation "${animationName}".`,
			error,
		);
	}
};

const isAncestorOf = (maybeAncestor: AnyNode, node: AnyNode) => {
	let current = node;
	while (current) {
		if (current === maybeAncestor) return true;
		current = current.parent;
	}
	return false;
};

const syncSiblingHover = (node: AnyNode, def: SpawnedElementDef, defs: SpawnedElementDef[]) => {
	if (isHoverChild(def)) {
		node.__sleHoverOverlay = true;
		node.eventMode = 'none';
		node.visible = false;
		node.renderable = false;
		return;
	}
	const hoverChildren = defs
		.filter((candidate) => candidate.parentId === def.parentId && isHoverChild(candidate))
		.map((candidate) => liveObjects.get(candidate.id))
		.filter((child) => child && !child.destroyed);
	node.__sleHoverChildren = hoverChildren;
	setSiblingHoverVisible(node, !!node.__sleSiblingHovered);
	if (!hoverChildren.length || node.__sleSiblingHoverWired) return;
	node.__sleSiblingHoverWired = true;
	node.eventMode = 'static';
	node.on('pointerover', () => {
		node.__sleSiblingHovered = true;
		setSiblingHoverVisible(node, true);
	});
	node.on('pointerout', () => {
		node.__sleSiblingHovered = false;
		setSiblingHoverVisible(node, false);
	});
};

const resolveHitPadding = (padding: SpawnedSpriteInteraction['hitPadding']) => {
	const clamp = (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
	if (typeof padding === 'number') {
		const all = clamp(padding) ?? 0;
		return { top: all, right: all, bottom: all, left: all };
	}
	const pick = (...candidates: unknown[]) => {
		for (const candidate of candidates) {
			const value = clamp(candidate);
			if (value !== undefined) return value;
		}
		return 0;
	};
	return {
		top: pick(padding?.top, padding?.y),
		right: pick(padding?.right, padding?.x),
		bottom: pick(padding?.bottom, padding?.y),
		left: pick(padding?.left, padding?.x),
	};
};

/** Apply the latest game-supplied control behavior without duplicating listeners. */
const syncSpriteInteraction = (node: AnyNode, def: SpawnedElementDef) => {
	const interaction = options?.resolveSpriteInteraction?.(def);
	node.__sleSpriteInteraction = interaction;
	if (!interaction) return;

	const pad = resolveHitPadding(interaction.hitPadding);
	const width = node.texture?.orig?.width ?? node.texture?.width ?? 0;
	const height = node.texture?.orig?.height ?? node.texture?.height ?? 0;
	const anchorX = node.anchor?.x ?? 0;
	const anchorY = node.anchor?.y ?? 0;
	const hitArea = new PIXI.Rectangle(
		-width * anchorX - pad.left,
		-height * anchorY - pad.top,
		width + pad.left + pad.right,
		height + pad.top + pad.bottom,
	);
	const usable =
		hitArea.width > 0 &&
		hitArea.height > 0 &&
		[hitArea.x, hitArea.y, hitArea.width, hitArea.height].every(Number.isFinite);
	node.hitArea = usable ? hitArea : null;
	node.eventMode = 'static';
	node.cursor = interaction.disabled ? 'not-allowed' : 'pointer';

	if (node.__sleInteractionWired) return;
	node.__sleInteractionWired = true;
	const release = () => {
		node.__sleInteractionPressed = false;
		node.alpha = node.__sleInteractionBaseAlpha ?? node.alpha;
	};
	node.on('pointerdown', (event: AnyNode) => {
		event.stopPropagation?.();
		if (node.__sleSpriteInteraction?.disabled) return;
		node.__sleInteractionBaseAlpha = node.alpha;
		node.__sleInteractionPressed = true;
		node.alpha *= 0.82;
	});
	node.on('pointerup', (event: AnyNode) => {
		event.stopPropagation?.();
		if (!node.__sleInteractionPressed) return;
		const current = node.__sleSpriteInteraction as SpawnedSpriteInteraction | undefined;
		release();
		if (!current?.disabled) current?.onpress();
	});
	node.on('pointerupoutside', release);
	node.on('pointercancel', release);
};

const resolveParent = (parentId: string | null | undefined, stage: PIXI.Container): AnyNode => {
	if (!parentId || parentId === '__stage__') return stage;
	// Never bind a persisted child to a reused anonymous mount-order slot. Legacy
	// numbered bindings fall back to stage until the editor migrates them. A safe
	// named parent that is merely unmounted still returns null and detaches below.
	if (/^container#\d+$/.test(parentId)) return stage;
	const spawned = liveObjects.get(parentId);
	if (spawned && !spawned.destroyed) return spawned;
	const candidate =
		getRegisteredLayoutNodes().find((node: AnyNode) => ensureLayoutId(node) === parentId) ?? null;
	if (!candidate) return null;
	return isTemporaryLayoutContainerNode(candidate) ? stage : candidate;
};

const isNodeShown = (node: AnyNode) => {
	let current = node;
	while (current) {
		if (!current.visible || current.renderable === false || current.alpha === 0) return false;
		current = current.parent;
	}
	return true;
};

/** Track hover against rendered art rather than a padded control hit area. */
const updateSiblingHoverFromPointer = (event: PointerEvent) => {
	const app = options?.getApp();
	const canvas = app?.canvas;
	if (!canvas) return;
	const canvasRect = canvas.getBoundingClientRect();
	const screen = app.renderer?.screen;
	const x =
		(event.clientX - canvasRect.left) * ((screen?.width ?? canvasRect.width) / canvasRect.width);
	const y =
		(event.clientY - canvasRect.top) * ((screen?.height ?? canvasRect.height) / canvasRect.height);
	const insideCanvas =
		event.clientX >= canvasRect.left &&
		event.clientX <= canvasRect.right &&
		event.clientY >= canvasRect.top &&
		event.clientY <= canvasRect.bottom;
	for (const node of liveObjects.values()) {
		if (!node.__sleHoverChildren?.length) continue;
		let hovered = false;
		if (insideCanvas && isNodeShown(node)) {
			const rawBounds = node.getBounds?.();
			const bounds = rawBounds?.rectangle ?? rawBounds;
			hovered =
				!!bounds &&
				x >= bounds.x &&
				x <= bounds.x + bounds.width &&
				y >= bounds.y &&
				y <= bounds.y + bounds.height;
		}
		if (node.__sleSiblingHovered === hovered) continue;
		node.__sleSiblingHovered = hovered;
		setSiblingHoverVisible(node, hovered);
	}
};

function reconcile() {
	if (!options || reconciling) return;
	const app = options.getApp();
	if (!app?.stage) return;
	reconciling = true;
	try {
		const defs = getLayoutOverridesData().elements ?? [];
		const defIds = new Set(defs.map((def) => def.id));

		// drop deleted / stale objects
		for (const [id, node] of [...liveObjects]) {
			if (!defIds.has(id) || node.destroyed) {
				destroyLiveObject(id, node);
			}
		}

		// pass 1: ensure every def has a live object (parents may be other defs)
		for (const def of defs) {
			let node = liveObjects.get(def.id);
			const wrongKind = node && node.__sleSpawnKind !== def.kind;
			const changedSpineAsset =
				node && def.kind === 'spine' && node.__sleAssetKey !== def.assetKey;
			if (node && !node.destroyed && (wrongKind || changedSpineAsset)) {
				destroyLiveObject(def.id, node);
				node = undefined;
			}
			if (node && !node.destroyed) continue;
			if (def.kind === 'container') {
				node = new PIXI.Container();
			} else if (def.kind === 'spine') {
				const spineData = resolveSpineData(def.assetKey);
				// SkeletonData cannot use an EMPTY fallback. Wait for Stake's
				// reactive asset loader and reconcile when it becomes ready.
				if (!spineData) continue;
				node = new SPINE_PIXI.Spine(spineData);
			} else {
				node = new PIXI.Sprite(resolveTexture(def.assetKey) ?? PIXI.Texture.EMPTY);
			}
			node.label = def.id;
			node.__sleSpawnKind = def.kind;
			node.__sleAssetKey = def.assetKey;
			markSpawnedNode(node, def.id);
			liveObjects.set(def.id, node);
			registerLayoutNode(node);
		}

		// pass 2: texture / order / parenting / overrides.
		// Apply parents before children so a responsive parent's logical rect
		// (__sleRefRect) is fresh when a child reads it.
		const byId = new Map(defs.map((entry) => [entry.id, entry]));
		const depth = (def: SpawnedElementDef): number => {
			let d = 0;
			let pid = def.parentId;
			while (pid && byId.has(pid) && d < 50) {
				d += 1;
				pid = byId.get(pid)!.parentId;
			}
			return d;
		};
		const ordered = [...defs].sort((a, b) => depth(a) - depth(b));
		for (const def of ordered) {
			const node = liveObjects.get(def.id);
			if (!node || node.destroyed) continue;
			if (def.kind === 'sprite') {
				const assetKey = options.resolveSpriteAssetKey?.(def) ?? def.assetKey;
				const texture = resolveTexture(assetKey);
				if (texture && node.__sleBaseTexture !== texture) {
					node.__sleBaseTexture = texture;
					node.texture = texture;
					refreshAuthoredTexture(node);
				}
				syncSiblingHover(node, def, defs);
			} else if (def.kind === 'spine') {
				syncSpineAnimation(node, def);
			}
			node.zIndex = def.order ?? 0;
			const parent = resolveParent(def.parentId, app.stage as PIXI.Container);
			if (parent && !parent.destroyed && !isAncestorOf(node, parent)) {
				if (node.parent !== parent) {
					parent.addChild(node);
					parent.sortableChildren = true;
					parent.sortChildren();
				}
			} else if (node.parent) {
				// parent not currently mounted (e.g. state-specific container) — detach
				node.parent.removeChild(node);
			}
			applyLayoutOverrides(node);
			if (def.kind === 'sprite') syncSpriteInteraction(node, def);
			const renderable = options.resolveRenderable?.(def);
			if (renderable !== undefined) node.renderable = renderable;
			// Hover overlays are siblings and must remain hidden until their owner is
			// hovered. A game-supplied false renderable value is a hard veto.
			if (isHoverChild(def)) {
				const owner = defs.find(
					(candidate) =>
						candidate.parentId === def.parentId &&
						!isHoverChild(candidate) &&
						candidate.kind === 'sprite',
				);
				const ownerNode = owner && liveObjects.get(owner.id);
				alignHoverToOwner(node, ownerNode);
				node.__sleHoverSuppressed = renderable === false;
				const hovered = renderable !== false && !!ownerNode?.__sleSiblingHovered;
				node.visible = hovered;
				node.renderable = hovered;
			}
		}
	} finally {
		reconciling = false;
	}
}

/** Wire the runtime. Call once from the game project after creating stateApp. */
export function wireSpawnedElements(next: WireOptions) {
	const alreadyWired = !!options;
	options = next;
	if (alreadyWired) {
		reconcile();
		return;
	}
	window.addEventListener('pointermove', updateSiblingHoverFromPointer, true);
	registerLayoutAssetResolver((assetKey) => resolveTexture(assetKey));

	// Reactive reconcile: override-data version, Pixi app readiness and loaded
	// assets are all reactive reads; applyLayoutOverrides adds the layout-type
	// (viewport) dependency for profile changes.
	$effect.root(() => {
		$effect(() => {
			getLayoutOverridesVersion();
			getViewportVersion(); // recompute spawned responsive elements on resize
			reconcile();
		});
	});

	// Parents mount/unmount with game states — reattach/detach accordingly.
	let registryReconcileQueued = false;
	onLayoutRegistryChange(() => {
		if (registryReconcileQueued) return;
		registryReconcileQueued = true;
		queueMicrotask(() => {
			try {
				reconcile();
			} finally {
				registryReconcileQueued = false;
			}
		});
	});
}
