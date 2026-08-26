/**
 * Working/saved override data operations: entry-level patches (the unit of
 * undo/redo), reset/revert/copy actions and the save diff.
 */
import { state, emit, clone, toast } from './state.js';
import { bridgeRequest, bridgeSend } from './bridge.js';
import { isTemporaryContainerId, isTemporaryLayoutContainer } from '../../shared/layoutIdentity.js';

export const PROFILES = ['base', 'desktop', 'landscape', 'portrait', 'tablet'];
const REPARENT_GEOMETRY_FIELDS = new Set([
	'x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'responsive',
]);

export const activeScopeProfile = () =>
	state.scope === 'base' ? 'base' : (state.preview.layoutType ?? 'desktop');

const temporaryContainerTarget = (id) => {
	if (state.temporaryContainerIds.has(id)) return true;
	const node = state.tree.find((entry) => entry.id === id);
	if (node) return isTemporaryLayoutContainer(node);
	const definition = (state.overrides.working.elements ?? [])
		.find((element) => element.id === id);
	return definition?.kind === 'container' && isTemporaryContainerId(id);
};

export const isUnsafeLayoutParent = (id) =>
	!!id && (isTemporaryContainerId(id) || temporaryContainerTarget(id));

/** Runtime container slots are navigational only and may not own saved changes. */
export const canPersistLayoutTarget = (id) => !temporaryContainerTarget(id);

/**
 * Parent definitions are global, while geometry is scoped. The live bridge can
 * faithfully convert only the currently rendered edit target. Report when the
 * user needs to review other profiles after a reparent.
 */
export function reparentProfileRisk(id) {
	const active = activeScopeProfile();
	if (active !== 'base') {
		return {
			active,
			affected: PROFILES.filter((profile) => profile !== active),
		};
	}
	const affected = PROFILES.filter((profile) => profile !== 'base').filter((profile) => {
		const entry = getEntry(state.overrides.working, profile, id);
		return !!entry && Object.keys(entry).some((field) => REPARENT_GEOMETRY_FIELDS.has(field));
	});
	return affected.length ? { active, affected } : null;
}

export const getEntry = (data, profile, id) => data.profiles?.[profile]?.[id];

function setEntry(data, profile, id, entry) {
	if (!entry || Object.keys(entry).length === 0) {
		if (data.profiles[profile]) {
			delete data.profiles[profile][id];
			if (Object.keys(data.profiles[profile]).length === 0) delete data.profiles[profile];
		}
	} else {
		(data.profiles[profile] ??= {})[id] = entry;
	}
}

export const syncToBridge = () =>
	bridgeSend('overrides', {
		profiles: state.overrides.working.profiles,
		elements: state.overrides.working.elements ?? [],
	});

// --- editor-created ("spawned") element definitions --------------------------

export const getSpawnedDef = (id) =>
	(state.overrides.working.elements ?? []).find((element) => element.id === id);

export const isSpawnedId = (id) => !!getSpawnedDef(id);

function setDef(data, id, def) {
	data.elements ??= [];
	const index = data.elements.findIndex((element) => element.id === id);
	if (!def) {
		if (index >= 0) data.elements.splice(index, 1);
	} else if (index >= 0) {
		data.elements[index] = def;
	} else {
		data.elements.push(def);
	}
}

/**
 * Apply patches to the working data. Two patch shapes, mixable in one step:
 *  - override entry: { profile, id, entry|null }
 *  - element def:    { element: true, id, def|null }
 * Records an undo step (unless told not to) and syncs the game preview.
 */
export function applyPatches(
	patches,
	{ record = true, label = 'edit', sync = true, restoreLegacy = false } = {},
) {
	if (patches.some((patch) =>
		patch.element && patch.def && isUnsafeLayoutParent(patch.def.parentId)) && !restoreLegacy) {
		toast('Temporary runtime containers cannot be saved as parents. Choose the stage or a named container.', 'error', 7000);
		return false;
	}
	if (patches.some((patch) =>
		!patch.element && patch.entry !== null && !canPersistLayoutTarget(patch.id)) && !restoreLegacy) {
		return false;
	}
	if (!patches.length) return false;
	const inverse = patches.map((p) =>
		p.element
			? { element: true, id: p.id, def: clone(getSpawnedDef(p.id)) ?? null }
			: {
					profile: p.profile,
					id: p.id,
					entry: clone(getEntry(state.overrides.working, p.profile, p.id)) ?? null,
				},
	);
	for (const p of patches) {
		if (p.element) setDef(state.overrides.working, p.id, clone(p.def));
		else setEntry(state.overrides.working, p.profile, p.id, clone(p.entry));
	}
	if (record) {
		state.undo.push({ label, patches: clone(patches), inverse });
		if (state.undo.length > 200) state.undo.shift();
		state.redo.length = 0;
	}
	if (sync) syncToBridge();
	emit('overrides');
	return true;
}

/** One property changed from the inspector / keyboard nudge. */
export function setProp(profile, id, key, value) {
	if (!canPersistLayoutTarget(id)) return false;
	const current = clone(getEntry(state.overrides.working, profile, id)) ?? {};
	if (value === null || value === undefined) delete current[key];
	else current[key] = value;
	applyPatches([{ profile, id, entry: current }], { label: `set ${key}` });
	return true;
}

/** Normalize same-parent sibling layers in one undoable edit. */
export function setLayerOrder(profile, orderedIds) {
	const ids = [...new Set((orderedIds ?? []).filter((id) => id && canPersistLayoutTarget(id)))];
	if (ids.length < 2) return false;
	const patches = ids.map((id, zIndex) => {
		const entry = clone(getEntry(state.overrides.working, profile, id)) ?? {};
		entry.zIndex = zIndex;
		return { profile, id, entry };
	});
	applyPatches(patches, { label: 'reorder layers' });
	return true;
}

/** The bridge already applied this change in the game; mirror it + record undo. */
export function handleBridgeCommit({ scope, id, before, after, label }) {
	if (!canPersistLayoutTarget(id)) return false;
	const patches = [{ profile: scope, id, entry: clone(after) ?? null }];
	const inverse = [{ profile: scope, id, entry: clone(before) ?? null }];
	for (const p of patches) setEntry(state.overrides.working, p.profile, p.id, clone(p.entry));
	state.undo.push({ label: label ?? 'move', patches, inverse });
	state.redo.length = 0;
	emit('overrides');
	return true;
}

export function undo() {
	const step = state.undo.pop();
	if (!step) return;
	if (!applyPatches(step.inverse, { record: false, restoreLegacy: !!step.legacyCleanup })) {
		state.undo.push(step);
		return false;
	}
	state.redo.push(step);
	emit('overrides');
	return true;
}

export function redo() {
	const step = state.redo.pop();
	if (!step) return;
	if (!applyPatches(step.patches, { record: false, restoreLegacy: !!step.legacyCleanup })) {
		state.redo.push(step);
		return false;
	}
	state.undo.push(step);
	emit('overrides');
	return true;
}

// ---------------------------------------------------------------------------
// Reset / revert / copy
// ---------------------------------------------------------------------------

export function resetElement(id, profiles) {
	const patches = profiles
		.filter((profile) => getEntry(state.overrides.working, profile, id))
		.map((profile) => ({ profile, id, entry: null }));
	if (patches.length) applyPatches(patches, { label: 'reset element' });
}

export function resetProfile(profile) {
	const ids = Object.keys(state.overrides.working.profiles[profile] ?? {});
	if (!ids.length) return toast(`No overrides in "${profile}"`);
	applyPatches(
		ids.map((id) => ({ profile, id, entry: null })),
		{ label: `reset ${profile} layout` },
	);
}

export function revertElement(id) {
	const patches = PROFILES.map((profile) => ({
		profile,
		id,
		entry: clone(getEntry(state.overrides.saved, profile, id)) ?? null,
	}));
	// for editor-created elements also restore (or remove) the definition
	const savedDef = (state.overrides.saved.elements ?? []).find((element) => element.id === id);
	if (savedDef || isSpawnedId(id)) {
		patches.push({ element: true, id, def: clone(savedDef) ?? null });
	}
	applyPatches(patches, { label: 'revert element' });
}

export function revertProfile(profile) {
	const ids = new Set([
		...Object.keys(state.overrides.working.profiles[profile] ?? {}),
		...Object.keys(state.overrides.saved.profiles[profile] ?? {}),
	]);
	applyPatches(
		[...ids].map((id) => ({
			profile,
			id,
			entry: clone(getEntry(state.overrides.saved, profile, id)) ?? null,
		})),
		{ label: `revert ${profile} layout` },
	);
}

export function revertAll() {
	state.overrides.working = clone(state.overrides.saved);
	state.undo.length = 0;
	state.redo.length = 0;
	syncToBridge();
	emit('overrides');
}

export function copyElement(id, fromProfile, toProfile, keys = null) {
	const source = clone(getEntry(state.overrides.working, fromProfile, id));
	if (!source) return toast(`"${id}" has no override in "${fromProfile}"`);
	let entry = source;
	if (keys) {
		entry = {};
		for (const key of keys) if (source[key] !== undefined) entry[key] = source[key];
		if (!Object.keys(entry).length) return toast('Nothing to copy for those properties');
		const target = clone(getEntry(state.overrides.working, toProfile, id)) ?? {};
		entry = { ...target, ...entry };
	}
	applyPatches([{ profile: toProfile, id, entry }], { label: `copy to ${toProfile}` });
	toast(`Copied "${id}" → ${toProfile}`, 'ok');
}

export function copyProfile(fromProfile, toProfile) {
	const source = state.overrides.working.profiles[fromProfile] ?? {};
	const ids = new Set([
		...Object.keys(source),
		...Object.keys(state.overrides.working.profiles[toProfile] ?? {}),
	]);
	if (!ids.size) return toast(`No overrides in "${fromProfile}"`);
	applyPatches(
		[...ids].map((id) => ({ profile: toProfile, id, entry: clone(source[id]) ?? null })),
		{ label: `copy ${fromProfile} → ${toProfile}` },
	);
	toast(`Copied ${fromProfile} layout → ${toProfile}`, 'ok');
}

// ---------------------------------------------------------------------------
// Removal / restore (works for game-defined AND editor-created elements)
// ---------------------------------------------------------------------------

/**
 * Resolved removal state of an element in a given layout profile:
 * profile-level `removed` wins over base (`removed: false` restores per profile).
 */
export const removedIn = (id, profile, data = state.overrides.working) => {
	const profileValue = getEntry(data, profile, id)?.removed;
	if (profileValue !== undefined) return profileValue;
	return getEntry(data, 'base', id)?.removed ?? false;
};

/** Removal summary used by the UI. */
export function removalState(id) {
	const base = !!getEntry(state.overrides.working, 'base', id)?.removed;
	const activeLayout = state.preview.layoutType ?? 'desktop';
	return {
		base,
		activeProfile: removedIn(id, activeLayout),
		profiles: PROFILES.filter((p) => p !== 'base' && removedIn(id, p)),
	};
}

/** Remove an element for one profile or for all layouts. */
export function removeElement(id, scope) {
	if (!canPersistLayoutTarget(id)) return false;
	const patches = [];
	if (scope === 'all') {
		const base = { ...(clone(getEntry(state.overrides.working, 'base', id)) ?? {}), removed: true };
		patches.push({ profile: 'base', id, entry: base });
		// clear per-profile removed keys so base cleanly applies everywhere
		for (const profile of PROFILES) {
			if (profile === 'base') continue;
			const entry = clone(getEntry(state.overrides.working, profile, id));
			if (entry && entry.removed !== undefined) {
				delete entry.removed;
				patches.push({ profile, id, entry });
			}
		}
	} else {
		const profile = state.preview.layoutType ?? 'desktop';
		const entry = { ...(clone(getEntry(state.overrides.working, profile, id)) ?? {}), removed: true };
		patches.push({ profile, id, entry });
	}
	applyPatches(patches, { label: scope === 'all' ? 'remove element' : 'remove in profile' });
	if (state.selection === id) {
		state.selection = null;
		state.values = null;
		emit('selection');
	}
	return true;
}

/** Restore a removed element for one profile or everywhere. */
export function restoreElement(id, scope) {
	const patches = [];
	if (scope === 'all') {
		for (const profile of PROFILES) {
			const entry = clone(getEntry(state.overrides.working, profile, id));
			if (entry && entry.removed !== undefined) {
				delete entry.removed;
				patches.push({ profile, id, entry });
			}
		}
	} else {
		const profile = state.preview.layoutType ?? 'desktop';
		const entry = clone(getEntry(state.overrides.working, profile, id)) ?? {};
		if (getEntry(state.overrides.working, 'base', id)?.removed) {
			entry.removed = false; // base removes it — profile explicitly restores
		} else {
			delete entry.removed;
		}
		patches.push({ profile, id, entry });
	}
	if (!patches.length) return false;
	return applyPatches(patches, { label: 'restore element' });
}

// ---------------------------------------------------------------------------
// Editor-created element operations
// ---------------------------------------------------------------------------

/** null if valid, otherwise a human-readable reason. */
export function validateElementId(id, { allowExisting = null } = {}) {
	if (!id || !id.trim()) return 'Name is required.';
	if (isTemporaryContainerId(id) || state.temporaryContainerIds.has(id)) {
		return `“${id}” is reserved for a temporary runtime Container. Choose a unique name.`;
	}
	if (!/^[A-Za-z0-9_.-]+$/.test(id)) return 'Use only letters, digits, ".", "-" and "_".';
	if (id !== allowExisting) {
		if (isSpawnedId(id)) {
			const hiddenEverywhere = PROFILES
				.filter((profile) => profile !== 'base')
				.every((profile) => removedIn(id, profile));
			if (hiddenEverywhere) {
				return `"${id}" is hidden in all layouts, not deleted. Search its exact name or enable the "removed" filter to restore it, or choose "Delete permanently" to release the name.`;
			}
			return `"${id}" is already used by another editor element.`;
		}
		if (state.tree.some((node) => node.id === id)) return `"${id}" is already used by a game element.`;
	}
	return null;
}

export function addSpawnedElement(def, baseEntry = null) {
	const problem = validateElementId(def?.id);
	if (problem) {
		toast(problem, 'error', 7000);
		return false;
	}
	if (isUnsafeLayoutParent(def?.parentId)) {
		toast('Choose the Pixi stage or a named parent. Temporary container slots cannot be saved.', 'error', 7000);
		return false;
	}
	const patches = [{ element: true, id: def.id, def }];
	if (baseEntry) patches.push({ profile: 'base', id: def.id, entry: baseEntry });
	applyPatches(patches, { label: `add ${def.kind}` });
	return true;
}

export function updateSpawnedDef(id, changes, label = 'edit element') {
	const def = getSpawnedDef(id);
	if (!def) return;
	applyPatches([{ element: true, id, def: { ...clone(def), ...changes } }], { label });
}

const prepareReparentEntry = async (id, parentId, profile) => {
	const prepared = await bridgeRequest('prepareReparent', { id, parentId, profile });
	if (!prepared?.ok || !prepared.entry) throw new Error(prepared?.error || 'The target parent is unavailable.');
	return prepared.entry;
};

/** Reparent while preserving the current edit target's world appearance. */
export async function reparentSpawnedElement(id, parentId) {
	const def = getSpawnedDef(id);
	if (!def) return false;
	if (isUnsafeLayoutParent(parentId)) {
		toast('Choose the Pixi stage or a named parent. Temporary container slots cannot be saved.', 'error', 7000);
		return false;
	}
	const profile = activeScopeProfile();
	try {
		const entry = await prepareReparentEntry(id, parentId, profile);
		applyPatches([
			{ element: true, id, def: { ...clone(def), parentId: parentId || null } },
			{ profile, id, entry },
		], { label: 'reparent element' });
		return true;
	} catch (error) {
		toast(`Could not reparent "${id}": ${error.message ?? error}`, 'error', 7000);
		return false;
	}
}

export async function deleteSpawnedElement(id, { deleteChildren = false } = {}) {
	const def = getSpawnedDef(id);
	if (!def) return;
	const patches = [];
	const removeIds = [id];
	if (deleteChildren) {
		// collect all spawned descendants
		const collect = (parentId) => {
			for (const child of state.overrides.working.elements ?? []) {
				if (child.parentId === parentId) {
					removeIds.push(child.id);
					collect(child.id);
				}
			}
		};
		collect(id);
	} else {
		// children of a deleted container are reparented to its parent
		const profile = activeScopeProfile();
		const survivingParentId = isUnsafeLayoutParent(def.parentId) ? null : (def.parentId ?? null);
		for (const child of state.overrides.working.elements ?? []) {
			if (child.parentId === id) {
				let entry;
				try {
					entry = await prepareReparentEntry(child.id, survivingParentId, profile);
				} catch (error) {
					toast(`Could not preserve child "${child.id}": ${error.message ?? error}`, 'error', 7000);
					return false;
				}
				patches.push({
					element: true,
					id: child.id,
					def: { ...clone(child), parentId: survivingParentId },
				});
				patches.push({ profile, id: child.id, entry });
			}
		}
	}
	for (const removeId of removeIds) {
		patches.push({ element: true, id: removeId, def: null });
		for (const profile of PROFILES) {
			if (getEntry(state.overrides.working, profile, removeId))
				patches.push({ profile, id: removeId, entry: null });
		}
	}
	const legacyCleanup = isUnsafeLayoutParent(id) || isUnsafeLayoutParent(def.parentId);
	if (!applyPatches(patches, { label: 'delete element' })) return false;
	if (legacyCleanup) state.undo.at(-1).legacyCleanup = true;
	if (removeIds.includes(state.selection)) {
		state.selection = null;
		state.values = null;
		emit('selection');
	}
	return true;
}

export function renameSpawnedElement(oldId, newId) {
	const def = getSpawnedDef(oldId);
	if (!def) return false;
	const problem = validateElementId(newId, { allowExisting: oldId });
	if (problem) {
		toast(problem, 'error');
		return false;
	}
	const legacyUnsafeParent = isUnsafeLayoutParent(def.parentId);
	const nextParentId = legacyUnsafeParent ? null : def.parentId;
	const patches = [
		{ element: true, id: oldId, def: null },
		{ element: true, id: newId, def: { ...clone(def), id: newId, parentId: nextParentId } },
	];
	for (const child of state.overrides.working.elements ?? []) {
		if (child.parentId === oldId && child.id !== oldId) {
			patches.push({ element: true, id: child.id, def: { ...clone(child), parentId: newId } });
		}
	}
	for (const profile of PROFILES) {
		const entry = getEntry(state.overrides.working, profile, oldId);
		if (entry) {
			patches.push({ profile, id: oldId, entry: null });
			patches.push({ profile, id: newId, entry: clone(entry) });
		}
	}
	const legacyCleanup = isUnsafeLayoutParent(oldId) || legacyUnsafeParent;
	if (!applyPatches(patches, { label: 'rename element' })) return false;
	if (legacyCleanup) state.undo.at(-1).legacyCleanup = true;
	if (state.selection === oldId) {
		state.selection = newId;
		emit('selection');
	}
	return true;
}

export function duplicateSpawnedElement(id) {
	const def = getSpawnedDef(id);
	if (!def) return null;
	let newId = `${id}-copy`;
	let counter = 2;
	while (validateElementId(newId)) newId = `${id}-copy${counter++}`;
	const offsetEntry = (source, fillMissing = false) => {
		const entry = clone(source) ?? {};
		const responsive = entry.responsive;
		if (responsive && typeof responsive === 'object') {
			if (responsive.x) responsive.x.offset = (responsive.x.offset ?? 0) + 24;
			else if (responsive.stretchX) {
				responsive.stretchX.m0 = (responsive.stretchX.m0 ?? 0) + 24;
				responsive.stretchX.m1 = (responsive.stretchX.m1 ?? 0) - 24;
			} else if (fillMissing || Object.hasOwn(entry, 'x')) entry.x = (entry.x ?? 0) + 24;
			if (responsive.y) responsive.y.offset = (responsive.y.offset ?? 0) + 24;
			else if (responsive.stretchY) {
				responsive.stretchY.m0 = (responsive.stretchY.m0 ?? 0) + 24;
				responsive.stretchY.m1 = (responsive.stretchY.m1 ?? 0) - 24;
			} else if (fillMissing || Object.hasOwn(entry, 'y')) entry.y = (entry.y ?? 0) + 24;
		} else {
			if (fillMissing || Object.hasOwn(entry, 'x')) entry.x = (entry.x ?? 0) + 24;
			if (fillMissing || Object.hasOwn(entry, 'y')) entry.y = (entry.y ?? 0) + 24;
		}
		return entry;
	};
	const patches = [{ element: true, id: newId, def: { ...clone(def), id: newId } }];
	for (const profile of PROFILES) {
		const entry = getEntry(state.overrides.working, profile, id);
		if (entry) patches.push({ profile, id: newId, entry: offsetEntry(entry, profile === 'base') });
	}
	// offset the copy slightly so it doesn't sit exactly on the original
	const baseIndex = patches.findIndex((p) => p.profile === 'base' && p.id === newId);
	if (baseIndex < 0) patches.push({ profile: 'base', id: newId, entry: { x: 24, y: 24 } });
	if (!applyPatches(patches, { label: 'duplicate element' })) return null;
	return newId;
}

// ---------------------------------------------------------------------------
// Diff (change summary before save)
// ---------------------------------------------------------------------------

export function diffOverrides(saved, working) {
	const rows = [];
	// editor-created elements
	const savedDefs = new Map((saved.elements ?? []).map((element) => [element.id, element]));
	const workingDefs = new Map((working.elements ?? []).map((element) => [element.id, element]));
	for (const id of new Set([...savedDefs.keys(), ...workingDefs.keys()])) {
		const from = savedDefs.get(id);
		const to = workingDefs.get(id);
		if (JSON.stringify(from) === JSON.stringify(to)) continue;
		const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
		const props = [];
		for (const key of keys) {
			if (key === 'id') continue;
			if (JSON.stringify(from?.[key]) !== JSON.stringify(to?.[key]))
				props.push({ key, from: from?.[key], to: to?.[key] });
		}
		rows.push({ profile: 'element', id, kind: !from ? 'added' : !to ? 'removed' : 'changed', props });
	}
	const profiles = new Set([...Object.keys(saved.profiles ?? {}), ...Object.keys(working.profiles ?? {})]);
	for (const profile of profiles) {
		const savedMap = saved.profiles?.[profile] ?? {};
		const workingMap = working.profiles?.[profile] ?? {};
		const ids = new Set([...Object.keys(savedMap), ...Object.keys(workingMap)]);
		for (const id of ids) {
			const from = savedMap[id];
			const to = workingMap[id];
			if (JSON.stringify(from) === JSON.stringify(to)) continue;
			const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
			const props = [];
			for (const key of keys) {
				const a = from?.[key];
				const b = to?.[key];
				if (JSON.stringify(a) !== JSON.stringify(b)) props.push({ key, from: a, to: b });
			}
			rows.push({ profile, id, kind: !from ? 'added' : !to ? 'removed' : 'changed', props });
		}
	}
	return rows;
}

export const unsavedCount = () =>
	diffOverrides(state.overrides.saved, state.overrides.working).length;

/** True when an element has any override in the given profile of working data. */
export const hasOverride = (id, profile) => !!getEntry(state.overrides.working, profile, id);
