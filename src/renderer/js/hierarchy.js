/** Left panel: element tree with search, filters, selection and visibility toggles. */
import { state, on, emit } from './state.js';
import { bridgeSend } from './bridge.js';
import {
	hasOverride,
	activeScopeProfile,
	getEntry,
	setProp,
	setLayerOrder,
	removedIn,
	PROFILES,
} from './overrides.js';
import { showMenu } from './dialogs.js';
import { showAddElementDialog } from './addElement.js';
import { showRemoveDialog, restoreElementUi } from './removal.js';
import { matchesTreeFilters, mergePersistedElementNodes } from './treeFilters.js';
import { editorDefinitionForNode } from './elementOwnership.js';
import { contextualParentOption } from './elementParents.js';
import { isTemporaryLayoutContainer } from '../../shared/layoutIdentity.js';

const ICONS = { sprite: '▣', text: 'T', container: '▦', spine: '✦', graphics: '◻' };

let treeEl;
let draggedLayer = null;

const effectiveLayerOrder = (node) => {
	const profile = activeScopeProfile();
	const local = getEntry(state.overrides.working, profile, node.id)?.zIndex;
	const base = profile === 'base'
		? undefined
		: getEntry(state.overrides.working, 'base', node.id)?.zIndex;
	return Number(local ?? base ?? node.zIndex ?? 0) || 0;
};

const clearLayerDropMarkers = () => {
	for (const row of treeEl?.querySelectorAll('.tree-row.layer-drop-before, .tree-row.layer-drop-after') ?? []) {
		row.classList.remove('layer-drop-before', 'layer-drop-after');
	}
};

const isRemovedNow = (id) => removedIn(id, state.preview.layoutType ?? 'desktop');

const matchesFilters = (node) => {
	const f = state.filters;
	return matchesTreeFilters(node, f, {
		removed: isRemovedNow(node.id),
		hasOverride: PROFILES.some((profile) => hasOverride(node.id, profile)),
	});
};

const anyFilterActive = () => {
	const f = state.filters;
	return !!f.text || f.types.size > 0 || f.visibleOnly || f.overriddenOnly || f.showRemoved;
};

function makeRow(node, depth, hasChildren, isTopLayer = false) {
	const temporaryContainer =
		node.temporaryRuntimeId ||
		state.temporaryContainerIds.has(node.id) ||
		isTemporaryLayoutContainer(node);
	const editorDef = editorDefinitionForNode(
		node,
		state.overrides.working.elements ?? [],
	);
	const row = document.createElement('div');
	row.className = 'tree-row';
	row.dataset.id = node.id;
	if (!node.worldVisible) row.classList.add('hidden-el');
	if (node.persistedOnly) {
		row.classList.add('persisted-only');
		row.title =
			'Saved editor element is not mounted in the preview. It can still be restored or permanently deleted.';
	}
	if (temporaryContainer) {
		row.classList.add('temporary-container');
		row.title =
			'Temporary runtime group. It is shown for navigation, but cannot be edited or saved because this slot may identify another container after a remount.';
	}
	if (node.ownershipConflict) {
		row.title =
			`The saved editor element "${node.definitionId ?? node.id}" conflicts with a game-owned id. ` +
			'It remains separately deletable, but must be renamed before it can mount safely.';
	}
	if (node.id === state.selection) row.classList.add('selected');
	row.style.paddingLeft = `${6 + depth * 14}px`;

	const caret = document.createElement('span');
	caret.className = 'caret';
	caret.textContent = hasChildren ? (state.collapsed.has(node.id) ? '▸' : '▾') : '';
	if (hasChildren) {
		caret.addEventListener('click', (event) => {
			event.stopPropagation();
			if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
			else state.collapsed.add(node.id);
			renderTree();
		});
	}
	row.appendChild(caret);

	const icon = document.createElement('span');
	icon.className = 'icon';
	icon.textContent = ICONS[node.type] ?? '·';
	icon.title = node.type;
	row.appendChild(icon);

	if (editorDef) {
		const badge = document.createElement('span');
		badge.className = 'spawned-badge';
		badge.textContent = '+';
		badge.title = 'Created with the Layout Editor';
		row.appendChild(badge);
	}
	if (node.persistedOnly) {
		const badge = document.createElement('span');
		badge.className = 'persisted-badge';
		badge.textContent = 'saved';
		badge.title = 'Saved in project data but not mounted in the preview';
		row.appendChild(badge);
	}

	const name = document.createElement('span');
	name.className = 'name' + (node.identityStable === false ? ' auto' : '');
	name.textContent = node.id;
	name.title = temporaryContainer ? `${node.id} — temporary runtime group` : node.id;
	row.appendChild(name);

	if (node.textPreview) {
		const preview = document.createElement('span');
		preview.className = 'preview';
		preview.textContent = `“${node.textPreview}”`;
		row.appendChild(preview);
	}

	const flags = document.createElement('span');
	flags.className = 'flags';
	if (isTopLayer) {
		const top = document.createElement('span');
		top.className = 'layer-top-badge';
		top.textContent = 'TOP';
		top.title = 'Highest sibling layer — renders on top';
		flags.appendChild(top);
	}

	const activeProfileName = activeScopeProfile();
	const inActive = hasOverride(node.id, activeProfileName);
	const inOther = PROFILES.some((profile) => profile !== activeProfileName && hasOverride(node.id, profile));
	if (inActive || inOther) {
		const dot = document.createElement('span');
		dot.className = 'ovr' + (inActive ? '' : ' other');
		dot.textContent = '●';
		dot.title = inActive
			? `Has overrides in "${activeProfileName}"`
			: 'Has overrides in another profile';
		flags.appendChild(dot);
	}

	const eye = document.createElement('button');
	eye.className = 'eye' + (node.visible ? '' : ' off');
	eye.textContent = node.visible ? '👁' : '–';
	eye.title = temporaryContainer
		? 'Temporary runtime containers are read-only; edit a named child instead.'
		: node.persistedOnly
		? 'This saved element is not mounted; use Restore or Delete permanently'
		: 'Toggle visibility override for the current edit target';
	eye.disabled = !!node.persistedOnly || temporaryContainer;
	eye.addEventListener('click', (event) => {
		event.stopPropagation();
		setProp(activeProfileName, node.id, 'visible', node.visible ? false : null);
	});
	flags.appendChild(eye);
	row.appendChild(flags);

	if (isRemovedNow(node.id)) {
		row.classList.add('removed-el');
		const removedBadge = document.createElement('span');
		removedBadge.className = 'removed-badge';
		removedBadge.textContent = '✕';
		removedBadge.title = 'Removed (use right-click or the inspector to restore)';
		flags.prepend(removedBadge);
	}

	row.addEventListener('click', () => {
		state.selection = node.id;
		if (node.persistedOnly) state.values = null;
		else bridgeSend('select', { id: node.id });
		emit('selection');
	});
	row.draggable = !temporaryContainer && !node.persistedOnly && !node.identityConflict && !isRemovedNow(node.id);
	row.addEventListener('dragstart', (event) => {
		if (!row.draggable || anyFilterActive()) {
			event.preventDefault();
			return;
		}
		draggedLayer = { id: node.id, parentId: node.parentId ?? null };
		row.classList.add('layer-dragging');
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', node.id);
	});
	row.addEventListener('dragover', (event) => {
		if (
			temporaryContainer ||
			!draggedLayer ||
			draggedLayer.id === node.id ||
			draggedLayer.parentId !== (node.parentId ?? null) ||
			node.identityConflict
		) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		clearLayerDropMarkers();
		const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
		row.classList.add(after ? 'layer-drop-after' : 'layer-drop-before');
	});
	row.addEventListener('dragleave', (event) => {
		if (!row.contains(event.relatedTarget)) {
			row.classList.remove('layer-drop-before', 'layer-drop-after');
		}
	});
	row.addEventListener('drop', (event) => {
		if (
			temporaryContainer ||
			!draggedLayer ||
			draggedLayer.id === node.id ||
			draggedLayer.parentId !== (node.parentId ?? null)
		) return;
		event.preventDefault();
		const sourceLayer = draggedLayer;
		const after = row.classList.contains('layer-drop-after');
		const siblings = state.tree
			.filter((entry) => (entry.parentId ?? null) === sourceLayer.parentId && !entry.identityConflict)
			.sort((a, b) => effectiveLayerOrder(b) - effectiveLayerOrder(a) || b.order - a.order);
		const ids = siblings.map(({ id }) => id).filter((id) => id !== sourceLayer.id);
		const targetIndex = ids.indexOf(node.id);
		if (targetIndex >= 0) {
			ids.splice(targetIndex + (after ? 1 : 0), 0, sourceLayer.id);
			draggedLayer = null;
			// The tree displays front-to-back (topmost first), while zIndex is
			// normalized back-to-front (highest numeric value renders on top).
			setLayerOrder(activeScopeProfile(), [...ids].reverse());
			bridgeSend('requestTree');
		}
		clearLayerDropMarkers();
	});
	row.addEventListener('dragend', () => {
		row.classList.remove('layer-dragging');
		clearLayerDropMarkers();
		draggedLayer = null;
	});
	row.addEventListener('contextmenu', (event) => {
		event.preventDefault();
		state.selection = node.id;
		if (node.persistedOnly) state.values = null;
		else bridgeSend('select', { id: node.id });
		emit('selection');
		const removedNow = isRemovedNow(node.id);
		const items = [{ header: node.id }];
		const containerLike = node.type === 'container' || node.type === 'graphics';
		const parentOption = containerLike ? contextualParentOption(node) : null;
		const canAdd = !!parentOption && !removedNow && !node.persistedOnly && !temporaryContainer;
		const canDelete = !!editorDef;
		const canToggleVisibility = !removedNow && !node.persistedOnly && !temporaryContainer;
		const visibilityProfile = activeScopeProfile();
		const profileVisibility = getEntry(
			state.overrides.working,
			visibilityProfile,
			node.id,
		)?.visible;
		const baseVisibility = visibilityProfile === 'base'
			? undefined
			: getEntry(state.overrides.working, 'base', node.id)?.visible;
		const effectiveVisibility = profileVisibility ?? baseVisibility ?? node.visible;
		const willShow = effectiveVisibility === false;
		if (temporaryContainer) {
			items.push({
				label: 'Add separate named root…',
				title:
					'Create a persistent stage-rooted Container. Named children stay editable where they are; editor-created elements can be moved to the new root using their Parent field.',
				onClick: () => showAddElementDialog({
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
				}),
			});
		}
		items.push({
			label: 'Add child element…',
			disabled: !canAdd,
			title: canAdd
				? parentOption.unsafe
					? `Use the exact live “${node.id}” object as parent. Its automatic id may change after reload.`
					: `Open Add element with “${node.id}” selected as the parent.`
				: temporaryContainer
					? 'Temporary runtime groups cannot be saved as parents. Add a named Container (group) and use it for editor-created children.'
				: containerLike
					? 'This container is not currently mounted and cannot accept a child.'
					: 'Only Container and Graphics objects can be parents.',
			onClick: () => showAddElementDialog({ parentId: node.id }),
		});
		items.push({
			label: 'Delete element…',
			disabled: !canDelete,
			danger: canDelete,
			title: canDelete
				? 'Permanently delete this editor-created element after confirmation.'
				: 'Game-authored objects cannot be deleted from the Layout Editor; change their source code instead.',
			onClick: () => showRemoveDialog(node.id, node),
		});
		items.push({
			label: willShow ? 'Show in current layout' : 'Hide in current layout',
			disabled: !canToggleVisibility,
			title: canToggleVisibility
				? `${willShow ? 'Show' : 'Hide'} this object in the current edit target. Undo or Reset restores the previous value.`
				: removedNow
					? 'This element is already removed in the current layout.'
					: node.persistedOnly
						? 'This saved element is not mounted in the preview.'
					: temporaryContainer
						? 'Temporary runtime containers are read-only; edit a named child instead.'
						: 'Visibility cannot be changed for this element.',
			onClick: () => setProp(visibilityProfile, node.id, 'visible', willShow),
		});
		items.push({ sep: true });
		if (removedNow) {
			items.push({
				label: 'Restore for this profile',
				disabled: temporaryContainer,
				onClick: () => restoreElementUi(node.id, 'profile'),
			});
			items.push({
				label: 'Restore in all layouts',
				disabled: temporaryContainer,
				onClick: () => restoreElementUi(node.id, 'all'),
			});
		}
		showMenu({ getBoundingClientRect: () => ({ left: event.clientX, bottom: event.clientY }) }, items);
	});
	row.addEventListener('mouseenter', () => bridgeSend('hover', { id: node.id }));
	row.addEventListener('mouseleave', () => bridgeSend('hover', { id: null }));
	return row;
}

export function renderTree() {
	if (!treeEl) return;
	treeEl.innerHTML = '';
	const nodes = mergePersistedElementNodes(
		state.tree,
		state.overrides.working.elements ?? [],
	);
	if (!nodes.length) {
		treeEl.innerHTML = '<div class="empty-hint">No elements yet.<br>Start the preview to populate this list.</div>';
		return;
	}

	if (anyFilterActive()) {
		// flat filtered list
		for (const node of nodes) {
			if (matchesFilters(node)) treeEl.appendChild(makeRow(node, 0, false));
		}
		return;
	}

	const byParent = new Map();
	for (const node of nodes) {
		const key = node.parentId ?? '__root__';
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key).push(node);
	}
	for (const siblings of byParent.values()) {
		siblings.sort((a, b) => effectiveLayerOrder(b) - effectiveLayerOrder(a) || b.order - a.order);
	}
	const renderLevel = (parentKey, depth) => {
		const siblings = byParent.get(parentKey) ?? [];
		for (let index = 0; index < siblings.length; index++) {
			const node = siblings[index];
			// removed elements (and their subtrees) live under the "removed" filter chip
			if (isRemovedNow(node.id)) continue;
			const hasChildren = byParent.has(node.id);
			treeEl.appendChild(makeRow(node, depth, hasChildren, siblings.length > 1 && index === 0));
			if (hasChildren && !state.collapsed.has(node.id)) renderLevel(node.id, depth + 1);
		}
	};
	renderLevel('__root__', 0);
}

function scrollToSelection() {
	const row = treeEl?.querySelector(`.tree-row[data-id="${CSS.escape(state.selection ?? '')}"]`);
	row?.scrollIntoView({ block: 'nearest' });
}

export function initHierarchy() {
	treeEl = document.getElementById('tree');

	document.getElementById('in-search').addEventListener('input', (event) => {
		state.filters.text = event.target.value.trim().toLowerCase();
		renderTree();
	});

	for (const chip of document.querySelectorAll('#filters .chip[data-type]')) {
		chip.addEventListener('click', () => {
			const type = chip.dataset.type;
			if (state.filters.types.has(type)) state.filters.types.delete(type);
			else state.filters.types.add(type);
			chip.classList.toggle('active');
			renderTree();
		});
	}
	document.getElementById('chip-visible').addEventListener('click', (event) => {
		state.filters.visibleOnly = !state.filters.visibleOnly;
		event.target.classList.toggle('active');
		renderTree();
	});
	document.getElementById('chip-overridden').addEventListener('click', (event) => {
		state.filters.overriddenOnly = !state.filters.overriddenOnly;
		event.target.classList.toggle('active');
		renderTree();
	});
	document.getElementById('chip-removed').addEventListener('click', (event) => {
		state.filters.showRemoved = !state.filters.showRemoved;
		event.target.classList.toggle('active');
		renderTree();
	});

	on('tree', renderTree);
	on('overrides', renderTree);
	on('preview', renderTree);
	on('selection', () => {
		renderTree();
		scrollToSelection();
	});
}
