/**
 * In-page bridge for the Layout Editor desktop tool.
 *
 * Loaded (dynamically) only when the game URL contains `?editor`. It renders a DOM
 * overlay above the Pixi canvas for selection/guides, handles pick/drag/resize in
 * Edit Mode, and talks to the embedding editor window via postMessage.
 *
 * This file must never run in a normal game session.
 */

import * as SPINE_PIXI from '@esotericsoftware/spine-pixi-v8';

import {
	captureParentRect,
	ensureLayoutId,
	getActiveLayoutType,
	getAuthoredValues,
	getAuthoredTexture,
	getEditorGameHooks,
	getGameLayout,
	getLayoutOverridesData,
	getMergedOverride,
	getGameScale,
	getLayoutDisplaySize,
	getLayoutLocalBounds,
	getParentWorldScale,
	getReferenceRect,
	getResponsiveAxisBase,
	localLengthToResponsive,
	getRegisteredLayoutNodes,
	getResponsiveConfig,
	getSpawnedDefinitionId,
	globalTransformOf,
	isGameLayoutWired,
	onLayoutRegistryChange,
	replaceLayoutOverrides,
	refreshViewportLayout,
	responsiveEnabled,
	setLayoutOverride,
	setSampleText,
	isLayoutTypeWired,
	isSpawnedNode,
	isTemporaryLayoutContainerNode,
	LAYOUT_EDITOR_BRIDGE_REVISION,
	LAYOUT_EDITOR_BRIDGE_VERSION,
	type LayoutProfileName,
	type ResponsiveConfig,
	type ResponsiveRect,
} from './layoutOverrides.svelte';
import { getSpawnedRuntime } from './spawnedElements.svelte';
import { createPerformanceSampler } from './performanceSampler';
import { armTestBookRequest, validateTestBookRequest } from './testBookRequest';

type AnyNode = any;

type GuideConfig = {
	centers: boolean;
	safeArea: { enabled: boolean; top: number; bottom: number; left: number; right: number };
	grid: { enabled: boolean; size: number };
	snap: boolean;
	boundsAll: boolean;
};

type Rect = { x: number; y: number; width: number; height: number };

const MSG = '__sle';
const SNAP_THRESHOLD = 8;

const round = (value: number, decimals = 2) => {
	const f = 10 ** decimals;
	return Math.round(value * f) / f;
};

export function initEditorBridge({ getApp }: { getApp: () => any }) {
	if ((window as AnyNode).__SLE_BRIDGE__) return;

	// ------------------------------------------------------------------
	// State
	// ------------------------------------------------------------------
	let mode: 'edit' | 'preview' = 'preview';
	let scope: 'base' | 'profile' = 'profile';
	let selectedNode: AnyNode = null;
	let hoverNode: AnyNode = null;
	let guides: GuideConfig = {
		centers: false,
		safeArea: { enabled: false, top: 5, bottom: 5, left: 5, right: 5 },
		grid: { enabled: false, size: 50 },
		snap: true,
		boundsAll: false,
	};
	let lastPick = { x: -1, y: -1, index: 0, ids: [] as string[] };
	let lastSentValues = '';
	let lastLayoutKey = '';
	let treeTimer: ReturnType<typeof setTimeout> | undefined;
	let nudgeCommitTimer: ReturnType<typeof setTimeout> | undefined;
	let nudgeBefore: Record<string, unknown> | null = null;
	let nudgeProfile: LayoutProfileName | null = null;
	let nudgeId: string | null = null;
	// The editor stamps each iframe navigation into the document URL. Unlike the
	// iframe's WindowProxy, this token changes across reloads, so a queued message
	// from the previous document can never join the next editing session.
	let navigationSession: unknown = (() => {
		try {
			const value = new URLSearchParams(window.location.search).get('__sle_session');
			if (value === null) return null;
			const parsed = Number(value);
			return Number.isSafeInteger(parsed) ? parsed : null;
		} catch {
			return null;
		}
	})();

	const post = (type: string, payload?: unknown) => {
		window.parent?.postMessage({ [MSG]: true, type, payload, navigationSession }, '*');
	};

	const log = (msg: string) => post('log', { msg });
	const performanceSampler = createPerformanceSampler({
		getApp,
		post: (sample) => post('performanceSample', sample),
	});
	window.addEventListener('beforeunload', () => performanceSampler.stop(), { once: true });
	window.addEventListener('beforeunload', () => cancelPendingTestBook?.(), { once: true });

	// ------------------------------------------------------------------
	// Overlay DOM
	// ------------------------------------------------------------------
	const root = document.createElement('div');
	root.id = '__sle_root';
	root.style.cssText =
		'position:fixed;inset:0;z-index:999999;pointer-events:none;font-family:Consolas,monospace;';

	const guideCanvas = document.createElement('canvas');
	guideCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
	root.appendChild(guideCanvas);

	const boundsLayer = document.createElement('div');
	boundsLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
	root.appendChild(boundsLayer);

	const shield = document.createElement('div');
	shield.style.cssText =
		'position:absolute;inset:0;pointer-events:none;touch-action:none;cursor:default;';
	root.appendChild(shield);

	const hoverBox = document.createElement('div');
	hoverBox.style.cssText =
		'position:absolute;display:none;border:1px dashed #4da3ff;pointer-events:none;';
	root.appendChild(hoverBox);

	const selBox = document.createElement('div');
	selBox.style.cssText =
		'position:absolute;display:none;border:1.5px solid #ff9f1a;pointer-events:none;box-sizing:border-box;';
	root.appendChild(selBox);

	const nameTag = document.createElement('div');
	nameTag.style.cssText =
		'position:absolute;top:-22px;left:-2px;background:#ff9f1a;color:#1a1a1a;padding:1px 6px;' +
		'font-size:11px;white-space:nowrap;border-radius:2px;pointer-events:none;';
	selBox.appendChild(nameTag);

	const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
	type HandleName = (typeof HANDLES)[number];
	const handleEls = new Map<HandleName, HTMLDivElement>();
	for (const handleName of HANDLES) {
		const el = document.createElement('div');
		el.dataset.handle = handleName;
		el.style.cssText =
			'position:absolute;width:9px;height:9px;background:#fff;border:1.5px solid #ff9f1a;' +
			'border-radius:1px;pointer-events:auto;box-sizing:border-box;';
		el.style.cursor = `${handleName}-resize`;
		selBox.appendChild(el);
		handleEls.set(handleName, el);
	}

	const positionHandles = (w: number, h: number) => {
		const positionMap: Record<HandleName, [number, number]> = {
			nw: [0, 0],
			n: [w / 2, 0],
			ne: [w, 0],
			e: [w, h / 2],
			se: [w, h],
			s: [w / 2, h],
			sw: [0, h],
			w: [0, h / 2],
		};
		for (const [handleName, el] of handleEls) {
			const [hx, hy] = positionMap[handleName];
			el.style.left = `${hx - 4.5}px`;
			el.style.top = `${hy - 4.5}px`;
		}
	};

	document.body.appendChild(root);

	// ------------------------------------------------------------------
	// Node helpers
	// ------------------------------------------------------------------
	const app = () => getApp();
	const transformedRect = (rect: AnyNode, matrix: AnyNode): Rect | null => {
		if (
			!rect || !matrix ||
			![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
			rect.width <= 0 || rect.height <= 0
		) return null;
		const point = (x: number, y: number) => ({
			x: matrix.a * x + matrix.c * y + matrix.tx,
			y: matrix.b * x + matrix.d * y + matrix.ty,
		});
		const points = [
			point(rect.x, rect.y),
			point(rect.x + rect.width, rect.y),
			point(rect.x + rect.width, rect.y + rect.height),
			point(rect.x, rect.y + rect.height),
		];
		const xs = points.map((entry) => entry.x);
		const ys = points.map((entry) => entry.y);
		const left = Math.min(...xs);
		const top = Math.min(...ys);
		return {
			x: left,
			y: top,
			width: Math.max(...xs) - left,
			height: Math.max(...ys) - top,
		};
	};

	const nodeBounds = (node: AnyNode): Rect | null => {
		try {
			// A responsive container publishes an explicit logical frame. Its Pixi
			// bounds are child-derived and may cover only a fraction of that frame.
			if (node.__sleRefRect) {
				const world = globalTransformOf(node);
				const logical = transformedRect(node.__sleRefRect, world);
				if (logical) return logical;
			}
			// Spine's native Pixi bounds follow its current animation frame. Project
			// the shared fixed setup-pose AABB instead so every editor geometry path
			// (selection, picking, snapping, resize and align) sees the same box.
			if (node.skeleton) {
				const fixedLocal = getLayoutLocalBounds(node);
				const world = globalTransformOf(node);
				return transformedRect(fixedLocal, world);
			}
			const bounds = node.getBounds();
			const rect = bounds.rectangle ?? bounds;
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		} catch {
			return null;
		}
	};

	const isWorldVisible = (node: AnyNode) => {
		let current = node;
		while (current) {
			if (!current.visible || current.alpha === 0) return false;
			current = current.parent;
		}
		return true;
	};

	const nodeType = (node: AnyNode): string => {
		if (node.skeleton) return 'spine';
		if (typeof node.text === 'string' && node.style) {
			return node.fontSize !== undefined || node.constructor?.name === 'BitmapText'
				? 'text'
				: 'text';
		}
		if (node.anchor && node.texture) return 'sprite';
		if (typeof node.fill === 'function' || node.context) return 'graphics';
		return 'container';
	};

	const isTextLike = (node: AnyNode) => typeof node.text === 'string' && !!node.style;
	const isContainerLikeNode = (node: AnyNode) =>
		!node.texture && !isTextLike(node) && !node.context && !node.skeleton;
	const hasStableLayoutIdentity = (node: AnyNode) => {
		if (isSpawnedNode(node)) return true;
		const label = typeof node?.label === 'string' ? node.label.trim() : '';
		if (!label) return false;
		let matches = 0;
		for (const candidate of getRegisteredLayoutNodes()) {
			if (typeof candidate?.label === 'string' && candidate.label.trim() === label) matches++;
			if (matches > 1) return false;
		}
		return matches === 1;
	};
	const canEditLayoutNode = (node: AnyNode) => {
		if (!node) return false;
		if (isTemporaryLayoutContainerNode(node)) return false;
		if (nodeType(node) !== 'container') return true;
		return isSpawnedNode(node) || hasStableLayoutIdentity(node);
	};

	// Render-order index for every registered node (stage traversal order).
	const renderOrder = (): Map<AnyNode, number> => {
		const order = new Map<AnyNode, number>();
		let index = 0;
		const stage = app()?.stage;
		const walk = (node: AnyNode) => {
			order.set(node, index++);
			const children = node?.children ?? [];
			for (const child of children) walk(child);
		};
		if (stage) walk(stage);
		return order;
	};

	const nodeById = (id: string | null): AnyNode =>
		id ? getRegisteredLayoutNodes().find((node) => ensureLayoutId(node) === id) : null;

	const activeProfile = (): LayoutProfileName =>
		scope === 'base' ? 'base' : getActiveLayoutType();
	const loadedAssetCatalog = (): Record<string, unknown> => {
		try {
			return getSpawnedRuntime().getLoadedAssets?.() ?? {};
		} catch {
			return {};
		}
	};
	const isTextureAsset = (value: AnyNode) =>
		!!value && !!value.source && typeof value.width === 'number' && typeof value.height === 'number';
	const textureAssetKeys = new WeakMap<object, string>();
	const textureAssetKey = (
		texture: AnyNode,
		preferredKey?: string | null,
		loadedAssets = loadedAssetCatalog(),
	): string | null => {
		if (!texture) return null;
		if (preferredKey && loadedAssets[preferredKey] === texture) {
			if (typeof texture === 'object') textureAssetKeys.set(texture, preferredKey);
			return preferredKey;
		}
		const cached = typeof texture === 'object' ? textureAssetKeys.get(texture) : null;
		if (cached && loadedAssets[cached] === texture) return cached;
		for (const [key, value] of Object.entries(loadedAssets)) {
			if (value === texture && isTextureAsset(value)) {
				if (typeof texture === 'object') textureAssetKeys.set(texture, key);
				return key;
			}
		}
		return null;
	};
	const spriteAssetInfo = (node: AnyNode, id: string, definitionId?: string | null) => {
		const loadedAssets = loadedAssetCatalog();
		const definition = definitionId
			? (getLayoutOverridesData().elements ?? []).find((entry) => entry.id === definitionId)
			: null;
		const overrideKey = getMergedOverride(id).assetKey;
		const requestedKey =
			definition?.kind === 'sprite' && definition.assetKey
				? definition.assetKey
				: typeof overrideKey === 'string' && overrideKey
					? overrideKey
					: null;
		const currentKey = textureAssetKey(node.texture, requestedKey ?? node.label, loadedAssets);
		const assetKey = requestedKey ?? currentKey;
		const authoredAssetKey = textureAssetKey(getAuthoredTexture(node), node.label, loadedAssets);
		return {
			assetKey,
			authoredAssetKey,
			assetAvailable: !!assetKey && isTextureAsset(loadedAssets[assetKey]),
		};
	};
	const GEOMETRY_FIELDS = new Set([
		'x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'anchorX', 'anchorY',
		'fontSize', 'responsive',
	]);
	const baseGeometryShadowed = (id: string) => {
		const profile = getActiveLayoutType();
		const entry = getLayoutOverridesData().profiles[profile]?.[id];
		return !!entry && Object.keys(entry).some((key) => GEOMETRY_FIELDS.has(key));
	};

	const responsiveAtScope = (
		id: string,
		profile: LayoutProfileName,
	): ResponsiveConfig | undefined => {
		const overrideData = getLayoutOverridesData();
		const own = overrideData.profiles[profile]?.[id]?.responsive;
		const base = overrideData.profiles.base?.[id]?.responsive;
		const value = profile === 'base' ? base : own !== undefined ? own : base;
		return value && typeof value === 'object' ? value : undefined;
	};

	const collectValues = (node: AnyNode) => {
		const id = ensureLayoutId(node);
		const definitionId = getSpawnedDefinitionId(node);
		const authored = getAuthoredValues(node);
		const bounds = nodeBounds(node);
		const overrideData = getLayoutOverridesData();
		const layoutProfile = getActiveLayoutType();
		const profileResponsive = overrideData.profiles[layoutProfile]?.[id]?.responsive;
		const baseResponsive = overrideData.profiles.base?.[id]?.responsive;
		const targetProfile = activeProfile();
		const targetResponsive = overrideData.profiles[targetProfile]?.[id]?.responsive;
		const responsiveSource = profileResponsive !== undefined
			? profileResponsive === false ? 'disabled' : 'profile'
			: baseResponsive !== undefined
				? 'base'
				: 'native';
		const fixedSpineSize = node.skeleton ? getLayoutDisplaySize(node) : null;
		const values: Record<string, unknown> = {
			x: round(node.x),
			y: round(node.y),
			scaleX: round(node.scale?.x ?? 1, 4),
			scaleY: round(node.scale?.y ?? 1, 4),
			width: round(node.skeleton ? (fixedSpineSize?.width ?? 0) : (node.width ?? 0)),
			height: round(node.skeleton ? (fixedSpineSize?.height ?? 0) : (node.height ?? 0)),
			visible: !!node.visible,
			zIndex: round(Number(node.zIndex) || 0),
		};
		if (node.anchor) {
			values.anchorX = round(node.anchor.x, 4);
			values.anchorY = round(node.anchor.y, 4);
		}
		if (isTextLike(node)) {
			values.fontSize = round(Number(node.style?.fontSize) || 0);
			values.align = node.style?.align ?? 'left';
			values.text = String(node.text).slice(0, 120);
		}
		const assetInfo = nodeType(node) === 'sprite'
			? spriteAssetInfo(node, id, definitionId)
			: null;
		if (assetInfo?.assetKey) values.assetKey = assetInfo.assetKey;
		return {
			id,
			type: nodeType(node),
			hasAnchor: !!node.anchor,
			isText: isTextLike(node),
			spawned: isSpawnedNode(node),
			definitionId,
			identityConflict: !!definitionId && definitionId !== id,
			container: isContainerLikeNode(node),
			identityStable: hasStableLayoutIdentity(node) && !isTemporaryLayoutContainerNode(node),
			temporaryRuntimeId: isTemporaryLayoutContainerNode(node),
			authoredAssetKey: assetInfo?.authoredAssetKey ?? null,
			assetAvailable: assetInfo?.assetAvailable ?? false,
			responsive: getResponsiveConfig(id) ?? null,
			responsiveSource,
			responsiveTarget: targetResponsive ?? null,
			responsiveTargetSet: targetResponsive !== undefined,
			baseGeometryShadowed: baseGeometryShadowed(id),
			// context for the inspector's size-behavior controls
			gameScale: getGameScale(),
			gameLayoutWired: isGameLayoutWired(),
			effective: values,
			authored: Object.fromEntries(
				Object.entries(authored).map(([key, value]) => [
					key,
					typeof value === 'number' ? round(value, 4) : value,
				]),
			),
			override: getMergedOverride(id),
			bounds,
		};
	};

	// ------------------------------------------------------------------
	// Tree
	// ------------------------------------------------------------------
	const buildTree = () => {
		const nodes = getRegisteredLayoutNodes();
		const order = renderOrder();
		const registered = new Set(nodes);
		const parentTargets = getEditorGameHooks().parentTargets ?? {};
		const entries = nodes
			.map((node) => {
				const id = ensureLayoutId(node);
				const definitionId = getSpawnedDefinitionId(node);
				const type = nodeType(node);
				const assetInfo = type === 'sprite'
					? spriteAssetInfo(node, id, definitionId)
					: null;
				let parent = node.parent;
				while (parent && !registered.has(parent)) parent = parent.parent;
				return {
					id,
					name: id,
					type,
					parentId: parent ? ensureLayoutId(parent) : null,
					order: order.get(node) ?? 0,
					visible: !!node.visible,
					worldVisible: isWorldVisible(node),
					zIndex: round(Number(node.zIndex) || 0),
					isText: isTextLike(node),
					textPreview: isTextLike(node) ? String(node.text).slice(0, 40) : undefined,
					hasAnchor: !!node.anchor,
					spawned: isSpawnedNode(node),
					definitionId,
					identityConflict: !!definitionId && definitionId !== id,
					identityStable: hasStableLayoutIdentity(node) && !isTemporaryLayoutContainerNode(node),
					temporaryRuntimeId: isTemporaryLayoutContainerNode(node),
					assetKey: assetInfo?.assetKey ?? null,
					authoredAssetKey: assetInfo?.authoredAssetKey ?? null,
					assetAvailable: assetInfo?.assetAvailable ?? false,
					parentTarget: parentTargets[id],
				};
			})
			.sort((a, b) => a.order - b.order);
		return entries;
	};

	const sendTree = () => post('tree', { nodes: buildTree() });
	const queueTree = () => {
		clearTimeout(treeTimer);
		treeTimer = setTimeout(sendTree, 400);
	};
	onLayoutRegistryChange(queueTree);

	// Stake can finish populating loadedAssets after the editor bridge connects.
	// Refresh tree asset labels once that catalog changes so container shortcuts
	// do not stay stuck on an early "unavailable" snapshot.
	let lastAssetCatalogFingerprint = '';
	setInterval(() => {
		const loadedAssets = loadedAssetCatalog();
		const fingerprint = Object.entries(loadedAssets)
			.map(([key, value]) => {
				const asset = value as AnyNode;
				const kind = isTextureAsset(asset)
					? 'texture'
					: asset?.bones && asset?.slots
						? 'spine'
						: 'other';
				return `${key}:${kind}`;
			})
			.sort()
			.join('\u0000');
		if (fingerprint === lastAssetCatalogFingerprint) return;
		lastAssetCatalogFingerprint = fingerprint;
		queueTree();
	}, 750);

	// ------------------------------------------------------------------
	// Guides
	// ------------------------------------------------------------------
	const drawGuides = (snapLines?: { x?: number[]; y?: number[] }) => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		const dpr = window.devicePixelRatio || 1;
		if (guideCanvas.width !== w * dpr || guideCanvas.height !== h * dpr) {
			guideCanvas.width = w * dpr;
			guideCanvas.height = h * dpr;
			guideCanvas.style.width = `${w}px`;
			guideCanvas.style.height = `${h}px`;
		}
		const ctx = guideCanvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		if (mode !== 'edit') return;

		if (guides.grid.enabled && guides.grid.size >= 4) {
			ctx.strokeStyle = 'rgba(120,160,255,0.15)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let gx = 0; gx <= w; gx += guides.grid.size) {
				ctx.moveTo(gx + 0.5, 0);
				ctx.lineTo(gx + 0.5, h);
			}
			for (let gy = 0; gy <= h; gy += guides.grid.size) {
				ctx.moveTo(0, gy + 0.5);
				ctx.lineTo(w, gy + 0.5);
			}
			ctx.stroke();
		}

		if (guides.safeArea.enabled) {
			const sa = guides.safeArea;
			const left = (w * sa.left) / 100;
			const top = (h * sa.top) / 100;
			ctx.strokeStyle = 'rgba(80,220,120,0.7)';
			ctx.setLineDash([6, 4]);
			ctx.strokeRect(left, top, w - left - (w * sa.right) / 100, h - top - (h * sa.bottom) / 100);
			ctx.setLineDash([]);
		}

		if (guides.centers) {
			ctx.strokeStyle = 'rgba(255,120,220,0.5)';
			ctx.setLineDash([4, 4]);
			ctx.beginPath();
			ctx.moveTo(w / 2 + 0.5, 0);
			ctx.lineTo(w / 2 + 0.5, h);
			ctx.moveTo(0, h / 2 + 0.5);
			ctx.lineTo(w, h / 2 + 0.5);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		if (snapLines) {
			ctx.strokeStyle = 'rgba(255,80,80,0.9)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (const sx of snapLines.x ?? []) {
				ctx.moveTo(sx + 0.5, 0);
				ctx.lineTo(sx + 0.5, h);
			}
			for (const sy of snapLines.y ?? []) {
				ctx.moveTo(0, sy + 0.5);
				ctx.lineTo(w, sy + 0.5);
			}
			ctx.stroke();
		}

		drawResponsiveOverlay(ctx);
	};

	// Editor-only visualization of the selected element's responsive relationship:
	// the reference rectangle, the anchor point + connector, and stretch arrows.
	const drawResponsiveOverlay = (ctx: CanvasRenderingContext2D) => {
		if (mode !== 'edit' || !selectedNode || selectedNode.destroyed) return;
		const cfg = getResponsiveConfig(ensureLayoutId(selectedNode));
		if (!responsiveEnabled(cfg)) return;
		const ref = getReferenceRect(selectedNode, cfg);
		const c00 = toGlobalPoint(selectedNode, ref.x, ref.y);
		const c10 = toGlobalPoint(selectedNode, ref.x + ref.width, ref.y);
		const c11 = toGlobalPoint(selectedNode, ref.x + ref.width, ref.y + ref.height);
		const c01 = toGlobalPoint(selectedNode, ref.x, ref.y + ref.height);
		ctx.save();
		ctx.strokeStyle = 'rgba(90,200,255,0.85)';
		ctx.setLineDash([5, 4]);
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(c00.x, c00.y);
		ctx.lineTo(c10.x, c10.y);
		ctx.lineTo(c11.x, c11.y);
		ctx.lineTo(c01.x, c01.y);
		ctx.closePath();
		ctx.stroke();
		ctx.setLineDash([]);

		const midY = (c00.y + c01.y) / 2;
		const midX = (c00.x + c10.x) / 2;
		const arrow = (x1: number, y1: number, x2: number, y2: number) => {
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
			const a = Math.atan2(y2 - y1, x2 - x1);
			for (const s of [-1, 1]) {
				ctx.beginPath();
				ctx.moveTo(x2, y2);
				ctx.lineTo(x2 - 7 * Math.cos(a - (s * Math.PI) / 6), y2 - 7 * Math.sin(a - (s * Math.PI) / 6));
				ctx.stroke();
			}
		};
		ctx.strokeStyle = 'rgba(90,200,255,0.9)';
		if (cfg!.stretchX) {
			arrow(midX, midY, c10.x - 4, midY);
			arrow(midX, midY, c00.x + 4, midY);
		}
		if (cfg!.stretchY) {
			arrow(midX, midY, midX, c01.y - 4);
			arrow(midX, midY, midX, c00.y + 4);
		}

		// Solver base point + connector to the element origin (anchored axes).
		// Fit/cover aligns the visual AABB in the remaining/cropped space, so its
		// base is deliberately not refStart + anchor * refSize.
		if ((cfg!.x || cfg!.y) && !(cfg!.stretchX && cfg!.stretchY)) {
			const baseX = cfg!.x
				? getResponsiveAxisBase(selectedNode, cfg!, ref, 'x', cfg!.x.anchor ?? 0.5)
				: selectedNode.x;
			const baseY = cfg!.y
				? getResponsiveAxisBase(selectedNode, cfg!, ref, 'y', cfg!.y.anchor ?? 0.5)
				: selectedNode.y;
			const aG = toGlobalPoint(selectedNode, baseX, baseY);
			const oG = toGlobalPoint(selectedNode, selectedNode.x, selectedNode.y);
			ctx.strokeStyle = 'rgba(255,159,26,0.9)';
			ctx.beginPath();
			ctx.moveTo(aG.x, aG.y);
			ctx.lineTo(oG.x, oG.y);
			ctx.stroke();
			ctx.fillStyle = 'rgba(255,159,26,0.95)';
			ctx.beginPath();
			ctx.arc(aG.x, aG.y, 4, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.restore();
	};

	const renderBoundsAll = () => {
		boundsLayer.innerHTML = '';
		if (!guides.boundsAll || mode !== 'edit') return;
		for (const node of getRegisteredLayoutNodes()) {
			if (!canEditLayoutNode(node)) continue;
			if (!isWorldVisible(node)) continue;
			const rect = nodeBounds(node);
			if (!rect || rect.width < 2 || rect.height < 2) continue;
			if (rect.width >= window.innerWidth * 1.5 && rect.height >= window.innerHeight * 1.5)
				continue;
			const box = document.createElement('div');
			box.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:1px solid rgba(120,160,255,0.25);pointer-events:none;`;
			boundsLayer.appendChild(box);
		}
	};

	// ------------------------------------------------------------------
	// Selection visuals + value streaming (per frame)
	// ------------------------------------------------------------------
	const refreshSelectionVisuals = () => {
		if (selectedNode && (selectedNode.destroyed || !getRegisteredLayoutNodes().includes(selectedNode))) {
			const definitionId = getSpawnedDefinitionId(selectedNode);
			const replacement = definitionId ? nodeById(definitionId) : null;
			if (replacement) {
				selectedNode = replacement;
				lastSentValues = '';
			} else {
				selectedNode = null;
				post('selected', { id: null });
			}
		}
		if (hoverNode && hoverNode.destroyed) hoverNode = null;

		if (hoverNode && canEditLayoutNode(hoverNode) && mode === 'edit' && hoverNode !== selectedNode) {
			const rect = nodeBounds(hoverNode);
			if (rect) {
				hoverBox.style.display = 'block';
				hoverBox.style.left = `${rect.x}px`;
				hoverBox.style.top = `${rect.y}px`;
				hoverBox.style.width = `${rect.width}px`;
				hoverBox.style.height = `${rect.height}px`;
			}
		} else {
			hoverBox.style.display = 'none';
		}

		if (selectedNode && mode === 'edit') {
			const editable = canEditLayoutNode(selectedNode);
			for (const handle of handleEls.values()) handle.style.display = editable ? '' : 'none';
			selBox.style.borderStyle = editable ? 'solid' : 'dashed';
			const rect = nodeBounds(selectedNode);
			if (rect) {
				selBox.style.display = 'block';
				selBox.style.left = `${rect.x - 1}px`;
				selBox.style.top = `${rect.y - 1}px`;
				selBox.style.width = `${rect.width + 2}px`;
				selBox.style.height = `${rect.height + 2}px`;
				nameTag.textContent = ensureLayoutId(selectedNode);
				positionHandles(rect.width + 2, rect.height + 2);
			}
			const values = collectValues(selectedNode);
			const key = JSON.stringify({
				effective: values.effective,
				bounds: values.bounds,
				responsive: values.responsive,
				responsiveSource: values.responsiveSource,
				responsiveTarget: values.responsiveTarget,
				baseGeometryShadowed: values.baseGeometryShadowed,
				gameScale: values.gameScale,
				authoredAssetKey: values.authoredAssetKey,
				assetAvailable: values.assetAvailable,
			});
			if (key !== lastSentValues) {
				lastSentValues = key;
				post('values', values);
			}
			// keep the responsive overlay tracking the element live
			if (editable && !gesture && responsiveEnabled(values.responsive as ResponsiveConfig | false | undefined)) {
				drawGuides();
			}
		} else {
			selBox.style.display = 'none';
		}

		const layoutKey = `${getActiveLayoutType()}|${window.innerWidth}x${window.innerHeight}`;
		if (layoutKey !== lastLayoutKey) {
			lastLayoutKey = layoutKey;
			post('layout', {
				layoutType: getActiveLayoutType(),
				width: window.innerWidth,
				height: window.innerHeight,
			});
			drawGuides();
			renderBoundsAll();
			queueTree(); // profile-specific visibility and Sprite asset keys may change
		}
	};

	setInterval(refreshSelectionVisuals, 33);

	// ------------------------------------------------------------------
	// Picking / drag / resize
	// ------------------------------------------------------------------
	const pickCandidates = (px: number, py: number): AnyNode[] => {
		const order = renderOrder();
		return getRegisteredLayoutNodes()
			.filter((node) => {
				if (!canEditLayoutNode(node)) return false;
				if (!isWorldVisible(node)) return false;
				const rect = nodeBounds(node);
				if (!rect || rect.width <= 0 || rect.height <= 0) return false;
				return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
			})
			.sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
	};

	type Gesture = {
		kind: 'drag' | 'resize';
		profile: LayoutProfileName;
		pointerId: number;
		node: AnyNode;
		id: string;
		handle?: HandleName;
		startClientX: number;
		startClientY: number;
		startLocalX: number;
		startLocalY: number;
		startBounds: Rect;
		startWidth: number;
		startHeight: number;
		startScaleX: number;
		startScaleY: number;
		useScale: boolean;
		before: Record<string, unknown>;
		moved: boolean;
		resp?: ResponsiveConfig;
		startBoxLocal?: ReturnType<typeof currentBoxLocal>;
		startRef?: ResponsiveRect;
		startScaleBase?: { x: number; y: number };
	};
	let gesture: Gesture | null = null;

	const parentInverseDelta = (node: AnyNode, dx: number, dy: number) => {
		const wt = globalTransformOf(node.parent) ?? node.parent?.worldTransform;
		if (!wt) return { x: dx, y: dy };
		const det = wt.a * wt.d - wt.b * wt.c;
		if (!det) return { x: dx, y: dy };
		return { x: (dx * wt.d - dy * wt.c) / det, y: (dy * wt.a - dx * wt.b) / det };
	};

	// ------------------------------------------------------------------
	// Responsive geometry helpers (all in the node's parent-local space)
	// ------------------------------------------------------------------
	// The element's visual AABB in parent-local units. Transforming local bounds
	// accounts for pivot, scale and rotation (the previous x/y+anchor shortcut did
	// not work for Stake's pivoted Containers and Spine objects).
	const currentBoxLocal = (node: AnyNode) => {
		try {
			// A published container frame is authoritative layout geometry. Using
			// child-derived bounds here would collapse it during structural edits.
			const bounds = node.__sleRefRect ?? getLayoutLocalBounds(node);
			const matrix = node.getLocalTransform?.() ?? node.localTransform;
			const rect = transformedRect(bounds, matrix);
			if (rect) return {
				left: rect.x,
				top: rect.y,
				right: rect.x + rect.width,
				bottom: rect.y + rect.height,
				width: rect.width,
				height: rect.height,
			};
		} catch {
			// fall back to the common sprite/text geometry below
		}
		const fixedSpineSize = node.skeleton ? getLayoutDisplaySize(node) : null;
		const width = node.skeleton ? (fixedSpineSize?.width ?? 0) : Math.abs(node.width ?? 0);
		const height = node.skeleton ? (fixedSpineSize?.height ?? 0) : Math.abs(node.height ?? 0);
		const anchorX = node.anchor?.x ?? 0;
		const anchorY = node.anchor?.y ?? 0;
		const left = node.x - anchorX * width;
		const top = node.y - anchorY * height;
		return { left, top, right: left + width, bottom: top + height, width, height };
	};

	const toGlobalPoint = (node: AnyNode, lx: number, ly: number) => {
		const wt = globalTransformOf(node.parent) ?? node.parent?.worldTransform;
		if (!wt) return { x: lx, y: ly };
		return { x: wt.a * lx + wt.c * ly + wt.tx, y: wt.b * lx + wt.d * ly + wt.ty };
	};

	/**
	 * Apply a structural responsive op to an element, preserving its current
	 * on-screen placement where sensible, then commit. Runs in the game so it can
	 * use live PixiJS transforms.
	 */
	const applyResponsiveOp = (
		id: string,
		scopeProfile: LayoutProfileName,
		op: AnyNode,
	) => {
		const node = nodeById(id);
		if (!node || !canEditLayoutNode(node)) return;
		const geometryOps = new Set([
			'anchor', 'axis', 'stretchX', 'stretchY', 'ref', 'fill',
			'aspect', 'scaleMode', 'clear',
		]);
		if (scopeProfile === 'base' && baseGeometryShadowed(id) && geometryOps.has(op.op)) {
			log('Base geometry is shadowed by the active profile; use Base in that profile before changing this rule.');
			return;
		}
		const before = overrideSnapshot(id, scopeProfile);
		const allData = getLayoutOverridesData();
		const ownValue = allData.profiles[scopeProfile]?.[id]?.responsive;
		const baseValue = allData.profiles.base?.[id]?.responsive;
		// Base edits must never clone the active profile's merged rule. Profile edits
		// start from their own rule, or materialise Base only when they intentionally
		// change an inherited rule.
		const sourceValue = scopeProfile === 'base'
			? baseValue
			: ownValue !== undefined
				? ownValue
				: baseValue;
		const cfg: ResponsiveConfig = sourceValue && typeof sourceValue === 'object'
			? JSON.parse(JSON.stringify(sourceValue))
			: {};
		if (!cfg.ref) cfg.ref = op.ref === 'game' || op.ref === 'parent' ? op.ref : 'viewport';
		if (cfg.ref === 'parent' && !cfg.parentRect) cfg.parentRect = captureParentRect(node);
		let ref = getReferenceRect(node, cfg);
		const box = currentBoxLocal(node);
		const props: AnyNode = {};
		const anchoredOffset = (
			axis: 'x' | 'y',
			anchor: number,
			position = Number(node[axis]),
			targetCfg = cfg,
			targetRef = ref,
		) => round(localLengthToResponsive(
			node,
			targetCfg,
			targetRef,
			axis,
			position - getResponsiveAxisBase(node, targetCfg, targetRef, axis, anchor),
		));
		const removeAspectPreservingPosition = () => {
			if (!cfg.aspect) return;
			delete cfg.aspect;
			if (cfg.x) cfg.x.offset = anchoredOffset('x', cfg.x.anchor);
			if (cfg.y) cfg.y.offset = anchoredOffset('y', cfg.y.anchor);
			delete cfg.aspectSign;
		};

		const materializeSize = () => {
			if (node.texture || isTextLike(node)) {
				props.width = round(Math.abs(node.width ?? box.width));
				props.height = round(Math.abs(node.height ?? box.height));
			} else {
				props.scaleX = round(node.scale?.x ?? 1, 6);
				props.scaleY = round(node.scale?.y ?? 1, 6);
			}
		};
		const materializeStretchAxis = (axis: 'x' | 'y') => {
			const stretchKey = axis === 'x' ? 'stretchX' : 'stretchY';
			if (!cfg[stretchKey]) return;
			if (isContainerLikeNode(node)) {
				const published = node.__sleRefRect as ResponsiveRect | undefined;
				const scale = Math.abs(axis === 'x' ? (node.scale?.x ?? 1) : (node.scale?.y ?? 1));
				const displayed = axis === 'x'
					? published?.width != null ? published.width * scale : box.width
					: published?.height != null ? published.height * scale : box.height;
				if (displayed > 0) {
					if (axis === 'x') cfg.logicalW = round(displayed);
					else cfg.logicalH = round(displayed);
				}
			} else if (axis === 'x') {
				const fixedSize = node.skeleton ? getLayoutDisplaySize(node) : null;
				props.width = round(node.skeleton
					? (fixedSize?.width ?? box.width)
					: Math.abs(node.width ?? box.width));
			} else {
				const fixedSize = node.skeleton ? getLayoutDisplaySize(node) : null;
				props.height = round(node.skeleton
					? (fixedSize?.height ?? box.height)
					: Math.abs(node.height ?? box.height));
			}
		};
		const keepPositionWhenRemovingStretch = () => {
			if (cfg.stretchX && !cfg.x) {
				cfg.x = { anchor: 0.5, offset: anchoredOffset('x', 0.5) };
			}
			if (cfg.stretchY && !cfg.y) {
				cfg.y = { anchor: 0.5, offset: anchoredOffset('y', 0.5) };
			}
		};
		const captureContainerFrame = () => {
			if (!isContainerLikeNode(node)) return;
			try {
				const bounds = node.getLocalBounds?.();
				if (bounds?.width > 0 && cfg.logicalW == null) {
					cfg.logicalW = round(bounds.width * Math.abs(node.scale?.x ?? 1));
				}
				if (bounds?.height > 0 && cfg.logicalH == null) {
					cfg.logicalH = round(bounds.height * Math.abs(node.scale?.y ?? 1));
				}
			} catch {
				// one-axis frame publication will wait until both dimensions are known
			}
		};
		const changeReference = (value: unknown) => {
			const nextRef = value === 'parent' ? 'parent' : value === 'game' ? 'game' : 'viewport';
			const nextCfg: ResponsiveConfig = { ...cfg, ref: nextRef };
			if (nextRef === 'parent') nextCfg.parentRect = captureParentRect(node);
			else delete nextCfg.parentRect;
			const nextRect = getReferenceRect(node, nextCfg);
			if (cfg.stretchX) {
				cfg.stretchX = {
					m0: round(localLengthToResponsive(node, nextCfg, nextRect, 'x', box.left - nextRect.x)),
					m1: round(localLengthToResponsive(node, nextCfg, nextRect, 'x', nextRect.x + nextRect.width - box.right)),
				};
			} else if (cfg.x) {
				cfg.x = { anchor: cfg.x.anchor, offset: anchoredOffset('x', cfg.x.anchor, node.x, nextCfg, nextRect) };
			}
			if (cfg.stretchY) {
				cfg.stretchY = {
					m0: round(localLengthToResponsive(node, nextCfg, nextRect, 'y', box.top - nextRect.y)),
					m1: round(localLengthToResponsive(node, nextCfg, nextRect, 'y', nextRect.y + nextRect.height - box.bottom)),
				};
			} else if (cfg.y) {
				cfg.y = { anchor: cfg.y.anchor, offset: anchoredOffset('y', cfg.y.anchor, node.y, nextCfg, nextRect) };
			}
			cfg.ref = nextRef;
			if (nextRef === 'parent') cfg.parentRect = nextCfg.parentRect;
			else delete cfg.parentRect;
			ref = nextRect;
		};
		if (op.ref && op.ref !== cfg.ref) changeReference(op.ref);

		switch (op.op) {
			case 'anchor': {
				const ax = op.ax as number;
				const ay = op.ay as number;
				materializeStretchAxis('x');
				materializeStretchAxis('y');
				cfg.x = { anchor: ax, offset: anchoredOffset('x', ax) };
				cfg.y = { anchor: ay, offset: anchoredOffset('y', ay) };
				delete cfg.stretchX;
				delete cfg.stretchY;
				break;
			}
			case 'axis': {
				const axis = op.axis === 'y' ? 'y' : 'x';
				const stretchKey = axis === 'x' ? 'stretchX' : 'stretchY';
				const start = axis === 'x' ? box.left : box.top;
				const end = axis === 'x' ? box.right : box.bottom;
				const refStart = axis === 'x' ? ref.x : ref.y;
				const refSize = axis === 'x' ? ref.width : ref.height;
				if (op.mode === 'none') {
					materializeStretchAxis(axis);
					delete cfg[axis];
					delete cfg[stretchKey];
					props[axis] = round(node[axis]);
				} else if (op.mode === 'stretch') {
					if (cfg.aspect || (cfg.scaleMode && cfg.scaleMode !== 'parent')) materializeSize();
					removeAspectPreservingPosition();
					cfg[stretchKey] = {
						m0: round(localLengthToResponsive(node, cfg, ref, axis, start - refStart)),
						m1: round(localLengthToResponsive(node, cfg, ref, axis, refStart + refSize - end)),
					};
					delete cfg[axis];
					delete cfg.scaleMode;
					delete cfg.scaleBase;
					captureContainerFrame();
				} else {
					materializeStretchAxis(axis);
					const anchor = op.mode === 'end' ? 1 : op.mode === 'center' ? 0.5 : 0;
					cfg[axis] = { anchor, offset: anchoredOffset(axis, anchor) };
					delete cfg[stretchKey];
				}
				break;
			}
			case 'stretchX': {
				if (op.on) {
					if (cfg.aspect || (cfg.scaleMode && cfg.scaleMode !== 'parent')) materializeSize();
					removeAspectPreservingPosition();
					cfg.stretchX = {
						m0: round(localLengthToResponsive(node, cfg, ref, 'x', box.left - ref.x)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'x', ref.x + ref.width - box.right)),
					};
					delete cfg.x;
					delete cfg.scaleMode;
					delete cfg.scaleBase;
					captureContainerFrame();
				} else {
					materializeStretchAxis('x');
					delete cfg.stretchX;
					cfg.x = { anchor: 0, offset: anchoredOffset('x', 0) };
				}
				break;
			}
			case 'stretchY': {
				if (op.on) {
					if (cfg.aspect || (cfg.scaleMode && cfg.scaleMode !== 'parent')) materializeSize();
					removeAspectPreservingPosition();
					cfg.stretchY = {
						m0: round(localLengthToResponsive(node, cfg, ref, 'y', box.top - ref.y)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'y', ref.y + ref.height - box.bottom)),
					};
					delete cfg.y;
					delete cfg.scaleMode;
					delete cfg.scaleBase;
					captureContainerFrame();
				} else {
					materializeStretchAxis('y');
					delete cfg.stretchY;
					cfg.y = { anchor: 0, offset: anchoredOffset('y', 0) };
				}
				break;
			}
			case 'ref': {
				changeReference(op.ref);
				break;
			}
			case 'fill': {
				cfg.stretchX = op.zero
					? { m0: 0, m1: 0 }
					: {
						m0: round(localLengthToResponsive(node, cfg, ref, 'x', box.left - ref.x)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'x', ref.x + ref.width - box.right)),
					};
				cfg.stretchY = op.zero
					? { m0: 0, m1: 0 }
					: {
						m0: round(localLengthToResponsive(node, cfg, ref, 'y', box.top - ref.y)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'y', ref.y + ref.height - box.bottom)),
					};
				delete cfg.x;
				delete cfg.y;
				delete cfg.aspect;
				delete cfg.aspectSign;
				delete cfg.scaleMode;
				delete cfg.scaleBase;
				captureContainerFrame();
				break;
			}
			case 'aspect': {
				if (op.mode) {
					if (cfg.stretchX) delete cfg.stretchX;
					if (cfg.stretchY) delete cfg.stretchY;
					cfg.aspect = op.mode;
					cfg.aspectSign ??= {
						x: (Math.sign(node.scale?.x ?? 1) || 1) as 1 | -1,
						y: (Math.sign(node.scale?.y ?? 1) || 1) as 1 | -1,
					};
					delete cfg.scaleMode;
					delete cfg.scaleBase;
					if (!cfg.x) cfg.x = { anchor: 0.5, offset: 0 };
					if (!cfg.y) cfg.y = { anchor: 0.5, offset: 0 };
					cfg.x.offset = anchoredOffset('x', cfg.x.anchor);
					cfg.y.offset = anchoredOffset('y', cfg.y.anchor);
				} else {
					materializeSize();
					removeAspectPreservingPosition();
				}
				break;
			}
			case 'scaleMode': {
				// Responsive sizing. `scaleBase` is captured so the element keeps its
				// current world size when the mode is enabled.
				const mode = (op.mode === 'screen' ? 'game' : op.mode) as string | null;
				if (!mode || mode === 'parent') {
					materializeSize();
					removeAspectPreservingPosition();
					delete cfg.scaleMode;
					delete cfg.scaleBase;
					break;
				}
				const parentScale = getParentWorldScale(node);
				// Parent magnitudes cancel inherited scaling; the local signs preserve
				// intentionally mirrored assets.
				const worldX = parentScale.x * (node.scale?.x ?? 1);
				const worldY = parentScale.y * (node.scale?.y ?? 1);
				keepPositionWhenRemovingStretch();
				cfg.scaleMode = mode as AnyNode;
				removeAspectPreservingPosition();
				delete cfg.stretchX;
				delete cfg.stretchY;
				// A stage-level object following Stake's game scale also needs to live
				// in that same design-space frame. Materialise both axes when absent so
				// scale and position cannot drift independently on the next resize.
				if (mode === 'game' && cfg.ref === 'game') {
					if (!cfg.x) cfg.x = { anchor: 0.5, offset: anchoredOffset('x', 0.5) };
					if (!cfg.y) cfg.y = { anchor: 0.5, offset: anchoredOffset('y', 0.5) };
				}
				const factor = mode === 'game' ? (getGameScale() ?? 1) : 1;
				cfg.scaleBase = { x: round(worldX / factor, 6), y: round(worldY / factor, 6) };
				break;
			}
			case 'scaleBase': {
				// resize / numeric size edit while a responsive scale mode is active
				const current = cfg.scaleBase ?? { x: 1, y: 1 };
				if (Number.isFinite(op.value) && Math.abs(current.x) > 1e-9) {
					const magnitude = Math.abs(Number(op.value));
					const ratio = magnitude / Math.abs(current.x);
					cfg.scaleBase = {
						x: round((Math.sign(current.x) || 1) * magnitude, 6),
						y: round(current.y * ratio, 6),
					};
				} else {
					cfg.scaleBase = {
						x: round(op.x ?? current.x, 6),
						y: round(op.y ?? current.y, 6),
					};
				}
				break;
			}
			case 'number': {
				const group = op.group as 'x' | 'y' | 'stretchX' | 'stretchY';
				if (!['x', 'y', 'stretchX', 'stretchY'].includes(group)) break;
				const current = (cfg as AnyNode)[group] ?? {};
				(cfg as AnyNode)[group] = { ...current, [op.field]: Number(op.value) || 0 };
				break;
			}
			case 'set': {
				// direct numeric field edits (offset/margin/anchor) with no preservation
				for (const [key, value] of Object.entries(op.cfg ?? {})) {
					if (value === undefined || value === null) delete cfg[key as keyof ResponsiveConfig];
					else (cfg as AnyNode)[key] = value;
				}
				break;
			}
			case 'clear': {
				// Back to native/local behavior while preserving the current appearance.
				materializeSize();
				const inheritedBase = scopeProfile !== 'base' && responsiveEnabled(
					baseValue && typeof baseValue === 'object' ? baseValue : undefined,
				);
				setLayoutOverride(scopeProfile, id, {
					responsive: inheritedBase ? false : null,
					x: round(node.x),
					y: round(node.y),
					...props,
				});
				post('commit', { scope: scopeProfile, id, before, after: overrideSnapshot(id, scopeProfile), label: 'responsive off' });
				return;
			}
			case 'inherit': {
				setLayoutOverride(scopeProfile, id, { responsive: null });
				post('commit', { scope: scopeProfile, id, before, after: overrideSnapshot(id, scopeProfile), label: 'responsive inherit' });
				return;
			}
		}

		setLayoutOverride(scopeProfile, id, { ...props, responsive: cfg });
		post('commit', { scope: scopeProfile, id, before, after: overrideSnapshot(id, scopeProfile), label: 'responsive' });
	};

	const prepareReparent = (payload: AnyNode) => {
		const reqId = payload.reqId;
		const node = nodeById(payload.id);
		const stage = app()?.stage;
		const nextParent = payload.parentId ? nodeById(payload.parentId) : stage;
		if (!node || !stage || !nextParent || nextParent.destroyed) {
			post('reparentPrepared', { reqId, ok: false, error: 'Element or target parent is not mounted.' });
			return;
		}
		if (payload.parentId && !canEditLayoutNode(nextParent)) {
			post('reparentPrepared', {
				reqId,
				ok: false,
				error: 'Temporary runtime containers cannot be saved as parents. Choose the stage or a named container.',
			});
			return;
		}
		if (node === nextParent || isAncestorOf(node, nextParent)) {
			post('reparentPrepared', { reqId, ok: false, error: 'That parent would create a cycle.' });
			return;
		}

		const profile: LayoutProfileName = payload.profile ?? activeProfile();
		if (profile === 'base' && baseGeometryShadowed(payload.id)) {
			post('reparentPrepared', {
				reqId,
				ok: false,
				error: 'Use Base in the active preview profile before reparenting this Base element.',
			});
			return;
		}
		const oldParent = node.parent;
		const oldIndex = oldParent?.getChildIndex?.(node) ?? -1;
		const oldState = {
			x: node.x,
			y: node.y,
			scaleX: node.scale?.x ?? 1,
			scaleY: node.scale?.y ?? 1,
		};
		try {
			const world = globalTransformOf(node);
			const parentWorld = globalTransformOf(nextParent);
			if (!world || !parentWorld) throw new Error('World transforms are not ready.');
			const det = parentWorld.a * parentWorld.d - parentWorld.b * parentWorld.c;
			if (!det) throw new Error('Target parent has a singular transform.');
			const gx = world.tx;
			const gy = world.ty;
			const dx = gx - parentWorld.tx;
			const dy = gy - parentWorld.ty;
			const localX = (dx * parentWorld.d - dy * parentWorld.c) / det;
			const localY = (dy * parentWorld.a - dx * parentWorld.b) / det;
			// Full relative linear transform: inverse(target parent) * old world.
			// Spawned definitions persist x/y and independent scale only, so a
			// relative rotation/skew cannot be represented without changing appearance.
			const relativeA = (parentWorld.d * world.a - parentWorld.c * world.b) / det;
			const relativeB = (-parentWorld.b * world.a + parentWorld.a * world.b) / det;
			const relativeC = (parentWorld.d * world.c - parentWorld.c * world.d) / det;
			const relativeD = (-parentWorld.b * world.c + parentWorld.a * world.d) / det;
			const linearMagnitude = Math.max(1, Math.abs(relativeA), Math.abs(relativeD));
			if (Math.abs(relativeB) > 1e-5 * linearMagnitude || Math.abs(relativeC) > 1e-5 * linearMagnitude) {
				throw new Error(
					'That parent would require rotation or skew to preserve this element. Choose a transform-compatible parent.',
				);
			}
			const nextScaleX = relativeA;
			const nextScaleY = relativeD;
			// Capture the target's stable frame before inserting the child, otherwise an
			// ordinary Pixi Container's child-derived bounds would be self-referential.
			const nextParentRect = captureParentRect({ parent: nextParent });

			nextParent.addChild(node);
			node.x = localX;
			node.y = localY;
			node.scale?.set?.(nextScaleX, nextScaleY);
			if (node.scale && !node.scale.set) {
				node.scale.x = nextScaleX;
				node.scale.y = nextScaleY;
			}

			const data = getLayoutOverridesData();
			const own = data.profiles[profile]?.[payload.id];
			const base = data.profiles.base?.[payload.id];
			const sourceResponsive = profile === 'base'
				? base?.responsive
				: own?.responsive !== undefined
					? own.responsive
					: base?.responsive;
			const entry: AnyNode = own ? JSON.parse(JSON.stringify(own)) : {};
			if (sourceResponsive && typeof sourceResponsive === 'object') {
				const cfg: ResponsiveConfig = JSON.parse(JSON.stringify(sourceResponsive));
				if (cfg.aspect) {
					cfg.aspectSign = {
						x: (Math.sign(nextScaleX) || 1) as 1 | -1,
						y: (Math.sign(nextScaleY) || 1) as 1 | -1,
					};
				}
				if (cfg.ref === 'parent') cfg.parentRect = nextParentRect;
				const ref = getReferenceRect(node, cfg);
				const box = currentBoxLocal(node);
				if (cfg.stretchX) {
					cfg.stretchX = {
						m0: round(localLengthToResponsive(node, cfg, ref, 'x', box.left - ref.x)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'x', ref.x + ref.width - box.right)),
					};
				} else if (cfg.x) {
					cfg.x.offset = round(localLengthToResponsive(
						node, cfg, ref, 'x', node.x - getResponsiveAxisBase(node, cfg, ref, 'x', cfg.x.anchor),
					));
				} else entry.x = round(node.x);
				if (cfg.stretchY) {
					cfg.stretchY = {
						m0: round(localLengthToResponsive(node, cfg, ref, 'y', box.top - ref.y)),
						m1: round(localLengthToResponsive(node, cfg, ref, 'y', ref.y + ref.height - box.bottom)),
					};
				} else if (cfg.y) {
					cfg.y.offset = round(localLengthToResponsive(
						node, cfg, ref, 'y', node.y - getResponsiveAxisBase(node, cfg, ref, 'y', cfg.y.anchor),
					));
				} else entry.y = round(node.y);
				entry.responsive = cfg;
			} else {
				if (sourceResponsive === false) entry.responsive = false;
				entry.x = round(node.x);
				entry.y = round(node.y);
			}
			entry.scaleX = round(nextScaleX, 6);
			entry.scaleY = round(nextScaleY, 6);
			delete entry.width;
			delete entry.height;
			post('reparentPrepared', { reqId, ok: true, entry });
		} catch (error) {
			post('reparentPrepared', { reqId, ok: false, error: String((error as Error)?.message ?? error) });
		} finally {
			if (oldParent && !oldParent.destroyed) {
				if (oldIndex >= 0 && oldParent.addChildAt) oldParent.addChildAt(node, Math.min(oldIndex, oldParent.children?.length ?? oldIndex));
				else oldParent.addChild(node);
			} else if (node.parent) node.parent.removeChild(node);
			node.x = oldState.x;
			node.y = oldState.y;
			node.scale?.set?.(oldState.scaleX, oldState.scaleY);
			if (node.scale && !node.scale.set) {
				node.scale.x = oldState.scaleX;
				node.scale.y = oldState.scaleY;
			}
		}
	};

	const overrideSnapshot = (id: string, profile?: LayoutProfileName): Record<string, unknown> => {
		const data = getLayoutOverridesData().profiles[profile ?? activeProfile()]?.[id];
		return data ? JSON.parse(JSON.stringify(data)) : {};
	};

	const snapTargets = () => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		const xs: number[] = [0, w / 2, w];
		const ys: number[] = [0, h / 2, h];
		if (guides.safeArea.enabled) {
			xs.push((w * guides.safeArea.left) / 100, w - (w * guides.safeArea.right) / 100);
			ys.push((h * guides.safeArea.top) / 100, h - (h * guides.safeArea.bottom) / 100);
		}
		if (!gesture) return { xs, ys };
		for (const node of getRegisteredLayoutNodes()) {
			if (!canEditLayoutNode(node) || node === gesture.node || !isWorldVisible(node)) continue;
			if (gesture.node && isAncestorOf(gesture.node, node)) continue;
			const rect = nodeBounds(node);
			if (!rect || rect.width < 4 || rect.height < 4) continue;
			if (rect.width > w * 1.2 || rect.height > h * 1.2) continue;
			xs.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width);
			ys.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height);
		}
		return { xs, ys };
	};

	const isAncestorOf = (ancestor: AnyNode, node: AnyNode) => {
		let current = node.parent;
		while (current) {
			if (current === ancestor) return true;
			current = current.parent;
		}
		return false;
	};

	const applySnap = (dx: number, dy: number): { dx: number; dy: number } => {
		if (!guides.snap || !gesture) return { dx, dy };
		const rect = gesture.startBounds;
		const moved = { x: rect.x + dx, y: rect.y + dy };
		const candidatesX = [moved.x, moved.x + rect.width / 2, moved.x + rect.width];
		const candidatesY = [moved.y, moved.y + rect.height / 2, moved.y + rect.height];
		const targets = snapTargets();
		const lines: { x: number[]; y: number[] } = { x: [], y: [] };
		let bestX: { dist: number; adjust: number; line: number } | null = null;
		let bestY: { dist: number; adjust: number; line: number } | null = null;
		for (const candidate of candidatesX) {
			for (const target of targets.xs) {
				const dist = Math.abs(candidate - target);
				if (dist <= SNAP_THRESHOLD && (!bestX || dist < bestX.dist)) {
					bestX = { dist, adjust: target - candidate, line: target };
				}
			}
		}
		for (const candidate of candidatesY) {
			for (const target of targets.ys) {
				const dist = Math.abs(candidate - target);
				if (dist <= SNAP_THRESHOLD && (!bestY || dist < bestY.dist)) {
					bestY = { dist, adjust: target - candidate, line: target };
				}
			}
		}
		if (guides.grid.enabled && guides.grid.size >= 4) {
			const size = guides.grid.size;
			const gridX = Math.round(moved.x / size) * size;
			const gridY = Math.round(moved.y / size) * size;
			if (Math.abs(gridX - moved.x) <= SNAP_THRESHOLD && !bestX) {
				bestX = { dist: 0, adjust: gridX - moved.x, line: gridX };
			}
			if (Math.abs(gridY - moved.y) <= SNAP_THRESHOLD && !bestY) {
				bestY = { dist: 0, adjust: gridY - moved.y, line: gridY };
			}
		}
		if (bestX) lines.x.push(bestX.line);
		if (bestY) lines.y.push(bestY.line);
		drawGuides(lines.x.length || lines.y.length ? lines : undefined);
		return { dx: dx + (bestX?.adjust ?? 0), dy: dy + (bestY?.adjust ?? 0) };
	};

	const selectNode = (node: AnyNode, notify = true) => {
		selectedNode = node;
		lastSentValues = '';
		if (notify) post('selected', { id: node ? ensureLayoutId(node) : null });
	};

	const startGesture = (
		kind: 'drag' | 'resize',
		event: PointerEvent,
		node: AnyNode,
		handle?: HandleName,
	) => {
		if (!canEditLayoutNode(node)) {
			log('Temporary runtime containers are read-only. Select a named child instead.');
			return;
		}
		const rect = nodeBounds(node);
		if (!rect) return;
		const id = ensureLayoutId(node);
		const gestureProfile = activeProfile();
		if (gestureProfile === 'base' && baseGeometryShadowed(id)) {
			log(`Base geometry for "${id}" is hidden by the active profile. Use Base in that profile before dragging or resizing.`);
			return;
		}
		const allData = getLayoutOverridesData();
		const ownResponsive = allData.profiles[gestureProfile]?.[id]?.responsive;
		const baseResponsive = allData.profiles.base?.[id]?.responsive;
		const scopedResponsive = gestureProfile === 'base'
			? baseResponsive
			: ownResponsive !== undefined ? ownResponsive : baseResponsive;
		const resp = scopedResponsive && typeof scopedResponsive === 'object' ? scopedResponsive : undefined;
		const active = responsiveEnabled(resp) ? resp : undefined;
		const fixedSpineSize = node.skeleton ? getLayoutDisplaySize(node) : null;
		gesture = {
			kind,
			profile: gestureProfile,
			pointerId: event.pointerId,
			node,
			id,
			handle,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startLocalX: node.x,
			startLocalY: node.y,
			startBounds: rect,
			startWidth: node.skeleton ? (fixedSpineSize?.width ?? rect.width) : (node.width ?? rect.width),
			startHeight: node.skeleton ? (fixedSpineSize?.height ?? rect.height) : (node.height ?? rect.height),
			startScaleX: node.scale?.x ?? 1,
			startScaleY: node.scale?.y ?? 1,
			// Containers/graphics/spine scale; sprites and text resize via width/height.
			useScale: !(node.anchor && (node.texture || isTextLike(node))),
			before: overrideSnapshot(id, gestureProfile),
			moved: false,
			resp: active,
			startBoxLocal: active ? currentBoxLocal(node) : undefined,
			startRef: active ? getReferenceRect(node, active) : undefined,
			startScaleBase: active?.scaleBase ? { ...active.scaleBase } : undefined,
		};
	};

	const finishGesture = () => {
		if (!gesture) return;
		drawGuides();
		if (gesture.moved) {
			post('commit', {
				scope: gesture.profile,
				id: gesture.id,
				before: gesture.before,
				after: overrideSnapshot(gesture.id, gesture.profile),
				label: gesture.kind,
			});
		}
		gesture = null;
	};

	shield.addEventListener('pointerdown', (event) => {
		if (mode !== 'edit') return;
		event.preventDefault();
		event.stopPropagation();
		const candidates = pickCandidates(event.clientX, event.clientY);
		if (!candidates.length) {
			selectNode(null);
			return;
		}
		const ids = candidates.map((node) => ensureLayoutId(node));
		const samePoint =
			Math.abs(event.clientX - lastPick.x) < 6 &&
			Math.abs(event.clientY - lastPick.y) < 6 &&
			JSON.stringify(ids) === JSON.stringify(lastPick.ids);
		let index = 0;
		if (event.altKey || (samePoint && selectedNode && candidates.includes(selectedNode))) {
			index = (lastPick.index + 1) % candidates.length;
		} else if (selectedNode && candidates.includes(selectedNode)) {
			index = candidates.indexOf(selectedNode);
		}
		lastPick = { x: event.clientX, y: event.clientY, index, ids };
		const node = candidates[index];
		if (node !== selectedNode) selectNode(node);
		try {
			shield.setPointerCapture(event.pointerId);
		} catch {
			// synthetic events have no active pointer; window-level move/up still works
		}
		startGesture('drag', event, node);
	});

	for (const [handleName, el] of handleEls) {
		el.addEventListener('pointerdown', (event) => {
			if (mode !== 'edit' || !selectedNode) return;
			event.preventDefault();
			event.stopPropagation();
			try {
				el.setPointerCapture(event.pointerId);
			} catch {
				// synthetic events have no active pointer
			}
			startGesture('resize', event, selectedNode, handleName);
		});
	}

	const onPointerMove = (event: PointerEvent) => {
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		event.preventDefault();
		event.stopPropagation();
		const rawDx = event.clientX - gesture.startClientX;
		const rawDy = event.clientY - gesture.startClientY;
		if (!gesture.moved && Math.abs(rawDx) < 3 && Math.abs(rawDy) < 3) return;
		gesture.moved = true;

		if (gesture.kind === 'drag') {
			const { dx, dy } = applySnap(rawDx, rawDy);
			const local = parentInverseDelta(gesture.node, dx, dy);
			const newX = gesture.startLocalX + local.x;
			const newY = gesture.startLocalY + local.y;

			// Responsive drag: update anchor offsets. A stretched axis translates by
			// moving both margins in opposite directions while preserving its size.
			if (gesture.resp && (
				gesture.resp.x || gesture.resp.y || gesture.resp.stretchX || gesture.resp.stretchY
			)) {
				const cfg: ResponsiveConfig = JSON.parse(JSON.stringify(gesture.resp));
				const ref = getReferenceRect(gesture.node, cfg);
				const localProps: AnyNode = {};
				if (cfg.x && !cfg.stretchX) {
					cfg.x = {
						anchor: cfg.x.anchor,
						offset: round(localLengthToResponsive(
							gesture.node, cfg, ref, 'x',
							newX - getResponsiveAxisBase(gesture.node, cfg, ref, 'x', cfg.x.anchor),
						)),
					};
				} else if (cfg.stretchX) {
					const delta = localLengthToResponsive(gesture.node, cfg, ref, 'x', local.x);
					cfg.stretchX = {
						m0: round(cfg.stretchX.m0 + delta),
						m1: round(cfg.stretchX.m1 - delta),
					};
				} else {
					localProps.x = round(newX);
				}
				if (cfg.y && !cfg.stretchY) {
					cfg.y = {
						anchor: cfg.y.anchor,
						offset: round(localLengthToResponsive(
							gesture.node, cfg, ref, 'y',
							newY - getResponsiveAxisBase(gesture.node, cfg, ref, 'y', cfg.y.anchor),
						)),
					};
				} else if (cfg.stretchY) {
					const delta = localLengthToResponsive(gesture.node, cfg, ref, 'y', local.y);
					cfg.stretchY = {
						m0: round(cfg.stretchY.m0 + delta),
						m1: round(cfg.stretchY.m1 - delta),
					};
				} else {
					localProps.y = round(newY);
				}
				setLayoutOverride(gesture.profile, gesture.id, { ...localProps, responsive: cfg });
				return;
			}

			setLayoutOverride(gesture.profile, gesture.id, {
				x: round(newX),
				y: round(newY),
			});
			return;
		}

		// Responsive resize: update stretch margins / anchored size, keep responsive.
		if (gesture.resp && gesture.startBoxLocal && gesture.startRef) {
			const handle = gesture.handle!;
			const localDelta = parentInverseDelta(gesture.node, rawDx, rawDy);
			const b = gesture.startBoxLocal;
			const ref = gesture.startRef;
			let left = b.left;
			let right = b.right;
			let top = b.top;
			let bottom = b.bottom;
			if (handle.includes('w')) left += localDelta.x;
			if (handle.includes('e')) right += localDelta.x;
			if (handle.includes('n')) top += localDelta.y;
			if (handle.includes('s')) bottom += localDelta.y;
			left = Math.min(left, right - 2);
			top = Math.min(top, bottom - 2);
			const cfg: ResponsiveConfig = JSON.parse(JSON.stringify(gesture.resp));
			const props: AnyNode = {};
			const scaled = !!cfg.scaleMode && cfg.scaleMode !== 'parent' && !cfg.aspect && !!cfg.scaleBase;
			// A responsive scale mode owns the element's scale, so a resize adjusts
			// its size base rather than writing a static scale/width that the runtime
			// would immediately recompute away.
			let growX = handle.match(/[we]/) ? (right - left) / (b.width || 1) : 1;
			let growY = handle.match(/[ns]/) ? (bottom - top) / (b.height || 1) : 1;
			const proportionalCorner = handle.length === 2 && !cfg.stretchX && !cfg.stretchY;
			if ((scaled || proportionalCorner) && handle.length === 2) {
				const factor = Math.max(growX, growY);
				growX = factor;
				growY = factor;
				if (handle.includes('w')) left = b.right - b.width * factor;
				else right = b.left + b.width * factor;
				if (handle.includes('n')) top = b.bottom - b.height * factor;
				else bottom = b.top + b.height * factor;
			}
			// Directly resizing a contain/cover element intentionally converts its
			// size back to a custom local size; fit/cover otherwise fully owns it.
			if (cfg.aspect) {
				// Aspect suppressed both authored dimensions/scales. Materialise both
				// before an edge handle overwrites only one, otherwise the untouched
				// stale value resurfaces and distorts the element.
				if (gesture.useScale) {
					props.scaleX = round(gesture.startScaleX, 4);
					props.scaleY = round(gesture.startScaleY, 4);
				} else {
					props.width = round(gesture.startWidth);
					props.height = round(gesture.startHeight);
				}
				delete cfg.aspect;
				if (cfg.x) {
					cfg.x.offset = round(localLengthToResponsive(
						gesture.node, cfg, ref, 'x',
						gesture.startLocalX - getResponsiveAxisBase(gesture.node, cfg, ref, 'x', cfg.x.anchor),
					));
				}
				if (cfg.y) {
					cfg.y.offset = round(localLengthToResponsive(
						gesture.node, cfg, ref, 'y',
						gesture.startLocalY - getResponsiveAxisBase(gesture.node, cfg, ref, 'y', cfg.y.anchor),
					));
				}
				delete cfg.aspectSign;
			}

			// horizontal
			if (cfg.stretchX && handle.match(/[we]/)) {
				cfg.stretchX = {
					m0: round(localLengthToResponsive(gesture.node, cfg, ref, 'x', left - ref.x)),
					m1: round(localLengthToResponsive(gesture.node, cfg, ref, 'x', ref.x + ref.width - right)),
				};
			} else if (!cfg.stretchX && handle.match(/[we]/) && !scaled) {
				if (gesture.useScale) {
					props.scaleX = round((gesture.startScaleX * (right - left)) / (b.width || 1), 4);
				} else {
					props.width = round(right - left);
				}
			}
			// vertical
			if (cfg.stretchY && handle.match(/[ns]/)) {
				cfg.stretchY = {
					m0: round(localLengthToResponsive(gesture.node, cfg, ref, 'y', top - ref.y)),
					m1: round(localLengthToResponsive(gesture.node, cfg, ref, 'y', ref.y + ref.height - bottom)),
				};
			} else if (!cfg.stretchY && handle.match(/[ns]/) && !scaled) {
				if (gesture.useScale) {
					props.scaleY = round((gesture.startScaleY * (bottom - top)) / (b.height || 1), 4);
				} else {
					props.height = round(bottom - top);
				}
			}
			if (scaled) {
				const startBase = gesture.startScaleBase ?? cfg.scaleBase!;
				cfg.scaleBase = {
					x: round(startBase.x * (cfg.stretchX ? 1 : growX), 6),
					y: round(startBase.y * (cfg.stretchY ? 1 : growY), 6),
				};
			}

			// Keep the handle-opposite visual edge stationary. This uses the origin's
			// ratio inside the transformed start box, so anchors and pivots are handled
			// consistently for the common non-rotated game nodes.
			if (!cfg.stretchX && handle.match(/[we]/)) {
				const newWidth = b.width * growX;
				const newLeft = handle.includes('w') ? b.right - newWidth : b.left;
				const originRatio = b.width ? (gesture.startLocalX - b.left) / b.width : 0;
				const nextX = newLeft + originRatio * newWidth;
				if (cfg.x) cfg.x.offset = round(cfg.x.offset + localLengthToResponsive(
					gesture.node, cfg, ref, 'x', nextX - gesture.startLocalX,
				));
				else props.x = round(nextX);
			}
			if (!cfg.stretchY && handle.match(/[ns]/)) {
				const newHeight = b.height * growY;
				const newTop = handle.includes('n') ? b.bottom - newHeight : b.top;
				const originRatio = b.height ? (gesture.startLocalY - b.top) / b.height : 0;
				const nextY = newTop + originRatio * newHeight;
				if (cfg.y) cfg.y.offset = round(cfg.y.offset + localLengthToResponsive(
					gesture.node, cfg, ref, 'y', nextY - gesture.startLocalY,
				));
				else props.y = round(nextY);
			}
			props.responsive = cfg as AnyNode;
			setLayoutOverride(gesture.profile, gesture.id, props);
			return;
		}

		// resize (fixed element)
		const handle = gesture.handle!;
		const start = gesture.startBounds;
		let left = start.x;
		let top = start.y;
		let right = start.x + start.width;
		let bottom = start.y + start.height;
		if (handle.includes('w')) left += rawDx;
		if (handle.includes('e')) right += rawDx;
		if (handle.includes('n')) top += rawDy;
		if (handle.includes('s')) bottom += rawDy;
		let newW = Math.max(2, right - left);
		let newH = Math.max(2, bottom - top);
		const corner = handle.length === 2;
		if (event.shiftKey || corner) {
			// keep aspect on corners (and always with shift)
			const factor = Math.max(newW / start.width, newH / start.height);
			newW = start.width * factor;
			newH = start.height * factor;
		}
		const factorX = newW / start.width;
		const factorY = newH / start.height;

		const props: Record<string, number> = {};
		if (gesture.useScale) {
			props.scaleX = round(gesture.startScaleX * factorX, 4);
			props.scaleY = round(gesture.startScaleY * factorY, 4);
		} else {
			props.width = round(gesture.startWidth * factorX);
			props.height = round(gesture.startHeight * factorY);
		}
		setLayoutOverride(gesture.profile, gesture.id, props);

		// Keep the fixed corner in place: measure the node after the size change and
		// compensate position by the drift of the anchor-opposite corner.
		const after = nodeBounds(gesture.node);
		if (after) {
			const fixedX = handle.includes('w') ? start.x + start.width : start.x;
			const fixedY = handle.includes('n') ? start.y + start.height : start.y;
			const nowFixedX = handle.includes('w') ? after.x + after.width : after.x;
			const nowFixedY = handle.includes('n') ? after.y + after.height : after.y;
			const driftLocal = parentInverseDelta(gesture.node, fixedX - nowFixedX, fixedY - nowFixedY);
			if (Math.abs(fixedX - nowFixedX) > 0.5 || Math.abs(fixedY - nowFixedY) > 0.5) {
				setLayoutOverride(gesture.profile, gesture.id, {
					x: round(gesture.node.x + driftLocal.x),
					y: round(gesture.node.y + driftLocal.y),
				});
			}
		}
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		event.preventDefault();
		event.stopPropagation();
		finishGesture();
	};

	window.addEventListener('pointermove', onPointerMove, true);
	window.addEventListener('pointerup', onPointerUp, true);
	window.addEventListener('pointercancel', onPointerUp, true);

	shield.addEventListener('pointermove', (event) => {
		if (mode !== 'edit' || gesture) return;
		hoverNode = pickCandidates(event.clientX, event.clientY)[0] ?? null;
	});

	// ------------------------------------------------------------------
	// Keyboard (edit mode): nudge selection, forward editor hotkeys, block game keys
	// ------------------------------------------------------------------
	const commitNudge = () => {
		if (!nudgeBefore || !nudgeId || !nudgeProfile) return;
		clearTimeout(nudgeCommitTimer);
		nudgeCommitTimer = undefined;
		post('commit', {
			scope: nudgeProfile,
			id: nudgeId,
			before: nudgeBefore,
			after: overrideSnapshot(nudgeId, nudgeProfile),
			label: 'nudge',
		});
		nudgeBefore = null;
		nudgeProfile = null;
		nudgeId = null;
	};

	window.addEventListener(
		'keydown',
		(event) => {
			if (mode !== 'edit') return;
			const ctrl = event.ctrlKey || event.metaKey;
			if (ctrl && ['z', 'y', 'Z', 'Y', 's', 'S'].includes(event.key)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				post('hotkey', { key: event.key.toLowerCase(), shift: event.shiftKey });
				return;
			}
			if (event.key === 'Escape') {
				event.stopImmediatePropagation();
				selectNode(null);
				return;
			}
			if (event.key === 'Delete' && selectedNode) {
				event.preventDefault();
				event.stopImmediatePropagation();
				post('hotkey', { key: 'delete' });
				return;
			}
			const arrows: Record<string, [number, number]> = {
				ArrowLeft: [-1, 0],
				ArrowRight: [1, 0],
				ArrowUp: [0, -1],
				ArrowDown: [0, 1],
			};
			if (arrows[event.key] && selectedNode) {
				event.preventDefault();
				event.stopImmediatePropagation();
				const id = ensureLayoutId(selectedNode);
				if (!canEditLayoutNode(selectedNode)) return;
				const requestedProfile = activeProfile();
				if (requestedProfile === 'base' && baseGeometryShadowed(id)) {
					log(`Base geometry for "${id}" is hidden by the active profile. Use Base in that profile before nudging.`);
					return;
				}
				if (nudgeBefore && (nudgeId !== id || nudgeProfile !== requestedProfile)) commitNudge();
				const profile = nudgeProfile ?? requestedProfile;
				if (!nudgeBefore) {
					nudgeProfile = profile;
					nudgeId = id;
					nudgeBefore = overrideSnapshot(id, profile);
				}
				const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
				const [dx, dy] = arrows[event.key];
				const responsive = responsiveAtScope(id, profile);
				if (responsiveEnabled(responsive) && (
					responsive.x || responsive.y || responsive.stretchX || responsive.stretchY
				)) {
					const cfg: ResponsiveConfig = JSON.parse(JSON.stringify(responsive));
					const patch: AnyNode = { responsive: cfg };
					const ref = getReferenceRect(selectedNode, cfg);
					const deltaX = localLengthToResponsive(selectedNode, cfg, ref, 'x', dx * step);
					const deltaY = localLengthToResponsive(selectedNode, cfg, ref, 'y', dy * step);
					if (cfg.x) cfg.x.offset = round(cfg.x.offset + deltaX);
					else if (cfg.stretchX) {
						cfg.stretchX.m0 = round(cfg.stretchX.m0 + deltaX);
						cfg.stretchX.m1 = round(cfg.stretchX.m1 - deltaX);
					} else if (dx) patch.x = round(selectedNode.x + dx * step);
					if (cfg.y) cfg.y.offset = round(cfg.y.offset + deltaY);
					else if (cfg.stretchY) {
						cfg.stretchY.m0 = round(cfg.stretchY.m0 + deltaY);
						cfg.stretchY.m1 = round(cfg.stretchY.m1 - deltaY);
					} else if (dy) patch.y = round(selectedNode.y + dy * step);
					setLayoutOverride(profile, id, patch);
				} else {
					setLayoutOverride(profile, id, {
						x: round(selectedNode.x + dx * step),
						y: round(selectedNode.y + dy * step),
					});
				}
				clearTimeout(nudgeCommitTimer);
				nudgeCommitTimer = setTimeout(commitNudge, 600);
				return;
			}
			// Block remaining keys from reaching the game while editing.
			if (!ctrl && event.key !== 'F12') {
				event.stopImmediatePropagation();
				if ([' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
			}
		},
		true,
	);
	window.addEventListener(
		'keyup',
		(event) => {
			if (mode === 'edit') event.stopImmediatePropagation();
		},
		true,
	);

	// ------------------------------------------------------------------
	// Messages from the editor
	// ------------------------------------------------------------------
	const setMode = (next: 'edit' | 'preview') => {
		mode = next;
		shield.style.pointerEvents = mode === 'edit' ? 'auto' : 'none';
		if (mode !== 'edit') {
			hoverNode = null;
			finishGesture();
		}
		drawGuides();
		renderBoundsAll();
		refreshSelectionVisuals();
	};

	const sendHello = () => {
		post('hello', {
			bridgeVersion: LAYOUT_EDITOR_BRIDGE_VERSION,
			bridgeRevision: LAYOUT_EDITOR_BRIDGE_REVISION,
			layoutType: getActiveLayoutType(),
			layoutTypeWired: isLayoutTypeWired(),
			spawnWired: getSpawnedRuntime().wired,
			gameLayoutWired: isGameLayoutWired(),
			width: window.innerWidth,
			height: window.innerHeight,
			gameEvents: Object.keys(getEditorGameHooks().gameEvents ?? {}),
			performanceWired: true,
			testBookRunnerWired: typeof getEditorGameHooks().gameEvents?.[TEST_BOOK_HOOK] === 'function',
			mode,
			scope,
		});
	};

	let latestViewportGeneration = 0;
	const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	const viewportStateKey = () => {
		const layout = getGameLayout();
		const screen = app()?.renderer?.screen;
		return JSON.stringify({
			width: window.innerWidth,
			height: window.innerHeight,
			layoutType: getActiveLayoutType(),
			layout: layout && {
				x: round(layout.x, 4),
				y: round(layout.y, 4),
				width: round(layout.width, 4),
				height: round(layout.height, 4),
				scale: round(layout.scale, 6),
			},
			renderer: screen && { width: round(screen.width, 4), height: round(screen.height, 4) },
		});
	};

	/**
	 * Synchronise the editor's iframe resize with Stake's reactive canvas layout,
	 * Pixi's resize-to-window renderer, and the responsive override solver. The
	 * acknowledgement is sent only after the same state is stable for two frames.
	 */
	const settleViewportResize = async (payload: AnyNode) => {
		const reqId = payload?.reqId;
		const generation = Number(payload?.generation) || 0;
		const expectedWidth = Number(payload?.width);
		const expectedHeight = Number(payload?.height);
		latestViewportGeneration = Math.max(latestViewportGeneration, generation);
		try {
			window.dispatchEvent(new Event('resize'));
			const renderer = app()?.renderer;
			if (renderer?.resize && (
				Math.abs((renderer.screen?.width ?? 0) - expectedWidth) > 1 ||
				Math.abs((renderer.screen?.height ?? 0) - expectedHeight) > 1
			)) renderer.resize(expectedWidth, expectedHeight);
			let previous = '';
			let stableFrames = 0;
			let settled = false;
			for (let frameIndex = 0; frameIndex < 18; frameIndex++) {
				if (generation !== latestViewportGeneration) {
					post('viewportReady', { reqId, generation, ok: false, superseded: true });
					return;
				}
				refreshViewportLayout();
				await nextFrame();
				const key = viewportStateKey();
				stableFrames = key === previous ? stableFrames + 1 : 0;
				previous = key;
				const dimensionsReady =
					Math.abs(window.innerWidth - expectedWidth) <= 1 &&
					Math.abs(window.innerHeight - expectedHeight) <= 1;
				const screen = app()?.renderer?.screen;
				const rendererReady = !screen || (
					Math.abs(screen.width - expectedWidth) <= 1 &&
					Math.abs(screen.height - expectedHeight) <= 1
				);
				const layout = getGameLayout();
				const expectedScale = layout
					? Math.min(expectedWidth / layout.width, expectedHeight / layout.height)
					: null;
				const gameLayoutReady = !isGameLayoutWired() || !!layout && (
					Math.abs(layout.x - expectedWidth * 0.5) <= 1 &&
					Math.abs(layout.y - expectedHeight * 0.5) <= 1 &&
					Math.abs(layout.scale - expectedScale!) <= 1e-4
				);
				if (dimensionsReady && rendererReady && gameLayoutReady && stableFrames >= 2) {
					settled = true;
					break;
				}
			}
			if (!settled) throw new Error('Stake layout or Pixi renderer did not settle on the requested viewport.');
			refreshViewportLayout();
			await nextFrame();
			lastSentValues = '';
			post('viewportReady', {
				reqId,
				generation,
				ok: true,
				layoutType: getActiveLayoutType(),
				width: window.innerWidth,
				height: window.innerHeight,
			});
		} catch (error) {
			post('viewportReady', {
				reqId,
				generation,
				ok: false,
				error: String((error as Error)?.message ?? error),
			});
		}
	};

	// ------------------------------------------------------------------
	// Asset browser support (editor-created elements + authored Sprite overrides)
	// ------------------------------------------------------------------
	const listAssets = () => {
		const runtime = getSpawnedRuntime();
		if (!runtime.wired || !runtime.getLoadedAssets) return { wired: false, assets: [] };
		const assets: {
			key: string;
			type: string;
			width?: number;
			height?: number;
			animations?: string[];
		}[] = [];
		for (const [key, value] of Object.entries(loadedAssetCatalog())) {
			const v = value as AnyNode;
			if (v && v.source && typeof v.width === 'number' && typeof v.height === 'number') {
				// PIXI.Texture (includes atlas frames — they are flattened into keys)
				assets.push({ key, type: 'texture', width: Math.round(v.width), height: Math.round(v.height) });
			} else if (Array.isArray(v)) {
				assets.push({ key, type: 'spriteSheet' });
			} else if (v && v.bones && v.slots) {
				assets.push({
					key,
					type: 'spine',
					...(Number.isFinite(v.width) ? { width: Math.round(v.width) } : {}),
					...(Number.isFinite(v.height) ? { height: Math.round(v.height) } : {}),
					animations: (v.animations ?? [])
						.map((animation: AnyNode) => animation?.name)
						.filter((name: unknown): name is string => typeof name === 'string' && !!name),
				});
			}
		}
		assets.sort((a, b) => a.key.localeCompare(b.key));
		return { wired: true, assets };
	};

	const previewCache = new Map<string, string>();
	const assetPreviews = async (keys: string[]) => {
		const runtime = getSpawnedRuntime();
		const previews: Record<string, string> = {};
		if (!runtime.wired || !runtime.getLoadedAssets) return previews;
		const renderer = app()?.renderer;
		if (!renderer?.extract) return previews;
		const { Sprite } = await import('pixi.js');
		for (const key of keys ?? []) {
			if (previewCache.has(key)) {
				previews[key] = previewCache.get(key)!;
				continue;
			}
			let display: AnyNode = null;
			try {
				const asset = runtime.getLoadedAssets()?.[key] as AnyNode;
				if (asset?.source) {
					display = new Sprite(asset);
				} else if (asset?.bones && asset?.slots) {
					display = new SPINE_PIXI.Spine(asset as SPINE_PIXI.SkeletonData);
					const animationName =
						(asset.animations ?? []).find(
							(animation: AnyNode) => animation?.name?.toLowerCase() === 'idle',
						)?.name ?? asset.animations?.[0]?.name;
					if (animationName) display.state.setAnimation(0, animationName, true);
					display.update?.(0);
				} else {
					continue;
				}
				const bounds = display.getLocalBounds?.();
				const width = Math.abs(bounds?.width || display.width || 64);
				const height = Math.abs(bounds?.height || display.height || 64);
				const scale = Math.min(64 / width, 64 / height, 1);
				display.scale.set(scale);
				const dataUrl = await renderer.extract.base64(display);
				previewCache.set(key, dataUrl);
				previews[key] = dataUrl;
			} catch {
				// skip unpreviewable assets
			} finally {
				display?.destroy?.();
			}
		}
		return previews;
	};

	// ------------------------------------------------------------------
	// Exact testcase books
	// ------------------------------------------------------------------
	const TEST_BOOK_HOOK = '__layoutEditorStartTestBook';
	let cancelPendingTestBook: (() => void) | null = null;

	window.addEventListener('message', (event) => {
		if (event.source !== window.parent) return;
		const message = event.data;
		if (!message || message[MSG] !== true) return;
		const { type, payload } = message;
		if (message.navigationSession !== navigationSession) return;
		switch (type) {
			case 'ping':
				sendHello();
				break;
			case 'init':
				if (payload.profiles) replaceLayoutOverrides(payload.profiles, payload.elements);
				if (payload.guides) guides = { ...guides, ...payload.guides };
				if (payload.scope) scope = payload.scope;
				performanceSampler.setEnabled(!!payload.performanceMonitor);
				setMode(payload.mode ?? mode);
				if (payload.selectedId !== undefined) selectNode(nodeById(payload.selectedId), false);
				sendTree();
				break;
			case 'overrides':
				replaceLayoutOverrides(payload.profiles ?? {}, payload.elements);
				lastSentValues = '';
				queueTree();
				break;
			case 'listAssets':
				post('assets', { reqId: payload?.reqId, ...listAssets() });
				break;
			case 'assetPreviews':
				assetPreviews(payload?.keys ?? []).then((previews) =>
					post('assetPreviewsResult', { reqId: payload?.reqId, previews }),
				);
				break;
			case 'mode':
				setMode(payload.mode);
				break;
			case 'scope':
				scope = payload.scope;
				lastSentValues = '';
				break;
			case 'guides':
				guides = { ...guides, ...payload };
				drawGuides();
				renderBoundsAll();
				break;
			case 'select':
				selectNode(nodeById(payload.id), false);
				break;
			case 'hover':
				hoverNode = nodeById(payload.id);
				break;
			case 'requestTree':
				sendTree();
				break;
			case 'requestValues':
				lastSentValues = '';
				break;
			case 'viewportResize':
				void settleViewportResize(payload);
				break;
			case 'flushEdits':
				commitNudge();
				post('editsFlushed', { reqId: payload?.reqId, ok: true });
				break;
			case 'performanceMonitor':
				performanceSampler.setEnabled(!!payload?.enabled);
				break;
			case 'startTestBook': {
				const reqId = payload?.reqId;
				void Promise.resolve().then(async () => {
					let armed: ReturnType<typeof armTestBookRequest> | null = null;
					try {
						const hook = getEditorGameHooks().gameEvents?.[TEST_BOOK_HOOK];
						if (!hook) throw new Error('This game has not registered the testcase round-start hook.');
						const testBook = validateTestBookRequest(payload);
						cancelPendingTestBook?.();
						armed = armTestBookRequest(testBook, {
							target: window,
							onRestore: () => {
								if (armed && cancelPendingTestBook === armed.cancel) cancelPendingTestBook = null;
							},
						});
						cancelPendingTestBook = armed.cancel;
						const result = await hook({ mode: testBook.mode, bookId: testBook.bookId });
						if ((result as AnyNode)?.ok === false) {
							throw new Error(String((result as AnyNode).error ?? 'The game refused to start this testcase.'));
						}
						await armed.consumed;
						post('testBookStarted', { reqId, ok: true, mode: testBook.mode, bookId: testBook.bookId });
					} catch (error) {
						armed?.cancel();
						post('testBookStarted', { reqId, ok: false, error: String((error as AnyNode)?.message ?? error) });
					}
				});
				break;
			}
			case 'prepareReparent':
				prepareReparent(payload);
				break;
			case 'emitGameEvent': {
				const hook = getEditorGameHooks().gameEvents?.[payload.name];
				if (hook) {
					void Promise.resolve()
						.then(() => hook(payload?.data))
						.catch((error) => log(`gameEvent "${payload.name}" failed: ${error}`));
				}
				break;
			}
			case 'sampleText':
				setSampleText(payload.id, payload.text ?? null);
				lastSentValues = '';
				break;
			case 'responsive':
				if (!canEditLayoutNode(nodeById(payload.id))) break;
				applyResponsiveOp(payload.id, payload.scope ?? activeProfile(), payload);
				lastSentValues = '';
				break;
			case 'align': {
				// Align the element's bounds within the screen; committed like a drag.
				const node = nodeById(payload.id);
				if (!canEditLayoutNode(node)) break;
				const rect = node ? nodeBounds(node) : null;
				if (!node || !rect) break;
				const id = ensureLayoutId(node);
				const scopeProfile: LayoutProfileName = payload.scope ?? activeProfile();
				if (scopeProfile === 'base' && baseGeometryShadowed(id)) {
					log(`Base geometry for "${id}" is hidden by the active profile. Use Base in that profile before aligning.`);
					break;
				}
				const before = overrideSnapshot(id, scopeProfile);
				let dx = 0;
				let dy = 0;
				if (payload.h === 'left') dx = -rect.x;
				if (payload.h === 'center') dx = (window.innerWidth - rect.width) / 2 - rect.x;
				if (payload.h === 'right') dx = window.innerWidth - rect.width - rect.x;
				if (payload.v === 'top') dy = -rect.y;
				if (payload.v === 'middle') dy = (window.innerHeight - rect.height) / 2 - rect.y;
				if (payload.v === 'bottom') dy = window.innerHeight - rect.height - rect.y;
				const local = parentInverseDelta(node, dx, dy);
				const responsive = responsiveAtScope(id, scopeProfile);
				if (responsiveEnabled(responsive) && (
					responsive.x || responsive.y || responsive.stretchX || responsive.stretchY
				)) {
					const cfg: ResponsiveConfig = JSON.parse(JSON.stringify(responsive));
					const props: AnyNode = { responsive: cfg };
					const ref = getReferenceRect(node, cfg);
					if (payload.h && cfg.x) {
						const anchor = payload.h === 'right' ? 1 : payload.h === 'center' ? 0.5 : 0;
						cfg.x = {
							anchor,
							offset: round(localLengthToResponsive(
								node, cfg, ref, 'x',
								node.x + local.x - getResponsiveAxisBase(node, cfg, ref, 'x', anchor),
							)),
						};
					} else if (payload.h && cfg.stretchX) {
						const delta = localLengthToResponsive(node, cfg, ref, 'x', local.x);
						cfg.stretchX.m0 = round(cfg.stretchX.m0 + delta);
						cfg.stretchX.m1 = round(cfg.stretchX.m1 - delta);
					} else if (payload.h) props.x = round(node.x + local.x);
					if (payload.v && cfg.y) {
						const anchor = payload.v === 'bottom' ? 1 : payload.v === 'middle' ? 0.5 : 0;
						cfg.y = {
							anchor,
							offset: round(localLengthToResponsive(
								node, cfg, ref, 'y',
								node.y + local.y - getResponsiveAxisBase(node, cfg, ref, 'y', anchor),
							)),
						};
					} else if (payload.v && cfg.stretchY) {
						const delta = localLengthToResponsive(node, cfg, ref, 'y', local.y);
						cfg.stretchY.m0 = round(cfg.stretchY.m0 + delta);
						cfg.stretchY.m1 = round(cfg.stretchY.m1 - delta);
					} else if (payload.v) props.y = round(node.y + local.y);
					setLayoutOverride(scopeProfile, id, props);
				} else {
					setLayoutOverride(scopeProfile, id, {
						x: round(node.x + local.x),
						y: round(node.y + local.y),
					});
				}
				post('commit', {
					scope: scopeProfile,
					id,
					before,
					after: overrideSnapshot(id, scopeProfile),
					label: 'align',
				});
				break;
			}
		}
	});

	(window as AnyNode).__SLE_BRIDGE__ = {
		version: LAYOUT_EDITOR_BRIDGE_VERSION,
		get mode() {
			return mode;
		},
		performanceSampler,
		selectById: (id: string) => selectNode(nodeById(id)),
		tree: buildTree,
	};

	sendHello();
	log('editor bridge initialised');
}
