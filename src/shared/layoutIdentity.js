/** Automatic anonymous Container slots are runtime structure, never persisted identity. */
const NUMBERED_CONTAINER_ID = /^container#\d+$/;

export function isTemporaryLayoutContainer(value) {
	const id = typeof value === 'string' ? value : value?.id;
	const type = typeof value === 'string' ? 'container' : value?.type;
	if (type !== 'container' || typeof id !== 'string') return false;
	return value?.identityStable === false || NUMBERED_CONTAINER_ID.test(id);
}

export function isTemporaryContainerId(id) {
	return typeof id === 'string' && NUMBERED_CONTAINER_ID.test(id);
}
