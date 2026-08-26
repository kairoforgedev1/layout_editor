import { isTemporaryLayoutContainer } from '../../shared/layoutIdentity.js';

export const GLOBAL_STAGE_PARENT = '__stage__';

const STAGE_OPTION = {
	value: GLOBAL_STAGE_PARENT,
	label: 'Pixi stage — persistent attachment',
	description:
		'Attaches directly to the Pixi stage and stays mounted while the game runs. Loading, transition, or feature overlays can still cover it.',
	kind: 'global',
	order: Number.NEGATIVE_INFINITY,
};

const automaticMountId = (id) => /#\d+$/.test(id ?? '');

/**
 * Build the exact parent choice requested from a hierarchy right-click. Unlike
 * the normal picker catalog, this may represent an automatic runtime id. It is
 * deliberately offered only for that explicit context action and carries a
 * persistence warning instead of silently falling back to the Pixi stage.
 */
export function contextualParentOption(node) {
	if (
		!node?.id ||
		!['container', 'graphics'].includes(node.type) ||
		node.persistedOnly ||
		isTemporaryLayoutContainer(node)
	) return null;
	const unstable = node.identityStable === false || automaticMountId(node.id);
	return {
		value: node.id,
		label: `${node.id} — right-clicked ${node.type}`,
		description: unstable
			? 'Uses this exact live object now. Its automatic runtime id can change after a reload; add a unique Pixi label for a durable saved parent.'
			: 'Uses the exact live object selected from the Layout tree as the new element’s parent.',
		kind: 'context',
		order: 0,
		unsafe: unstable,
	};
}

const targetChildDefaults = (metadata) => {
	const defaults = {};
	for (const key of ['x', 'y', 'anchorX', 'anchorY']) {
		if (Number.isFinite(metadata?.childDefaults?.[key])) {
			defaults[key] = metadata.childDefaults[key];
		}
	}
	return defaults;
};

const gameParentTarget = (node) => {
	const metadata = node?.parentTarget;
	if (
		!metadata ||
		typeof metadata !== 'object' ||
		typeof metadata.label !== 'string' ||
		!metadata.label.trim() ||
		typeof metadata.description !== 'string' ||
		!metadata.description.trim() ||
		!Number.isFinite(metadata.order)
	) return null;
	return {
		label: metadata.label.trim(),
		description: metadata.description.trim(),
		order: metadata.order,
		childDefaults: targetChildDefaults(metadata),
	};
};

/**
 * Build safe parent choices for editor-created elements.
 *
 * Automatic mount-order ids such as `container#59` are intentionally excluded:
 * they can refer to a different object after a reload. Source/game containers
 * must opt in with truthful `parentTarget` metadata supplied by the game bridge;
 * a stable-looking label alone is not enough to make a safe parent contract.
 */
export function buildParentOptions({
	definitions = [],
	liveNodes = [],
	excludeId = null,
} = {}) {
	const options = [{ ...STAGE_OPTION }];
	const used = new Set([GLOBAL_STAGE_PARENT, excludeId].filter(Boolean));

	for (const definition of definitions) {
		if (
			definition?.kind !== 'container' ||
			!definition.id ||
			automaticMountId(definition.id) ||
			used.has(definition.id)
		) continue;
		used.add(definition.id);
		options.push({
			value: definition.id,
			label: `${definition.id} — editor container`,
			description:
				'Editor-created container. Children inherit its transforms and the mounting lifecycle of the game parent it belongs to.',
			kind: 'editor',
			order: 0,
		});
	}

	const gameOptions = [];
	for (const node of liveNodes) {
		const target = gameParentTarget(node);
		if (
			!['container', 'graphics'].includes(node?.type) ||
			!node.id ||
			node.spawned === true ||
			node.identityStable === false ||
			automaticMountId(node.id) ||
			!target ||
			used.has(node.id)
		) continue;
		used.add(node.id);
		gameOptions.push({
			value: node.id,
			label: target.label,
			description: target.description,
			kind: 'game',
			order: target.order,
			childDefaults: target.childDefaults,
		});
	}
	gameOptions.sort((a, b) => {
		if (a.order !== b.order) return a.order - b.order;
		return a.label.localeCompare(b.label);
	});
	options.push(...gameOptions);
	return options;
}

/** Prefer an explicitly selected offered container; otherwise attach to stage. */
export function recommendedParentValue(options, selectedId = null) {
	if (selectedId && options.some((option) => option.value === selectedId)) return selectedId;
	return GLOBAL_STAGE_PARENT;
}

export function parentHelpText(option) {
	return option?.description ??
		'This parent has no lifecycle description. Choose an explicitly supported parent before saving.';
}
