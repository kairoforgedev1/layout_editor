/**
 * Tree filtering kept separate from DOM rendering so hidden-name discovery can
 * be regression tested. An exact id search always wins: a reserved hidden name
 * must never become impossible to find because another filter excludes it.
 */
export function matchesTreeFilters(
	node,
	filters,
	{ removed = false, hasOverride = false } = {},
) {
	const query = (filters.text ?? '').trim().toLowerCase();
	if (query && node.id.toLowerCase() === query) return true;

	if (filters.showRemoved) {
		if (!removed) return false;
	} else if (removed) {
		return false;
	}
	if (
		query &&
		!node.id.toLowerCase().includes(query) &&
		!(node.textPreview ?? '').toLowerCase().includes(query)
	) return false;
	if (filters.types.size && !filters.types.has(node.type)) return false;
	if (filters.visibleOnly && !node.worldVisible) return false;
	if (filters.overriddenOnly && !hasOverride) return false;
	return true;
}

/**
 * Saved editor-created elements must remain manageable even when the preview
 * failed to instantiate them or their game-owned parent is not mounted.
 */
export function mergePersistedElementNodes(liveNodes = [], definitions = []) {
	const nodes = [...liveNodes];
	const knownIds = new Set(nodes.map((node) => node.id));
	const definitionIds = new Set(definitions.map((definition) => definition?.id).filter(Boolean));
	const mountedDefinitionIds = new Set(
		nodes
			.filter((node) => node?.spawned === true)
			.map((node) => node.definitionId ?? node.id)
			.filter(Boolean),
	);

	for (const definition of definitions) {
		if (!definition?.id || mountedDefinitionIds.has(definition.id)) continue;
		const parentId =
			definition.parentId &&
			(knownIds.has(definition.parentId) || definitionIds.has(definition.parentId))
				? definition.parentId
				: null;
		nodes.push({
			id: definition.id,
			name: definition.id,
			type:
				definition.kind === 'container'
					? 'container'
					: definition.kind === 'spine'
						? 'spine'
						: 'sprite',
			parentId,
			order: Number.MAX_SAFE_INTEGER,
			visible: false,
			worldVisible: false,
			spawned: true,
			definitionId: definition.id,
			identityStable: true,
			persistedOnly: true,
			ownershipConflict: knownIds.has(definition.id),
		});
		knownIds.add(definition.id);
	}

	return nodes;
}
