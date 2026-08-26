/** Remove-element dialog: profile/all-layouts removal for any element, plus
 *  permanent deletion (with child handling) for editor-created elements. */
import { state, toast } from './state.js';
import { showModal } from './dialogs.js';
import {
	removeElement,
	restoreElement,
	deleteSpawnedElement,
	isUnsafeLayoutParent,
	removalState,
} from './overrides.js';
import { editorDefinitionForNode } from './elementOwnership.js';
import {
	isTemporaryContainerId,
	isTemporaryLayoutContainer,
} from '../../shared/layoutIdentity.js';

const childCount = (runtimeId, definitionId = runtimeId) => {
	const spawnedChildren = (state.overrides.working.elements ?? [])
		.filter((element) => element.parentId === definitionId).length;
	const treeChildren = state.tree.filter((node) => node.parentId === runtimeId).length;
	return Math.max(spawnedChildren, treeChildren);
};

export async function showRemoveDialog(id, nodeHint = null) {
	if (!id) return;
	const liveNode = state.tree.find((node) => node.id === id);
	const detachedHint = !liveNode
		? { id, definitionId: id, spawned: true, persistedOnly: true }
		: null;
	const node = nodeHint ?? liveNode ?? detachedHint;
	const spawnedDef = editorDefinitionForNode(
		node,
		state.overrides.working.elements ?? [],
	);
	const legacyTemporaryDef = !!spawnedDef && (
		isTemporaryContainerId(spawnedDef.id) ||
		state.temporaryContainerIds.has(spawnedDef.id) ||
		isTemporaryLayoutContainer(node)
	);
	if (!spawnedDef && (state.temporaryContainerIds.has(id) || isTemporaryLayoutContainer(node))) {
		await showModal({
			title: 'Temporary runtime group',
			body:
				`"${id}" is a temporary runtime Container slot, so hiding or deleting it could affect a different object after a mode or screen change. Select a named child instead. No removal was recorded.`,
			buttons: [{ label: 'OK', value: null, primary: true }],
		});
		return;
	}
	const actionId = spawnedDef?.id ?? id;
	const children = childCount(id, actionId);
	const activeProfile = state.preview.layoutType ?? 'desktop';
	const status = removalState(actionId);

	if (!spawnedDef && node?.identityStable === false) {
		await showModal({
			title: 'Stable element name required',
			body:
				`"${id}" is an automatic mount-order name, so it can identify a different element ` +
				'when the standalone game reloads. Add a unique Pixi label to this element in the game code, ' +
				'then reload the editor before removing it. No removal was recorded.',
			buttons: [{ label: 'OK', value: null, primary: true }],
		});
		return;
	}

	const wrap = document.createElement('div');
	const info = document.createElement('p');
	info.style.marginTop = '0';
	info.innerHTML =
		`${legacyTemporaryDef ? 'Delete legacy editor element' : spawnedDef ? 'Delete or hide editor element' : 'Hide from the standalone game'} <b></b> ` +
		`<span class="dim">(${node?.type ?? spawnedDef?.kind ?? 'element'}, ` +
		`${spawnedDef ? 'created with the editor' : 'defined by the game code'}` +
		`${children ? `, ${children} child element(s)` : ''})</span>`;
	info.querySelector('b').textContent = actionId;
	wrap.appendChild(info);

	if (children && !spawnedDef) {
		const note = document.createElement('p');
		note.className = 'dim';
		note.textContent =
			'Hiding this game container suppresses it and everything inside it in editor and standalone runs. The source component remains intact.';
		wrap.appendChild(note);
	}

	// options
	const options = [];
	const addOption = (value, label, description, checked = false) => {
		const row = document.createElement('label');
		row.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin:4px 0;cursor:pointer;';
		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = 'remove-scope';
		radio.value = value;
		radio.checked = checked;
		row.appendChild(radio);
		const text = document.createElement('span');
		text.innerHTML = `<b>${label}</b> <span class="dim">— ${description}</span>`;
		row.appendChild(text);
		wrap.appendChild(row);
		options.push(radio);
	};

	if (!legacyTemporaryDef) {
		addOption(
			'profile',
			`Hide only in "${activeProfile}"`,
			spawnedDef
				? 'keeps the element and its name in project data; visible in other profiles'
				: 'persists to the standalone game; stays visible in the other layout profiles',
			!spawnedDef,
		);
		addOption(
			'all',
			'Hide in all layouts',
			spawnedDef
				? 'keeps the element and reserves its name so it can be restored later'
				: 'suppresses the element in editor and standalone runs; game source stays intact and it remains restorable',
			false,
		);
	}
	if (spawnedDef) {
		addOption(
			'permanent',
			'Delete permanently',
			'removes the editor-created element and all its layout data; its name becomes reusable',
			true,
		);
	}

	// child handling for permanent deletion of an editor container
	let childSelect = null;
	if (spawnedDef && children) {
		const unsafeSurvivingParent = isUnsafeLayoutParent(spawnedDef.parentId);
		const childRow = document.createElement('div');
		childRow.className = 'prop-row';
		childRow.style.marginTop = '8px';
		childRow.innerHTML = '<label style="width:auto">On permanent delete, children:</label>';
		childSelect = document.createElement('select');
		const reparentLabel = unsafeSurvivingParent
			? 'move to the Pixi stage (saved parent is temporary)'
			: 'move to this element’s parent';
		for (const [value, label] of [
			['reparent', reparentLabel],
			['delete', 'delete them too'],
		]) {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = label;
			childSelect.appendChild(opt);
		}
		childRow.appendChild(childSelect);
		wrap.appendChild(childRow);
		const reparentNote = document.createElement('p');
		reparentNote.className = 'dim';
		reparentNote.textContent =
			'Parent relationships are global. Moving children preserves their current edit-target geometry; review their other layout profiles after deletion.';
		wrap.appendChild(reparentNote);
	}

	if (status.base || status.profiles.length) {
		const already = document.createElement('p');
		already.className = 'dim';
		already.textContent = status.base
			? 'This element is already removed from all layouts.'
			: `Already removed in: ${status.profiles.join(', ')}.`;
		wrap.appendChild(already);
	}

	const choice = await showModal({
		title: legacyTemporaryDef
			? 'Delete legacy editor element'
			: spawnedDef ? 'Remove editor element' : 'Hide from standalone game',
		body: wrap,
		buttons: [
			{ label: 'Cancel', value: null },
			{ label: 'Apply', value: 'go', primary: true },
		],
	});
	if (choice !== 'go') return;

	const scope = options.find((radio) => radio.checked)?.value;
	if (scope === 'permanent') {
		const deleted = await deleteSpawnedElement(actionId, { deleteChildren: childSelect?.value === 'delete' });
		if (deleted) toast(`Deleted "${actionId}" permanently (undo restores it until you save).`, 'ok');
	} else if (scope === 'all' || scope === 'profile') {
		if (!removeElement(actionId, scope)) return;
		if (spawnedDef) {
			toast(
				scope === 'all'
					? `Hidden "${actionId}" in all layouts — its name stays reserved until permanent deletion.`
					: `Hidden "${actionId}" in "${activeProfile}" only.`,
				'ok',
			);
			return;
		}
		toast(
			scope === 'all'
				? `Hidden "${actionId}" from the standalone game in all layouts — restore it via the "removed" filter or Undo.`
				: `Hidden "${actionId}" from the standalone game in "${activeProfile}" only.`,
			'ok',
		);
	}
}

export function restoreElementUi(id, scope) {
	if (!restoreElement(id, scope)) return;
	toast(scope === 'all' ? `Restored "${id}" in all layouts.` : `Restored "${id}" for this profile.`, 'ok');
}
