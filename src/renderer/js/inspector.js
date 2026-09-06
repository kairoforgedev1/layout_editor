/** Right panel: properties of the selected element. */
import { state, on, toast } from './state.js';
import { bridgeSend, EXPECTED_BRIDGE_VERSION } from './bridge.js';
import {
	activeScopeProfile,
	getEntry,
	setProp,
	applyPatches,
	resetElement,
	revertElement,
	copyElement,
	getSpawnedDef,
	updateSpawnedDef,
	reparentSpawnedElement,
	reparentProfileRisk,
	renameSpawnedElement,
	duplicateSpawnedElement,
	removalState,
	canPersistLayoutTarget,
	isUnsafeLayoutParent,
	PROFILES,
} from './overrides.js';
import {
	fetchAssets,
	getAssetPreview,
	pickAsset,
	preferredSpineAnimation,
	showAddElementDialog,
} from './addElement.js';
import { showRemoveDialog, restoreElementUi } from './removal.js';
import {
	responsiveActive,
	setAxisMode,
	setReference,
	clearResponsive,
	inheritResponsive,
	fillFrame,
	setResponsiveNumber,
	setSizeMode,
	setScaleBase,
	sizeModeOf,
	referenceOf,
	axisModeOf,
	SIZE_MODES,
} from './responsive.js';
import { confirmDialog } from './dialogs.js';
import {
	buildParentOptions,
	parentHelpText,
	GLOBAL_STAGE_PARENT,
} from './elementParents.js';
import {
	editorDefinitionForNode,
	hasRuntimeIdentityConflict,
} from './elementOwnership.js';
import { isTemporaryLayoutContainer } from '../../shared/layoutIdentity.js';
import { setInspectorVisible } from './panels.js';
import { clearSelection } from './selection.js';

let inspEl;
// id whose full (editable) inspector DOM is currently mounted, so the live value
// stream can tell a real selection change from mere per-frame geometry updates.
let renderedInspectorId = null;
let linkedScale = true;
const SAMPLES = {
	Short: '9.99',
	Medium: '12,345.67',
	Long: '1,234,567.89 USD',
	Max: '999,999,999,999.99',
};

const valueSource = (id, key) => {
	const profile = state.preview.layoutType ?? 'desktop';
	if (getEntry(state.overrides.working, profile, id)?.[key] !== undefined) return 'profile';
	if (getEntry(state.overrides.working, 'base', id)?.[key] !== undefined) return 'base';
	return 'default';
};

function numberRow({ label, key, value, id, step = 1, decimals = 2, extra, disabled = false, disabledTitle = '' }) {
	const row = document.createElement('div');
	row.className = 'prop-row';

	const src = document.createElement('span');
	const source = valueSource(id, key);
	src.className = `src ${source}`;
	src.textContent = source === 'profile' ? 'P' : source === 'base' ? 'B' : '·';
	src.title =
		source === 'profile'
			? `Overridden in "${state.preview.layoutType}" profile`
			: source === 'base'
				? 'Overridden in base layout'
				: 'Authored default value';
	row.appendChild(src);

	const labelEl = document.createElement('label');
	labelEl.textContent = label;
	row.appendChild(labelEl);

	const input = document.createElement('input');
	input.type = 'number';
	input.step = String(step);
	input.value = value === undefined || value === null ? '' : Number(value).toFixed(decimals).replace(/\.?0+$/, '');
	input.dataset.propKey = key;
	input.disabled = disabled;
	if (disabledTitle) input.title = disabledTitle;
	input.addEventListener('change', () => {
		const num = Number(input.value);
		if (!Number.isFinite(num)) return;
		if (key === 'scaleX' && linkedScale) {
			const profile = activeScopeProfile();
			const entry = { ...(getEntry(state.overrides.working, profile, id) ?? {}), scaleX: num, scaleY: num };
			applyPatches([{ profile, id, entry }], { label: 'set scale' });
			return;
		}
		setProp(activeScopeProfile(), id, key, num);
	});
	row.appendChild(input);

	if (extra) row.appendChild(extra);

	const reset = document.createElement('button');
	reset.className = 'reset-prop';
	reset.textContent = '×';
	reset.title = `Remove the "${key}" override from the current edit target`;
	reset.disabled = disabled;
	reset.addEventListener('click', () => setProp(activeScopeProfile(), id, key, null));
	row.appendChild(reset);

	return row;
}

function section(title) {
	const wrap = document.createElement('div');
	wrap.className = 'insp-section';
	const h = document.createElement('h4');
	h.textContent = title;
	wrap.appendChild(h);
	return wrap;
}

const assetBridgeReady = () =>
	state.preview.connected &&
	state.preview.spawnWired &&
	(state.preview.bridgeVersion ?? 0) >= EXPECTED_BRIDGE_VERSION;

const refreshAssetUi = () => {
	bridgeSend('requestTree');
	bridgeSend('requestValues');
};

const editorDefForTreeNode = (node) => {
	if (!node?.spawned) return null;
	return getSpawnedDef(node.definitionId ?? node.id) ?? null;
};

const assetKeyForProfile = (id, profile, authoredAssetKey = null) => {
	const baseKey = getEntry(state.overrides.working, 'base', id)?.assetKey;
	if (profile === 'base') return baseKey ?? authoredAssetKey ?? null;
	const profileKey = getEntry(state.overrides.working, profile, id)?.assetKey;
	return profileKey ?? baseKey ?? authoredAssetKey ?? null;
};

const editTargetAssetKey = (id, authoredAssetKey = null, spawnedDef = null) =>
	spawnedDef
		? (spawnedDef.assetKey ?? null)
		: assetKeyForProfile(id, activeScopeProfile(), authoredAssetKey);

async function replaceSpriteAsset({
	id,
	name = id,
	currentKey = null,
	authoredAssetKey = null,
	spawnedDef = null,
}) {
	if (!state.preview.connected) {
		toast('Start the game preview before choosing an image asset.', 'error', 6000);
		return;
	}
	if (!state.preview.spawnWired) {
		toast('Asset access is not wired in this game. Run Setup → Integration status.', 'error', 7000);
		return;
	}
	if (!spawnedDef && (state.preview.bridgeVersion ?? 0) < EXPECTED_BRIDGE_VERSION) {
		toast(
			`Game bridge v${state.preview.bridgeVersion ?? 1} cannot replace authored Sprite assets. ` +
			`Update it to v${EXPECTED_BRIDGE_VERSION} from Setup → Integration status.`,
			'error',
			8000,
		);
		return;
	}

	// A scope or definition can change through undo/redo while the modal is open.
	// Keep the original edit target, but compare the accepted choice to its live
	// value so a formerly-current asset can still be deliberately reapplied.
	const targetProfile = spawnedDef ? null : activeScopeProfile();
	const spawnedDefinitionId = spawnedDef?.id ?? null;
	const asset = await pickAsset('texture', {
		currentKey,
		title: `Replace image — ${name}`,
		acceptLabel: 'Replace image',
	});
	if (!asset) return;
	const liveSpawnedDef = spawnedDefinitionId ? getSpawnedDef(spawnedDefinitionId) : null;
	if (spawnedDefinitionId && liveSpawnedDef?.kind !== 'sprite') {
		toast(`Cannot replace “${name}” because that editor Sprite no longer exists.`, 'error', 6000);
		return;
	}
	const liveTreeNode = state.tree.find((node) => node.id === id);
	const liveCurrentKey = liveSpawnedDef
		? liveSpawnedDef.assetKey ?? null
		: assetKeyForProfile(
			id,
			targetProfile,
			liveTreeNode?.authoredAssetKey ?? authoredAssetKey,
		);
	if (asset.key === liveCurrentKey) return;

	const treeNode = liveTreeNode;
	if (treeNode?.identityConflict) {
		toast(`Cannot replace "${name}" until its duplicate element id is resolved.`, 'error', 7000);
		return;
	}
	if (treeNode) {
		treeNode.assetKey = asset.key;
		treeNode.assetAvailable = true;
	}
	if (liveSpawnedDef) {
		updateSpawnedDef(liveSpawnedDef.id, { assetKey: asset.key }, 'replace asset');
	} else {
		setProp(targetProfile, id, 'assetKey', asset.key);
	}
	refreshAssetUi();
}

function resetSpriteAsset(id) {
	setProp(activeScopeProfile(), id, 'assetKey', null);
	refreshAssetUi();
}

function assetThumbnail(assetKey, { compact = false, onActivate = null } = {}) {
	const wrap = document.createElement(onActivate ? 'button' : 'div');
	if (onActivate) {
		wrap.type = 'button';
		wrap.title = assetKey ? `Choose a replacement for ${assetKey}` : 'Choose an image asset';
		wrap.setAttribute('aria-label', wrap.title);
		wrap.addEventListener('click', onActivate);
	}
	wrap.className = `asset-property-thumb${compact ? ' compact' : ''}`;
	const fallback = document.createElement('span');
	fallback.textContent = 'IMG';
	wrap.appendChild(fallback);
	const image = document.createElement('img');
	image.alt = '';
	wrap.appendChild(image);
	if (assetKey && state.preview.connected && state.preview.spawnWired) {
		getAssetPreview(assetKey)
			.then((url) => {
				if (!url || !image.isConnected) return;
				image.src = url;
				wrap.classList.add('loaded');
			})
			.catch(() => {});
	}
	return wrap;
}

function sourceBadge(id, key) {
	const source = valueSource(id, key);
	const badge = document.createElement('span');
	badge.className = `src ${source}`;
	badge.textContent = source === 'profile' ? 'P' : source === 'base' ? 'B' : '·';
	badge.title = source === 'profile'
		? `Replaced in the "${state.preview.layoutType}" profile`
		: source === 'base'
			? 'Replacement inherited from Base'
			: 'Game-authored image texture';
	return badge;
}

function spriteAssetSection({ id, name = id, assetKey, authoredAssetKey, assetAvailable, spawnedDef }) {
	const wrap = section('Image asset');
	const targetAssetKey = editTargetAssetKey(id, authoredAssetKey, spawnedDef);
	const choose = () => replaceSpriteAsset({
		id,
		name,
		currentKey: targetAssetKey,
		authoredAssetKey,
		spawnedDef,
	});
	const card = document.createElement('div');
	card.className = 'asset-property-card';
	card.appendChild(assetThumbnail(assetKey, { onActivate: choose }));

	const info = document.createElement('div');
	info.className = 'asset-property-info';
	const heading = document.createElement('div');
	heading.className = 'asset-property-heading';
	if (!spawnedDef) heading.appendChild(sourceBadge(id, 'assetKey'));
	const key = document.createElement('span');
	key.className = 'asset-property-key';
	key.textContent = assetKey || 'Source texture';
	key.title = assetKey || 'This source texture is not registered under a loadedAssets key.';
	heading.appendChild(key);
	info.appendChild(heading);

	const detail = document.createElement('div');
	detail.className = 'asset-property-detail';
	const assetSource = spawnedDef ? 'global' : valueSource(id, 'assetKey');
	if (!spawnedDef && state.scope === 'base' && assetSource === 'profile') {
		detail.classList.add('unavailable');
		detail.textContent =
			`Preview uses ${assetKey || 'the active profile image'}; ` +
			`you are editing Base${targetAssetKey ? ` (${targetAssetKey})` : ''}. ` +
			'Base appears when this profile inherits it.';
	} else if (!assetAvailable && assetKey) {
		detail.classList.add('unavailable');
		detail.textContent = spawnedDef
			? 'Unavailable — the current image stays unchanged until this asset loads'
			: authoredAssetKey
				? `Unavailable — showing source asset “${authoredAssetKey}”`
				: 'Unavailable — the game-authored texture is kept visible';
	} else if (spawnedDef) {
		detail.textContent = 'Editor element · shared by every layout';
	} else {
		detail.textContent = state.scope === 'base'
			? 'Change the shared Base image'
			: `Change only the ${state.preview.layoutType ?? 'active'} layout`;
	}
	info.appendChild(detail);

	const actions = document.createElement('div');
	actions.className = 'asset-property-actions';
	const change = document.createElement('button');
	change.type = 'button';
	change.textContent = 'Change…';
	change.disabled = !state.preview.connected || !state.preview.spawnWired ||
		(!spawnedDef && !assetBridgeReady());
	change.addEventListener('click', choose);
	actions.appendChild(change);
	if (!spawnedDef) {
		const reset = document.createElement('button');
		reset.type = 'button';
		reset.textContent = state.scope === 'base' ? 'Use source' : 'Use inherited';
		reset.title = 'Remove the asset override from the current edit target';
		reset.disabled = getEntry(state.overrides.working, activeScopeProfile(), id)?.assetKey === undefined;
		reset.addEventListener('click', () => resetSpriteAsset(id));
		actions.appendChild(reset);
	}
	info.appendChild(actions);
	card.appendChild(info);
	wrap.appendChild(card);

	if (!assetBridgeReady() && !spawnedDef) {
		const note = document.createElement('div');
		note.className = 'asset-property-note';
		note.textContent = state.preview.connected
			? `Update the project bridge to v${EXPECTED_BRIDGE_VERSION} to replace game-authored Sprite assets.`
			: 'Start the preview to browse the game’s available image assets.';
		wrap.appendChild(note);
	}
	return wrap;
}

function descendantSprites(parentId) {
	const children = new Map();
	for (const node of state.tree) {
		if (!node.parentId) continue;
		if (!children.has(node.parentId)) children.set(node.parentId, []);
		children.get(node.parentId).push(node);
	}
	const result = [];
	const queue = [...(children.get(parentId) ?? [])];
	const seen = new Set();
	while (queue.length) {
		const node = queue.shift();
		if (!node || seen.has(node.id)) continue;
		seen.add(node.id);
		if (node.type === 'sprite') result.push(node);
		queue.push(...(children.get(node.id) ?? []));
	}
	return result;
}

function containedSpriteSection(values) {
	const wrap = section(values.type === 'graphics' ? 'Sprite children' : 'Images in container');
	const sprites = descendantSprites(values.id);
	const intro = document.createElement('div');
	intro.className = 'asset-property-note';
	intro.textContent = values.type === 'graphics'
		? 'This Graphics object draws shapes and has no replaceable texture. Replace one of its Sprite children below.'
		: 'The container itself has no image texture. Replace any Sprite nested inside it:';
	wrap.appendChild(intro);
	if (!sprites.length) {
		const empty = document.createElement('div');
		empty.className = 'asset-contained-empty';
		empty.textContent =
			'No Sprite descendants are currently mounted. Select an existing Sprite, or use Add to create an image under an available parent.';
		wrap.appendChild(empty);
		return wrap;
	}

	const list = document.createElement('div');
	list.className = 'asset-contained-list';
	for (const node of sprites) {
		const spawnedDef = editorDefForTreeNode(node);
		const targetAssetKey = editTargetAssetKey(node.id, node.authoredAssetKey, spawnedDef);
		const row = document.createElement('div');
		row.className = 'asset-contained-row';
		row.appendChild(assetThumbnail(node.assetKey, { compact: true }));
		const labels = document.createElement('div');
		labels.className = 'asset-contained-labels';
		const nodeName = document.createElement('button');
		nodeName.type = 'button';
		nodeName.className = 'asset-contained-name';
		nodeName.textContent = node.name ?? node.id;
		nodeName.title = 'Select this Sprite';
		nodeName.addEventListener('click', () => bridgeSend('select', { id: node.id }));
		labels.appendChild(nodeName);
		const assetName = document.createElement('span');
		assetName.className = node.assetAvailable === false && node.assetKey
			? 'asset-contained-key unavailable'
			: 'asset-contained-key';
		const baseShadowed = !spawnedDef && state.scope === 'base' &&
			getEntry(state.overrides.working, state.preview.layoutType ?? 'desktop', node.id)?.assetKey !== undefined;
		assetName.textContent = baseShadowed
			? `Preview: ${node.assetKey || 'source'} · Base: ${targetAssetKey || 'source'}`
			: (node.assetKey || 'Source texture');
		assetName.title = node.assetKey || '';
		labels.appendChild(assetName);
		row.appendChild(labels);
		const change = document.createElement('button');
		change.type = 'button';
		change.textContent = 'Change…';
		change.disabled = !!node.identityConflict || !state.preview.spawnWired ||
			(!spawnedDef && !assetBridgeReady());
		change.addEventListener('click', () => replaceSpriteAsset({
			id: node.id,
			name: node.name ?? node.id,
			currentKey: targetAssetKey,
			authoredAssetKey: node.authoredAssetKey,
			spawnedDef,
		}));
		row.appendChild(change);
		if (!spawnedDef && getEntry(state.overrides.working, activeScopeProfile(), node.id)?.assetKey !== undefined) {
			const reset = document.createElement('button');
			reset.type = 'button';
			reset.className = 'reset-prop';
			reset.textContent = '×';
			reset.title = 'Use the inherited or game-authored image';
			reset.addEventListener('click', () => resetSpriteAsset(node.id));
			row.appendChild(reset);
		}
		list.appendChild(row);
	}
	wrap.appendChild(list);
	return wrap;
}

const SIZE_PHRASES_V2 = {
	parent: 'inherits its Pixi parent size normally',
	game: 'follows Stake game-content scale and design position',
	fixed: 'keeps the same on-screen pixel size',
	contain: 'fits inside the selected frame',
	cover: 'covers the selected frame',
};

const referenceLabel = (ref) =>
	ref === 'parent' ? 'parent layout frame' : ref === 'game' ? 'game frame' : 'viewport';

function responsiveRuleForInspector(values) {
	const targetSet = !!values.responsiveTargetSet;
	if (state.scope === 'base') return targetSet ? values.responsiveTarget : null;
	return targetSet ? values.responsiveTarget : values.responsive;
}

function responsiveSourceForInspector(values) {
	if (state.scope === 'base') {
		if (!values.responsiveTargetSet) return 'native';
		return values.responsiveTarget === false ? 'disabled' : 'base';
	}
	if (values.responsiveTargetSet) return values.responsiveTarget === false ? 'disabled' : 'profile';
	return values.responsiveSource ?? 'native';
}

function describeResponsiveV2(raw, cfg, ref) {
	if (raw === false) return 'Responsive behavior is disabled in this profile; native layout is used.';
	const parts = [];
	const describeAxis = (axis, start, end) => {
		const mode = axisModeOf(cfg, axis);
		if (mode === 'stretch') return `stretches ${axis === 'x' ? 'horizontally' : 'vertically'}`;
		if (mode === 'start') return `pinned to ${start}`;
		if (mode === 'center') return `centered ${axis === 'x' ? 'horizontally' : 'vertically'}`;
		if (mode === 'end') return `pinned to ${end}`;
		return null;
	};
	const x = describeAxis('x', 'left', 'right');
	const y = describeAxis('y', 'top', 'bottom');
	if (x) parts.push(x);
	if (y) parts.push(y);
	const mode = sizeModeOf(cfg);
	if (mode !== 'parent') parts.push(SIZE_PHRASES_V2[mode]);
	if (!parts.length) return `Native position and size. Choose an axis rule to adapt to the ${referenceLabel(ref)}.`;
	return `${parts.join(', ')} · relative to the ${referenceLabel(ref)}.`;
}

function responsiveSourceBadge(source) {
	const badge = document.createElement('span');
	badge.className = `src ${source === 'disabled' ? 'profile' : source}`;
	badge.textContent = source === 'profile' || source === 'disabled' ? 'P' : source === 'base' ? 'B' : '·';
	badge.title = source === 'profile'
		? 'Responsive rule from this profile'
		: source === 'base'
			? 'Responsive rule inherited from Base'
			: source === 'disabled'
				? 'Base responsive rule disabled in this profile'
				: 'Native authored layout';
	return badge;
}

function responsiveSection(values, id) {
	const raw = responsiveRuleForInspector(values);
	const cfg = raw && typeof raw === 'object' ? raw : {};
	const source = responsiveSourceForInspector(values);
	const defaultRef = values.gameLayoutWired ? 'game' : 'viewport';
	const ref = Object.keys(cfg).length ? referenceOf(cfg) : defaultRef;
	const active = responsiveActive(cfg);
	const baseShadowed = state.scope === 'base' && !!values.baseGeometryShadowed;
	const wrap = section('Responsive layout');

	const summary = document.createElement('div');
	summary.className = 'resp-summary';
	summary.appendChild(responsiveSourceBadge(source));
	const summaryText = document.createElement('span');
	summaryText.textContent = describeResponsiveV2(raw, cfg, ref);
	summary.appendChild(summaryText);
	wrap.appendChild(summary);

	if (baseShadowed) {
		const notice = document.createElement('div');
		notice.className = 'resp-notice';
		notice.textContent = `The preview also has a ${state.preview.layoutType} profile rule. Base edits may be hidden until that profile uses Base.`;
		wrap.appendChild(notice);
	}

	const refRow = document.createElement('div');
	refRow.className = 'prop-row resp-row';
	const refLabel = document.createElement('label');
	refLabel.textContent = 'Frame';
	refRow.appendChild(refLabel);
	const refSel = document.createElement('select');
	for (const [value, labelText] of [
		['viewport', 'Viewport'],
		['game', 'Game content'],
		['parent', 'Parent layout'],
	]) {
		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = labelText;
		if (value === 'game' && !values.gameLayoutWired) {
			opt.disabled = value !== ref;
			opt.title = 'Install/update the project bridge to expose the SDK game frame.';
		}
		if (ref === value) opt.selected = true;
		refSel.appendChild(opt);
	}
	refSel.title = 'The stable frame used for pins, offsets, margins, fit and cover';
	refSel.disabled = baseShadowed;
	if (baseShadowed) refSel.title = 'Use Base in the preview profile before changing geometry-preserving Base rules.';
	refSel.addEventListener('change', () => setReference(id, refSel.value));
	refRow.appendChild(refSel);
	wrap.appendChild(refRow);

	const subhead = document.createElement('div');
	subhead.className = 'resp-subhead';
	subhead.textContent = 'Position rules';
	subhead.title = 'Pins align the visible asset edge, including its anchor, pivot and responsive size.';
	wrap.appendChild(subhead);

	const axisOptions = (axis) => [
		['none', 'Use local position'],
		['start', axis === 'x' ? 'Pin left' : 'Pin top'],
		['center', axis === 'x' ? 'Center horizontally' : 'Center vertically'],
		['end', axis === 'x' ? 'Pin right' : 'Pin bottom'],
		['stretch', axis === 'x' ? 'Stretch width' : 'Stretch height'],
	];
	for (const [axis, labelText] of [['x', 'Horizontal'], ['y', 'Vertical']]) {
		const row = document.createElement('div');
		row.className = 'prop-row resp-row';
		const label = document.createElement('label');
		label.textContent = labelText;
		row.appendChild(label);
		const select = document.createElement('select');
		const mode = axisModeOf(cfg, axis);
		for (const [value, text] of axisOptions(axis)) {
			if (value === 'stretch' && values.isText && mode !== 'stretch') continue;
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = value === 'stretch' && values.isText ? `${text} (legacy)` : text;
			if (value === 'stretch' && values.isText) {
				opt.disabled = true;
				opt.title = 'Text stretch is retained for compatibility. Choose another rule to convert it.';
			}
			if (value === mode) opt.selected = true;
			select.appendChild(opt);
		}
		select.addEventListener('change', () => setAxisMode(id, axis, select.value, refSel.value));
		select.disabled = baseShadowed;
		select.title = 'Start, center and end rules align the visible bounds, not only the Pixi transform point.';
		if (baseShadowed) select.title = 'Use Base in the preview profile before changing this Base rule.';
		row.appendChild(select);
		wrap.appendChild(row);
	}

	if (!values.isText) {
		const actions = document.createElement('div');
		actions.className = 'resp-actions';
		const stretch = document.createElement('button');
		stretch.textContent = 'Stretch both (keep margins)';
		stretch.title = 'Stretch to all four current edges in one undoable change';
		stretch.disabled = baseShadowed;
		stretch.addEventListener('click', () => fillFrame(id, refSel.value, false));
		actions.appendChild(stretch);
		const fill = document.createElement('button');
		fill.textContent = 'Fill frame (zero margins)';
		fill.title = 'Stretch exactly to all four frame edges in one undoable change';
		fill.disabled = baseShadowed;
		fill.addEventListener('click', () => fillFrame(id, refSel.value, true));
		actions.appendChild(fill);
		wrap.appendChild(actions);
	}

	const addResponsiveNumber = (labelText, group, field, value) => {
		const row = document.createElement('div');
		row.className = 'prop-row resp-row';
		row.appendChild(responsiveSourceBadge(source));
		const label = document.createElement('label');
		label.textContent = labelText;
		row.appendChild(label);
		const input = document.createElement('input');
		input.type = 'number';
		input.step = '1';
		input.value = Math.round((value ?? 0) * 100) / 100;
		input.title = ref === 'game'
			? 'Stake game design units (the same coordinate space used inside MainContainer)'
			: ref === 'viewport'
				? 'Screen pixels, even when the element is inside a scaled container'
				: 'Units in the parent layout frame';
		input.addEventListener('change', () => {
			const next = Number(input.value);
			if (Number.isFinite(next)) setResponsiveNumber(id, group, field, next);
		});
		row.appendChild(input);
		wrap.appendChild(row);
	};
	if (cfg.stretchX) {
		addResponsiveNumber('Left', 'stretchX', 'm0', cfg.stretchX.m0);
		addResponsiveNumber('Right', 'stretchX', 'm1', cfg.stretchX.m1);
	} else if (cfg.x) {
		addResponsiveNumber('Offset X', 'x', 'offset', cfg.x.offset);
	}
	if (cfg.stretchY) {
		addResponsiveNumber('Top', 'stretchY', 'm0', cfg.stretchY.m0);
		addResponsiveNumber('Bottom', 'stretchY', 'm1', cfg.stretchY.m1);
	} else if (cfg.y) {
		addResponsiveNumber('Offset Y', 'y', 'offset', cfg.y.offset);
	}

	const sizeHead = document.createElement('div');
	sizeHead.className = 'resp-subhead';
	sizeHead.textContent = 'Size behavior';
	wrap.appendChild(sizeHead);
	const sizeRow = document.createElement('div');
	sizeRow.className = 'prop-row resp-row';
	const sizeLabel = document.createElement('label');
	sizeLabel.textContent = 'Size';
	sizeRow.appendChild(sizeLabel);
	const sizeSel = document.createElement('select');
	const sizeMode = sizeModeOf(cfg);
	const stretched = !!cfg.stretchX || !!cfg.stretchY;
	for (const option of SIZE_MODES) {
		if ((option.value === 'contain' || option.value === 'cover') && (values.container || values.isText)) continue;
		const opt = document.createElement('option');
		opt.value = option.value;
		opt.textContent = option.label;
		opt.title = option.hint;
		if (option.value === 'game' && values.gameScale == null) opt.disabled = option.value !== sizeMode;
		if (option.value === sizeMode) opt.selected = true;
		sizeSel.appendChild(opt);
	}
	sizeSel.disabled = stretched || baseShadowed;
	if (stretched) sizeSel.title = 'Stretch owns size on the stretched axis. Choose a pin/local rule first to use another size behavior.';
	else if (baseShadowed) sizeSel.title = 'Use Base in the preview profile before changing this Base size behavior.';
	sizeSel.addEventListener('change', () => setSizeMode(id, sizeSel.value, refSel.value));
	sizeRow.appendChild(sizeSel);
	wrap.appendChild(sizeRow);

	const sizeHint = document.createElement('div');
	sizeHint.className = 'resp-hint';
	if (stretched && values.container) {
		sizeHint.textContent = 'This container publishes its stretched logical frame, so responsive children can safely use Parent layout without feeding back into its bounds.';
	} else {
		sizeHint.textContent = SIZE_MODES.find((option) => option.value === sizeMode)?.hint ?? '';
	}
	wrap.appendChild(sizeHint);

	if (!stretched && sizeMode !== 'parent' && sizeMode !== 'contain' && sizeMode !== 'cover' && cfg.scaleBase) {
		const scaleRow = document.createElement('div');
		scaleRow.className = 'prop-row resp-row';
		scaleRow.appendChild(responsiveSourceBadge(source));
		const label = document.createElement('label');
		label.textContent = 'Base scale';
		scaleRow.appendChild(label);
		const scaleInput = document.createElement('input');
		scaleInput.type = 'number';
		scaleInput.step = '0.05';
		scaleInput.min = '0.001';
		scaleInput.value = Math.round(Math.abs(cfg.scaleBase.x) * 1000) / 1000;
		scaleInput.addEventListener('change', () => {
			const next = Number(scaleInput.value);
			if (Number.isFinite(next) && next > 0) setScaleBase(id, next);
		});
		scaleRow.appendChild(scaleInput);
		wrap.appendChild(scaleRow);
	}

	const footer = document.createElement('div');
	footer.className = 'resp-footer';
	if (state.scope !== 'base' && !values.responsiveTargetSet && active) {
		const inherited = document.createElement('span');
		inherited.className = 'dim';
		inherited.textContent = 'Inherited from Base';
		footer.appendChild(inherited);
	}
	if (state.scope !== 'base' && values.responsiveTargetSet) {
		const inherit = document.createElement('button');
		inherit.textContent = 'Use Base rule';
		inherit.title = 'Remove this profile rule and inherit Base again';
		inherit.addEventListener('click', () => inheritResponsive(id));
		footer.appendChild(inherit);
	}
	if (active) {
		const clear = document.createElement('button');
		const inheritedBase = state.scope !== 'base' && values.responsiveSource === 'base' && !values.responsiveTargetSet;
		clear.textContent = inheritedBase ? 'Disable in profile' : 'Convert to local/native';
		clear.title = inheritedBase
			? 'Keep the Base rule intact, but disable it for this profile'
			: 'Preserve current position and size, then remove responsive behavior from this edit target';
		clear.disabled = baseShadowed;
		clear.addEventListener('click', () => clearResponsive(id));
		footer.appendChild(clear);
	}
	if (footer.childNodes.length) wrap.appendChild(footer);

	return wrap;
}

/**
 * Handler for the live `values` stream. The game re-sends `values` every frame
 * while an element is selected (an animated element's effective x/y/bounds change
 * continuously), so this fires ~60×/sec. Doing a full renderInspector() on each of
 * those tears down and recreates every <input> and <select> — open dropdowns snap
 * shut, half-typed edits are discarded, and the panel lags badly.
 *
 * So a live update to the *already-shown* element only patches the numeric read-outs
 * in place and never rebuilds the DOM. Structural changes (a different element, an
 * override added/removed, a profile/scope/mode change) come through the
 * selection/overrides/preview/tree events, which still do a full renderInspector().
 */
function refreshInspectorLiveValues() {
	const values = state.values;
	if (
		!inspEl ||
		!values ||
		!state.selection ||
		values.id !== state.selection ||
		renderedInspectorId !== state.selection
	) {
		renderInspector();
		return;
	}
	// Same element already mounted → refresh live numbers only, and never touch the
	// control the user is currently interacting with (a focused field or open menu).
	const active = document.activeElement;
	for (const input of inspEl.querySelectorAll('input[data-prop-key]')) {
		if (input === active) continue;
		const val = values.effective?.[input.dataset.propKey];
		if (val !== undefined && val !== null) {
			input.value = Number(val).toFixed(2).replace(/\.?0+$/, '');
		}
	}
}

/** Deselect affordance, matching the close button on the docked panels. */
function appendInspectorClose(header) {
	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'insp-close';
	close.textContent = '✕';
	close.title = 'Deselect (Esc)';
	close.setAttribute('aria-label', 'Deselect the current element');
	close.addEventListener('click', clearSelection);
	header.appendChild(close);
}

/**
 * Render, then show the panel whenever something is selected.
 *
 * Visibility follows the selection, never the rendered content. An element whose
 * values have not arrived yet is still selected, and in Play mode the game never
 * sends values at all — keying off content collapsed the panel for the entire
 * time anything was selected in Play mode, which read as the panel being broken.
 */
export function renderInspector() {
	renderInspectorContent();
	setInspectorVisible(!!state.selection);
}

function renderInspectorContent() {
	if (!inspEl) return;
	const values = state.values;
	if (!state.selection || !values || values.id !== state.selection) {
		renderedInspectorId = null; // nothing editable is mounted for the selection
		const detachedDef = state.selection ? getSpawnedDef(state.selection) : null;
		const runtimePresent = state.selection
			? state.tree.some((node) => node.id === state.selection)
			: false;
		if (detachedDef && !runtimePresent) {
			const id = detachedDef.id;
			const status = removalState(id);
			inspEl.innerHTML = '';

			const header = document.createElement('div');
			header.className = 'insp-header';
			header.innerHTML = '<span class="el-name"></span><span class="el-type"></span>';
			header.querySelector('.el-name').textContent = id;
			header.querySelector('.el-type').textContent = `${detachedDef.kind} · saved editor element`;
			appendInspectorClose(header);
			inspEl.appendChild(header);

			const notice = document.createElement('div');
			notice.className = 'resp-notice';
			notice.textContent =
				'This element is saved in the project but is not mounted in the preview. Its name remains reserved until it is permanently deleted.';
			inspEl.appendChild(notice);

			const actions = document.createElement('div');
			actions.className = 'insp-actions';
			if (status.base || status.profiles.length) {
				const restore = document.createElement('button');
				restore.textContent = 'Restore in all layouts';
				restore.addEventListener('click', () => restoreElementUi(id, 'all'));
				actions.appendChild(restore);
			}
			const remove = document.createElement('button');
			remove.className = 'danger';
			remove.textContent = 'Delete permanently…';
			remove.addEventListener('click', () =>
				showRemoveDialog(id, {
					id,
					definitionId: id,
					spawned: true,
					persistedOnly: true,
				}),
			);
			actions.appendChild(remove);
			inspEl.appendChild(actions);
			return;
		}
		if (state.selection) {
			// Selected, but the game has not described it. In Play mode it never
			// will, so say which of the two situations this is rather than showing
			// a "select something" hint at someone who just did.
			inspEl.innerHTML = '';
			const header = document.createElement('div');
			header.className = 'insp-header';
			header.innerHTML = '<span class="el-name"></span>';
			header.querySelector('.el-name').textContent = state.selection;
			appendInspectorClose(header);
			inspEl.appendChild(header);

			const hint = document.createElement('div');
			hint.className = 'empty-hint';
			hint.textContent =
				state.mode === 'edit'
					? 'Waiting for the game preview to describe this element…'
					: 'Switch to Edit mode to see and change this element’s layout values.';
			inspEl.appendChild(hint);
			return;
		}
		inspEl.innerHTML = '<div class="empty-hint">Select an element in the preview or the list.</div>';
		return;
	}
	// don't rebuild under the user's cursor: keep an actively-edited field or an open
	// dropdown alive (a structural event can still land mid-interaction), just refresh
	// the other numeric read-outs in place.
	if (
		inspEl.contains(document.activeElement) &&
		(document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') &&
		renderedInspectorId === state.selection
	) {
		for (const input of inspEl.querySelectorAll('input[data-prop-key]')) {
			if (input === document.activeElement) continue;
			const key = input.dataset.propKey;
			const val = values.effective[key];
			if (val !== undefined && val !== null) input.value = Number(val).toFixed(2).replace(/\.?0+$/, '');
		}
		return;
	}

	const eff = values.effective;
	const id = values.id;
	const effectiveResponsive = values.responsive && typeof values.responsive === 'object'
		? values.responsive
		: {};
	const responsiveXOwned = !!effectiveResponsive.x || !!effectiveResponsive.stretchX;
	const responsiveYOwned = !!effectiveResponsive.y || !!effectiveResponsive.stretchY;
	const responsiveScaleOwned = !!effectiveResponsive.aspect ||
		(!!effectiveResponsive.scaleMode && effectiveResponsive.scaleMode !== 'parent');
	const responsiveWidthOwned = responsiveScaleOwned || !!effectiveResponsive.stretchX;
	const responsiveHeightOwned = responsiveScaleOwned || !!effectiveResponsive.stretchY;
	inspEl.innerHTML = '';

	const spawnedDef = editorDefinitionForNode(
		values,
		state.overrides.working.elements ?? [],
	);
	const spawnedId = spawnedDef?.id ?? id;
	const selectedTreeNode = state.tree.find((node) => node.id === id);
	const temporaryContainer =
		selectedTreeNode?.temporaryRuntimeId ||
		values.temporaryRuntimeId ||
		state.temporaryContainerIds.has(id) ||
		isTemporaryLayoutContainer(selectedTreeNode ?? values);

	const header = document.createElement('div');
	header.className = 'insp-header';
	header.innerHTML = `<span class="el-name"></span><span class="el-type"></span>`;
	header.querySelector('.el-name').textContent = spawnedId;
	header.querySelector('.el-type').textContent = spawnedDef ? `${values.type} · editor` : values.type;
	appendInspectorClose(header);
	inspEl.appendChild(header);

	const scopeInfo = document.createElement('div');
	scopeInfo.className = 'insp-scope';
	scopeInfo.innerHTML =
		state.scope === 'base'
			? 'Editing <b>base layout</b> (all profiles)'
			: `Editing profile <b>${state.preview.layoutType ?? '?'}</b>`;
	inspEl.appendChild(scopeInfo);

	if (temporaryContainer) {
		const notice = document.createElement('div');
		notice.className = 'resp-notice';
		notice.textContent = spawnedDef
			? 'This legacy editor element uses a reserved temporary Container id. Layout edits and parenting are disabled. Rename it to a unique id or delete it permanently. If its saved parent is also temporary, Rename safely detaches it to the Pixi stage; review its position afterward.'
			: 'This is a temporary runtime group. Its container slot can refer to a different object after a mode or screen change, so layout edits are disabled and are never saved. Select a named child to edit it. To organize editor-created elements, add a Container (group) with a unique name and use that as their parent.';
		inspEl.appendChild(notice);
		const actions = document.createElement('div');
		actions.className = 'insp-actions';
		if (spawnedDef) {
			const rename = document.createElement('button');
			const renameInput = document.createElement('input');
			renameInput.value = spawnedId;
			renameInput.placeholder = 'Unique element name';
			actions.appendChild(renameInput);
			rename.textContent = 'Rename';
			rename.addEventListener('click', () => {
				const next = renameInput.value.trim();
				if (next && next !== spawnedId && renameSpawnedElement(spawnedId, next)) {
					bridgeSend('select', { id: next });
				}
			});
			actions.appendChild(rename);
			const remove = document.createElement('button');
			remove.className = 'danger';
			remove.textContent = 'Delete permanently…';
			remove.addEventListener('click', () => showRemoveDialog(id, values));
			actions.appendChild(remove);
		}
		const createRoot = document.createElement('button');
		createRoot.className = 'primary';
		createRoot.textContent = 'Add separate named root…';
		createRoot.addEventListener('click', () => showAddElementDialog({
			title: 'Add separate named root container',
			initialKind: 'container',
			lockKind: true,
			lockParent: true,
			rootAtOrigin: true,
			acceptLabel: 'Create root',
			intro:
				'This creates a separate persistent editor Container at the Pixi stage origin; it does not move game-authored children. Editor-created elements can then choose it in their Parent field.',
			namePlaceholder: 'e.g. bonusRoot',
			successMessage:
				'Created “{id}” as a persistent named root. Use the Parent field to move editor-created elements into it.',
		}));
		actions.appendChild(createRoot);
		inspEl.appendChild(actions);
		renderedInspectorId = null;
		return;
	}

	if (values.identityStable === false) {
		const identityWarning = document.createElement('div');
		identityWarning.className = 'resp-notice';
		identityWarning.textContent =
			'This element has an automatic or duplicate id. Add a unique Pixi label in the game before relying on saved layout rules; mount-order ids can point to a different element after reload.';
		inspEl.appendChild(identityWarning);
	}
	if (hasRuntimeIdentityConflict(values)) {
		const conflictWarning = document.createElement('div');
		conflictWarning.className = 'resp-notice';
		conflictWarning.textContent =
			`This editor element is mounted as "${id}" because "${spawnedId}" is also used by a game element. ` +
			'Layout edits are disabled so they cannot be saved against the wrong object. Rename one of the two elements, or delete this editor element permanently.';
		inspEl.appendChild(conflictWarning);

		const conflictActions = document.createElement('div');
		conflictActions.className = 'insp-actions';
		const deleteButton = document.createElement('button');
		deleteButton.className = 'danger';
		deleteButton.textContent = 'Delete editor element permanently…';
		deleteButton.addEventListener('click', () => showRemoveDialog(id, values));
		conflictActions.appendChild(deleteButton);
		inspEl.appendChild(conflictActions);
		renderedInspectorId = null; // conflict view is not the editable inspector
		return;
	}

	// removal status banner
	const removal = removalState(spawnedId);
	if (removal.base || removal.profiles.length) {
		const banner = document.createElement('div');
		banner.className = 'insp-removed';
		const label = document.createElement('div');
		label.innerHTML = removal.base
			? '<b>Removed from all layouts.</b> The element never renders (game logic keeps running).'
			: `<b>Removed in:</b> ${removal.profiles.join(', ')}.`;
		banner.appendChild(label);
		const buttons = document.createElement('div');
		buttons.style.cssText = 'display:flex;gap:4px;';
		if (removal.activeProfile) {
			const restoreProfileBtn = document.createElement('button');
			restoreProfileBtn.textContent = `Restore in "${state.preview.layoutType}"`;
			restoreProfileBtn.addEventListener('click', () => restoreElementUi(id, 'profile'));
			buttons.appendChild(restoreProfileBtn);
		}
		const restoreAllBtn = document.createElement('button');
		restoreAllBtn.textContent = 'Restore in all layouts';
		restoreAllBtn.addEventListener('click', () => restoreElementUi(id, 'all'));
		buttons.appendChild(restoreAllBtn);
		banner.appendChild(buttons);
		inspEl.appendChild(banner);
	}

	// Image replacement is a first-class Sprite property for both game-authored
	// and editor-created elements. Containers surface their nested Sprites here so
	// the user does not have to hunt through a large hierarchy first.
	if (values.type === 'sprite') {
		inspEl.appendChild(spriteAssetSection({
			id,
			name: spawnedId,
			assetKey: spawnedDef?.kind === 'sprite'
				? spawnedDef.assetKey
				: (eff.assetKey ?? null),
			authoredAssetKey: values.authoredAssetKey ?? null,
			assetAvailable: values.assetAvailable !== false,
			spawnedDef: spawnedDef?.kind === 'sprite' ? spawnedDef : null,
		}));
	} else if (values.type === 'container' || values.type === 'graphics') {
		inspEl.appendChild(containedSpriteSection(values));
	}

	// Pixi zIndex is sibling-scoped. Expose it for every display object so users
	// can order authored nodes, editor-created nodes, and whole parent containers.
	const layer = section('Layer order');
	const layerNote = document.createElement('div');
	layerNote.className = 'dim';
	layerNote.style.marginBottom = '5px';
	const treeNode = selectedTreeNode;
	layerNote.textContent =
		`Higher values render on top of siblings under ${treeNode?.parentId ?? 'the Pixi stage'}. ` +
		'Drag same-parent rows in the Layout tree to reorder them together.';
	layer.appendChild(layerNote);
	const layerButtons = document.createElement('span');
	layerButtons.style.cssText = 'display:flex;gap:3px;';
	const layerReady = (state.preview.bridgeVersion ?? 0) >= EXPECTED_BRIDGE_VERSION;
	const layerRow = numberRow({
		label: 'zIndex',
		key: 'zIndex',
		value: eff.zIndex ?? spawnedDef?.order ?? 0,
		id,
		decimals: 0,
		extra: layerButtons,
		disabled: !layerReady,
		disabledTitle: `Update the project bridge to v${EXPECTED_BRIDGE_VERSION} to edit layer order.`,
	});
	const layerInput = layerRow.querySelector('input[data-prop-key="zIndex"]');
	for (const [label, delta, title] of [
		['▲', 1, 'Bring forward'],
		['▼', -1, 'Send backward'],
	]) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.title = title;
		button.disabled = !layerReady;
		button.addEventListener('click', () => {
			const value = (Number(layerInput.value) || 0) + delta;
			layerInput.value = value;
			setProp(activeScopeProfile(), id, 'zIndex', value);
		});
		layerButtons.appendChild(button);
	}
	layer.appendChild(layerRow);
	inspEl.appendChild(layer);

	// Position
	const pos = section('Position');
	if (responsiveXOwned || responsiveYOwned) {
		const note = document.createElement('div');
		note.className = 'dim';
		note.style.marginBottom = '4px';
		const owned = responsiveXOwned && responsiveYOwned ? 'X and Y are' : responsiveXOwned ? 'X is' : 'Y is';
		note.textContent = `${owned} controlled by Responsive layout below.`;
		pos.appendChild(note);
	}
	pos.appendChild(numberRow({
		label: 'X', key: 'x', value: eff.x, id,
		disabled: responsiveXOwned,
		disabledTitle: 'Change the Horizontal rule or Offset X under Responsive layout.',
	}));
	pos.appendChild(numberRow({
		label: 'Y', key: 'y', value: eff.y, id,
		disabled: responsiveYOwned,
		disabledTitle: 'Change the Vertical rule or Offset Y under Responsive layout.',
	}));
	inspEl.appendChild(pos);

	// Size / scale
	const size = section('Size & scale');
	if (responsiveWidthOwned || responsiveHeightOwned) {
		const note = document.createElement('div');
		note.className = 'dim';
		note.style.marginBottom = '4px';
		note.textContent = 'Responsive layout owns the disabled size fields below.';
		size.appendChild(note);
	}
	const resizable = values.type === 'sprite' || values.isText;
	if (resizable) {
		size.appendChild(numberRow({
			label: 'Width', key: 'width', value: eff.width, id,
			disabled: responsiveWidthOwned,
			disabledTitle: 'This dimension is controlled by Responsive layout.',
		}));
		size.appendChild(numberRow({
			label: 'Height', key: 'height', value: eff.height, id,
			disabled: responsiveHeightOwned,
			disabledTitle: 'This dimension is controlled by Responsive layout.',
		}));
	} else {
		const note = document.createElement('div');
		note.className = 'dim';
		note.style.marginBottom = '4px';
		note.textContent = `bounds ${Math.round(values.bounds?.width ?? 0)} × ${Math.round(values.bounds?.height ?? 0)} px (use scale to resize groups)`;
		size.appendChild(note);
	}
	const link = document.createElement('button');
	link.className = 'link-toggle' + (linkedScale ? ' on' : '');
	link.textContent = linkedScale ? '🔗' : '⛓';
	link.title = 'Link X / Y scale';
	link.addEventListener('click', () => {
		linkedScale = !linkedScale;
		renderInspector();
	});
	size.appendChild(
		numberRow({
			label: 'Scale X', key: 'scaleX', value: eff.scaleX, id, step: 0.05, decimals: 4, extra: link,
			disabled: responsiveScaleOwned || !!effectiveResponsive.stretchX || !!effectiveResponsive.stretchY,
			disabledTitle: 'Use Size behavior or Base scale under Responsive layout.',
		}),
	);
	size.appendChild(
		numberRow({
			label: 'Scale Y', key: 'scaleY', value: eff.scaleY, id, step: 0.05, decimals: 4,
			disabled: responsiveScaleOwned || !!effectiveResponsive.stretchX || !!effectiveResponsive.stretchY,
			disabledTitle: 'Use Size behavior or Base scale under Responsive layout.',
		}),
	);
	inspEl.appendChild(size);

	// Anchor
	if (values.hasAnchor) {
		const anchor = section('Anchor');
		anchor.appendChild(numberRow({ label: 'Anchor X', key: 'anchorX', value: eff.anchorX, id, step: 0.1, decimals: 2 }));
		anchor.appendChild(numberRow({ label: 'Anchor Y', key: 'anchorY', value: eff.anchorY, id, step: 0.1, decimals: 2 }));
		inspEl.appendChild(anchor);
	}

	// Responsive layout
	inspEl.appendChild(responsiveSection(values, id));

	// Visibility
	const vis = section('Visibility');
	const visRow = document.createElement('div');
	visRow.className = 'prop-row';
	const visSrc = valueSource(id, 'visible');
	visRow.innerHTML = `<span class="src ${visSrc}">${visSrc === 'profile' ? 'P' : visSrc === 'base' ? 'B' : '·'}</span><label>Visible</label>`;
	const visInput = document.createElement('input');
	visInput.type = 'checkbox';
	visInput.checked = !!eff.visible;
	visInput.addEventListener('change', () => setProp(activeScopeProfile(), id, 'visible', visInput.checked));
	visRow.appendChild(visInput);
	const visReset = document.createElement('button');
	visReset.className = 'reset-prop';
	visReset.textContent = '×';
	visReset.title = 'Remove visibility override';
	visReset.addEventListener('click', () => setProp(activeScopeProfile(), id, 'visible', null));
	visRow.appendChild(visReset);
	vis.appendChild(visRow);
	inspEl.appendChild(vis);

	// Text
	if (values.isText) {
		const text = section('Text layout');
		text.appendChild(numberRow({ label: 'Font size', key: 'fontSize', value: eff.fontSize, id }));
		const alignRow = document.createElement('div');
		alignRow.className = 'prop-row';
		const alignSrc = valueSource(id, 'align');
		alignRow.innerHTML = `<span class="src ${alignSrc}">${alignSrc === 'profile' ? 'P' : alignSrc === 'base' ? 'B' : '·'}</span><label>Align</label>`;
		const alignSel = document.createElement('select');
		for (const option of ['left', 'center', 'right', 'justify']) {
			const opt = document.createElement('option');
			opt.value = option;
			opt.textContent = option;
			if (eff.align === option) opt.selected = true;
			alignSel.appendChild(opt);
		}
		alignSel.addEventListener('change', () => setProp(activeScopeProfile(), id, 'align', alignSel.value));
		alignRow.appendChild(alignSel);
		const alignReset = document.createElement('button');
		alignReset.className = 'reset-prop';
		alignReset.textContent = '×';
		alignReset.addEventListener('click', () => setProp(activeScopeProfile(), id, 'align', null));
		alignRow.appendChild(alignReset);
		text.appendChild(alignRow);

		const sampleLabel = document.createElement('div');
		sampleLabel.className = 'dim';
		sampleLabel.style.margin = '6px 0 3px';
		sampleLabel.textContent = 'Preview sample text (not saved):';
		text.appendChild(sampleLabel);
		const sampleRow = document.createElement('div');
		sampleRow.className = 'sample-row';
		for (const [name, sample] of Object.entries(SAMPLES)) {
			const btn = document.createElement('button');
			btn.textContent = name;
			btn.title = sample;
			btn.addEventListener('click', () => bridgeSend('sampleText', { id, text: sample }));
			sampleRow.appendChild(btn);
		}
		const customSample = document.createElement('input');
		customSample.placeholder = 'custom…';
		customSample.addEventListener('change', () => bridgeSend('sampleText', { id, text: customSample.value || null }));
		sampleRow.appendChild(customSample);
		const sampleReset = document.createElement('button');
		sampleReset.textContent = '↺';
		sampleReset.title = 'Restore real text';
		sampleReset.addEventListener('click', () => bridgeSend('sampleText', { id, text: null }));
		sampleRow.appendChild(sampleReset);
		text.appendChild(sampleRow);
		inspEl.appendChild(text);
	}

	// Align tools
	const align = section('Align on screen');
	const grid = document.createElement('div');
	grid.className = 'align-grid';
	const actions = [
		['⇤', 'left', null],
		['↔', 'center', null],
		['⇥', 'right', null],
		['⤒', null, 'top'],
		['↕', null, 'middle'],
		['⤓', null, 'bottom'],
	];
	for (const [icon, h, v] of actions) {
		const btn = document.createElement('button');
		btn.textContent = icon;
		btn.title = h ? `Align ${h}` : `Align ${v}`;
		btn.addEventListener('click', () => bridgeSend('align', { id, h, v, scope: activeScopeProfile() }));
		grid.appendChild(btn);
	}
	align.appendChild(grid);
	const centerBtn = document.createElement('button');
	centerBtn.style.marginTop = '4px';
	centerBtn.textContent = 'Center on screen';
	centerBtn.addEventListener('click', () =>
		bridgeSend('align', { id, h: 'center', v: 'middle', scope: activeScopeProfile() }),
	);
	align.appendChild(centerBtn);
	inspEl.appendChild(align);

	// Editor-created element management
	if (spawnedDef) {
		const spawnedSection = section('Editor element');
		const col = document.createElement('div');
		col.className = 'insp-actions';

		// rename
		const renameRow = document.createElement('div');
		renameRow.className = 'prop-row';
		renameRow.innerHTML = '<label>Name</label>';
		const renameInput = document.createElement('input');
		renameInput.style.flex = '1';
		renameInput.value = spawnedId;
		renameRow.appendChild(renameInput);
		const renameBtn = document.createElement('button');
		renameBtn.textContent = 'Rename';
		renameBtn.addEventListener('click', () => {
			const next = renameInput.value.trim();
			if (next && next !== spawnedId && renameSpawnedElement(spawnedId, next)) {
				bridgeSend('select', { id: next });
			}
		});
		renameRow.appendChild(renameBtn);
		col.appendChild(renameRow);

		// parent
		const parentRow = document.createElement('div');
		parentRow.className = 'prop-row';
		parentRow.innerHTML = '<label>Parent</label>';
		const parentSel = document.createElement('select');
		const options = buildParentOptions({
			definitions: state.overrides.working.elements ?? [],
			liveNodes: state.tree,
			excludeId: spawnedId,
		}).filter(({ value }) => !state.temporaryContainerIds.has(value));
		const currentParent = spawnedDef.parentId ?? GLOBAL_STAGE_PARENT;
		const unsafeCurrentParent =
			currentParent !== GLOBAL_STAGE_PARENT && isUnsafeLayoutParent(currentParent);
		if (!options.some((option) => option.value === currentParent)) {
			options.push({
				value: currentParent,
				label: `${currentParent} — unavailable or unsafe automatic parent`,
				description:
					'This saved parent is not an explicit game parent target. Choose a supported parent to replace it.',
				kind: 'unavailable',
				order: Number.POSITIVE_INFINITY,
			});
		}
		for (const option of options) {
			const opt = document.createElement('option');
			opt.value = option.value;
			opt.textContent = option.label;
			opt.title = option.description;
			if (option.kind === 'unavailable') opt.disabled = true;
			if (currentParent === option.value) opt.selected = true;
			parentSel.appendChild(opt);
		}
		const parentHint = document.createElement('div');
		parentHint.className = 'dim';
		parentHint.style.margin = '2px 0 4px';
		const updateParentHint = () => {
			const option = options.find(({ value }) => value === parentSel.value);
			parentHint.textContent = parentHelpText(option);
			parentSel.title = parentHint.textContent;
		};
		updateParentHint();
		parentSel.addEventListener('change', async () => {
			const previous = spawnedDef.parentId ?? GLOBAL_STAGE_PARENT;
			const nextParent = parentSel.value;
			parentSel.disabled = true;
			const risk = reparentProfileRisk(spawnedId);
			if (risk) {
				const affected = risk.affected.join(', ');
				const confirmed = await confirmDialog(
					'Reparent across layouts',
					`Parent is shared by every layout. The current ${risk.active} geometry will be preserved, but ${affected} keep their old parent-space values and may move. Continue and review those layouts afterward?`,
				);
				if (!confirmed) {
					parentSel.value = previous;
					updateParentHint();
					parentSel.disabled = false;
					return;
				}
			}
			const ok = await reparentSpawnedElement(
				spawnedId,
				nextParent === GLOBAL_STAGE_PARENT ? null : nextParent,
			);
			if (!ok) parentSel.value = previous;
			updateParentHint();
			parentSel.disabled = false;
		});
		parentRow.appendChild(parentSel);
		col.appendChild(parentRow);
		col.appendChild(parentHint);
		if (unsafeCurrentParent) {
			const unsafeParentNotice = document.createElement('div');
			unsafeParentNotice.className = 'resp-notice';
			unsafeParentNotice.textContent =
				`“${currentParent}” is a temporary runtime parent and cannot be saved safely. Choose the Pixi stage or a named parent; when the element is mounted, the editor preserves its current edit-target geometry while moving it.`;
			col.appendChild(unsafeParentNotice);
		}

		// Spine assets require object recreation and keep their playback controls
		// with editor-element management. Sprite textures use Image asset above.
		if (spawnedDef.kind === 'spine') {
			const assetType = 'spine';
			const assetRow = document.createElement('div');
			assetRow.className = 'prop-row';
			assetRow.innerHTML = '<label>Asset</label>';
			const assetName = document.createElement('span');
			assetName.className = 'dim';
			assetName.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
			assetName.textContent = spawnedDef.assetKey ?? '';
			assetName.title = spawnedDef.assetKey ?? '';
			assetRow.appendChild(assetName);
			const replaceBtn = document.createElement('button');
			replaceBtn.textContent = 'Replace…';
			replaceBtn.addEventListener('click', async () => {
				const definitionId = spawnedDef.id;
				const asset = await pickAsset(assetType, {
					currentKey: spawnedDef.assetKey,
					title: `Replace Spine asset — ${spawnedId}`,
					acceptLabel: 'Replace Spine',
				});
				if (!asset) return;
				const liveDef = getSpawnedDef(definitionId);
				if (liveDef?.kind !== 'spine') {
					toast(`Cannot replace “${spawnedId}” because that Spine element no longer exists.`, 'error', 6000);
					return;
				}
				if (asset.key === liveDef.assetKey) return;
				const animationName = preferredSpineAnimation(asset);
				updateSpawnedDef(
					liveDef.id,
					{
						assetKey: asset.key,
						animationName: animationName || undefined,
						loop: animationName ? (liveDef.loop !== false) : undefined,
					},
					'replace Spine asset',
				);
			});
			assetRow.appendChild(replaceBtn);
			col.appendChild(assetRow);

			if (spawnedDef.kind === 'spine') {
				const animationRow = document.createElement('div');
				animationRow.className = 'prop-row';
				animationRow.innerHTML = '<label>Animation</label>';
				const animationSelect = document.createElement('select');
				animationSelect.disabled = true;
				const loading = document.createElement('option');
				loading.textContent = 'Loading animations…';
				animationSelect.appendChild(loading);
				animationSelect.addEventListener('change', () => {
					updateSpawnedDef(
						spawnedId,
						{ animationName: animationSelect.value || undefined },
						'change Spine animation',
					);
					loopInput.disabled = !animationSelect.value;
				});
				animationRow.appendChild(animationSelect);
				const loopLabel = document.createElement('label');
				loopLabel.className = 'inline-check';
				const loopInput = document.createElement('input');
				loopInput.type = 'checkbox';
				loopInput.checked = spawnedDef.loop !== false;
				loopInput.addEventListener('change', () =>
					updateSpawnedDef(spawnedId, { loop: loopInput.checked }, 'change Spine loop'),
				);
				loopLabel.appendChild(loopInput);
				loopLabel.append(' Loop');
				animationRow.appendChild(loopLabel);
				col.appendChild(animationRow);

				fetchAssets(false, 'spine')
					.then((assets) => {
						if (!animationSelect.isConnected) return;
						const asset = assets.find(({ key }) => key === spawnedDef.assetKey);
						const names = [...(asset?.animations ?? [])];
						if (spawnedDef.animationName && !names.includes(spawnedDef.animationName)) {
							names.unshift(spawnedDef.animationName);
						}
						animationSelect.innerHTML = '';
						if (!names.length) {
							const option = document.createElement('option');
							option.value = '';
							option.textContent = 'Setup pose (no animations)';
							animationSelect.appendChild(option);
							animationSelect.disabled = true;
							loopInput.disabled = true;
							return;
						}
						const setupPose = document.createElement('option');
						setupPose.value = '';
						setupPose.textContent = 'Setup pose';
						animationSelect.appendChild(setupPose);
						for (const name of names) {
							const option = document.createElement('option');
							option.value = name;
							option.textContent = name;
							animationSelect.appendChild(option);
						}
						animationSelect.value = spawnedDef.animationName || '';
						loopInput.disabled = !animationSelect.value;
						animationSelect.disabled = false;
					})
					.catch(() => {
						if (animationSelect.isConnected) {
							animationSelect.innerHTML = '<option>Animations unavailable</option>';
							loopInput.disabled = true;
						}
					});
			}
		}

		// duplicate / delete
		const rowBtns = document.createElement('div');
		rowBtns.style.cssText = 'display:flex;gap:4px;';
		const dupBtn = document.createElement('button');
		dupBtn.textContent = 'Duplicate';
		dupBtn.style.flex = '1';
		dupBtn.addEventListener('click', () => {
			const newId = duplicateSpawnedElement(spawnedId);
			if (newId) {
				state.selection = newId;
				bridgeSend('select', { id: newId });
			}
		});
		const delBtn = document.createElement('button');
		delBtn.className = 'danger';
		delBtn.textContent = 'Delete permanently…';
		delBtn.style.flex = '1';
		delBtn.addEventListener('click', () => showRemoveDialog(id, values));
		rowBtns.appendChild(dupBtn);
		rowBtns.appendChild(delBtn);
		col.appendChild(rowBtns);

		spawnedSection.appendChild(col);
		inspEl.appendChild(spawnedSection);
	}

	// Element actions
	const actionsSection = section('Element actions');
	const wrap = document.createElement('div');
	wrap.className = 'insp-actions';
	const mkBtn = (labelText, fn, title = '') => {
		const btn = document.createElement('button');
		btn.textContent = labelText;
		btn.title = title;
		btn.addEventListener('click', fn);
		wrap.appendChild(btn);
	};
	mkBtn(
		spawnedDef ? 'Delete element… (Del)' : 'Hide from standalone game… (Del)',
		() => showRemoveDialog(id, values),
		spawnedDef
			? 'Permanently delete this editor element, or keep it saved but hide it in selected layouts'
			: 'Persistently suppress this source-defined element in the current profile or every standalone layout',
	);
	mkBtn('Reset element (current target)', () => resetElement(id, [activeScopeProfile()]),
		'Remove all overrides for this element in the current edit target');
	mkBtn('Reset element (all profiles)', () => resetElement(id, PROFILES),
		'Remove all overrides for this element everywhere');
	mkBtn('Revert element to last saved', () => revertElement(id));
	const copyRow = document.createElement('div');
	copyRow.className = 'prop-row';
	copyRow.innerHTML = '<label>Copy to</label>';
	const copySel = document.createElement('select');
	for (const profile of PROFILES) {
		if (profile === activeScopeProfile()) continue;
		const opt = document.createElement('option');
		opt.value = profile;
		opt.textContent = profile;
		copySel.appendChild(opt);
	}
	copyRow.appendChild(copySel);
	const copyBtn = document.createElement('button');
	copyBtn.textContent = 'Copy';
	copyBtn.title = 'Copy this element’s overrides from the current edit target to another profile';
	copyBtn.addEventListener('click', () => copyElement(id, activeScopeProfile(), copySel.value));
	copyRow.appendChild(copyBtn);
	wrap.appendChild(copyRow);
	actionsSection.appendChild(wrap);
	inspEl.appendChild(actionsSection);

	// The full editable inspector for this element is now mounted; subsequent live
	// `values` frames patch it in place instead of rebuilding it.
	renderedInspectorId = values.id;
}

export function initInspector() {
	inspEl = document.getElementById('inspector');
	// Live per-frame geometry only patches the numbers in place (keeps dropdowns and
	// typing usable, no 60fps rebuild); structural changes do a full render.
	on('values', refreshInspectorLiveValues);
	on('selection', renderInspector);
	on('overrides', renderInspector);
	on('preview', renderInspector);
	on('tree', renderInspector);
	// Derive the opening state the same way as every later one. Without this the
	// panel keeps the empty hint markup from index.html and stays visible until
	// the first selection event, which is the whole thing being fixed here.
	renderInspector();
}
