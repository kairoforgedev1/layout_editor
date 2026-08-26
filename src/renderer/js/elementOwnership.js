/** Return the persisted editor definition id represented by a runtime/tree row. */
export function editorDefinitionId(node) {
	if (!node || (node.spawned !== true && node.persistedOnly !== true)) return null;
	const id = node.definitionId ?? node.id;
	return typeof id === 'string' && id ? id : null;
}

export function editorDefinitionForNode(node, definitions = []) {
	const id = editorDefinitionId(node);
	return id ? (definitions.find((definition) => definition?.id === id) ?? null) : null;
}

/**
 * Pixi suffixes a duplicate runtime id (for example `logo` -> `logo#2`).
 * Such an element is still editor-owned, but geometry edits must be blocked
 * until the name conflict is resolved because overrides are keyed by definition.
 */
export function hasRuntimeIdentityConflict(node) {
	const definitionId = editorDefinitionId(node);
	return !!definitionId && !node?.persistedOnly && node.id !== definitionId;
}
