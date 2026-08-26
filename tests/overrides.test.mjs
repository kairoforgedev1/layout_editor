import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

// Load the renderer module graph as data URLs so its browser-targeted .js files
// execute as ESM under Node without changing the application's package type.
const identitySource = await readFile(
	new URL('../src/shared/layoutIdentity.js', import.meta.url),
	'utf8',
);
const identityUrl = moduleUrl(identitySource);
const stateSource = (await readFile(
	new URL('../src/renderer/js/state.js', import.meta.url),
	'utf8',
)).replace(
	/export function toast\([\s\S]*?\r?\n}\r?\n\r?\nexport function log/,
	'export function toast() {}\n\nexport function log',
);
const stateUrl = moduleUrl(stateSource);
const bridgeSource = (await readFile(
	new URL('../src/renderer/js/bridge.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'../../shared/layoutIdentity.js'", `'${identityUrl}'`);
const bridgeUrl = moduleUrl(bridgeSource);
const overridesSource = (await readFile(
	new URL('../src/renderer/js/overrides.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'./bridge.js'", `'${bridgeUrl}'`)
	.replace("'../../shared/layoutIdentity.js'", `'${identityUrl}'`);

const [{
	state,
}, {
	addSpawnedElement,
	canPersistLayoutTarget,
	deleteSpawnedElement,
	duplicateSpawnedElement,
	getEntry,
	handleBridgeCommit,
	removeElement,
	renameSpawnedElement,
	reparentSpawnedElement,
	resetElement,
	setLayerOrder,
	setProp,
	undo,
	redo,
	validateElementId,
}] = await Promise.all([
	import(stateUrl),
	import(moduleUrl(overridesSource)),
]);

test('duplicating a responsive element offsets anchors and stretch margins once per profile', () => {
	state.tree = [];
	state.undo = [];
	state.redo = [];
	state.overrides.working = {
		version: 1,
		elements: [{ id: 'logo', kind: 'sprite', assetKey: 'logo' }],
		profiles: {
			base: {
				logo: {
					x: 900,
					y: 800,
					responsive: {
						x: { anchor: 0.5, offset: 3 },
						y: { anchor: 1, offset: -7 },
					},
				},
			},
			portrait: {
				logo: {
					responsive: {
						stretchX: { m0: 10, m1: 20 },
						stretchY: { m0: 30, m1: 40 },
					},
				},
			},
		},
	};

	assert.equal(duplicateSpawnedElement('logo'), 'logo-copy');
	const baseCopy = getEntry(state.overrides.working, 'base', 'logo-copy');
	const portraitCopy = getEntry(state.overrides.working, 'portrait', 'logo-copy');

	assert.deepEqual(baseCopy.responsive.x, { anchor: 0.5, offset: 27 });
	assert.deepEqual(baseCopy.responsive.y, { anchor: 1, offset: 17 });
	assert.equal(baseCopy.x, 900, 'responsive X should be moved through its offset, not a dead static field');
	assert.equal(baseCopy.y, 800, 'responsive Y should be moved through its offset, not a dead static field');
	assert.deepEqual(portraitCopy.responsive.stretchX, { m0: 34, m1: -4 });
	assert.deepEqual(portraitCopy.responsive.stretchY, { m0: 54, m1: 16 });

	// Duplication must clone before offsetting and must not apply the base offset
	// twice through the legacy base-specific path.
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'logo').responsive.x, {
		anchor: 0.5,
		offset: 3,
	});
	assert.equal(state.undo.at(-1)?.label, 'duplicate element');
});

test('a hidden editor element explains why its name is reserved, while permanent deletion releases it', async () => {
	state.tree = [];
	state.selection = null;
	state.undo = [];
	state.redo = [];
	state.overrides.working = {
		version: 1,
		elements: [{ id: 'logo', kind: 'sprite', parentId: 'logo_container', assetKey: 'logo.png' }],
		profiles: {
			base: {
				logo: { removed: true, x: 20, y: 30 },
			},
			desktop: {
				logo: { responsive: { x: { anchor: 1, offset: 0 } } },
			},
		},
	};

	assert.match(validateElementId('logo'), /hidden in all layouts, not deleted/i);
	assert.match(validateElementId('logo'), /Delete permanently/);

	assert.equal(await deleteSpawnedElement('logo'), true);
	assert.deepEqual(state.overrides.working.elements, []);
	assert.equal(getEntry(state.overrides.working, 'base', 'logo'), undefined);
	assert.equal(getEntry(state.overrides.working, 'desktop', 'logo'), undefined);
	assert.equal(validateElementId('logo'), null, 'a permanently deleted name should be reusable');
});

test('authored sprite asset replacement is scoped, resettable, and undoable', () => {
	state.tree = [{ id: 'logo', type: 'sprite', spawned: false }];
	state.undo = [];
	state.redo = [];
	state.overrides.saved = {
		version: 1,
		profiles: {
			base: { logo: { assetKey: 'logo-default.webp' } },
		},
	};
	state.overrides.working = {
		version: 1,
		profiles: {
			base: { logo: { assetKey: 'logo-default.webp' } },
		},
	};

	setProp('portrait', 'logo', 'assetKey', 'logo-portrait.webp');
	assert.equal(getEntry(state.overrides.working, 'base', 'logo').assetKey, 'logo-default.webp');
	assert.equal(getEntry(state.overrides.working, 'portrait', 'logo').assetKey, 'logo-portrait.webp');
	assert.equal(state.undo.at(-1)?.label, 'set assetKey');

	undo();
	assert.equal(getEntry(state.overrides.working, 'portrait', 'logo'), undefined);
	redo();
	assert.equal(getEntry(state.overrides.working, 'portrait', 'logo').assetKey, 'logo-portrait.webp');

	resetElement('logo', ['portrait']);
	assert.equal(getEntry(state.overrides.working, 'portrait', 'logo'), undefined);
	assert.equal(getEntry(state.overrides.working, 'base', 'logo').assetKey, 'logo-default.webp');
	assert.equal(state.undo.at(-1)?.label, 'reset element');

	undo();
	assert.equal(getEntry(state.overrides.working, 'portrait', 'logo').assetKey, 'logo-portrait.webp');
});

test('sibling layer reordering is normalized in one undoable edit', () => {
	state.undo = [];
	state.redo = [];
	state.overrides.working = { version: 1, profiles: { base: { middle: { x: 12 } } } };

	assert.equal(setLayerOrder('base', ['back', 'middle', 'front']), true);
	assert.equal(getEntry(state.overrides.working, 'base', 'back').zIndex, 0);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'middle'), { x: 12, zIndex: 1 });
	assert.equal(getEntry(state.overrides.working, 'base', 'front').zIndex, 2);
	assert.equal(state.undo.at(-1)?.label, 'reorder layers');

	undo();
	assert.equal(getEntry(state.overrides.working, 'base', 'back'), undefined);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'middle'), { x: 12 });
	assert.equal(getEntry(state.overrides.working, 'base', 'front'), undefined);
});

test('temporary Containers reject layout mutations while stable descendants remain editable', () => {
	state.selection = null;
	state.undo = [];
	state.redo = [];
	state.tree = [
		{
			id: 'container',
			type: 'container',
			parentId: null,
			identityStable: false,
			spawned: false,
		},
		{
			id: 'container#3',
			type: 'container',
			parentId: null,
			identityStable: false,
			spawned: false,
		},
		{
			id: 'bonusLogo',
			type: 'sprite',
			parentId: 'container#3',
			identityStable: true,
			spawned: false,
		},
	];
	state.overrides.working = { version: 1, profiles: {} };
	state.temporaryContainerIds.clear();
	state.temporaryContainerIds.add('container#99');
	assert.equal(
		canPersistLayoutTarget('container#98'),
		true,
		'an untyped id must not be erased merely because a non-Container may use the same label',
	);

	assert.equal(canPersistLayoutTarget('container#3'), false);
	assert.equal(canPersistLayoutTarget('container'), false);
	assert.equal(setProp('base', 'container', 'x', 99), false);
	assert.equal(setProp('base', 'container#3', 'x', 120), false);
	assert.equal(handleBridgeCommit({
		scope: 'base',
		id: 'container#3',
		before: null,
		after: { x: 120, y: 80 },
		label: 'drag',
	}), false);
	assert.equal(removeElement('container#3', 'all'), false);
	assert.equal(
		handleBridgeCommit({
			scope: 'base',
			id: 'container#99',
			before: null,
			after: { x: 1 },
			label: 'stale drag',
		}),
		false,
		'a remembered stale Container commit must be rejected after its node leaves the tree',
	);
	assert.deepEqual(state.overrides.working.profiles, {});
	assert.equal(state.undo.length, 0);

	assert.equal(canPersistLayoutTarget('bonusLogo'), true);
	assert.equal(setProp('base', 'bonusLogo', 'x', 44), true);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusLogo'), { x: 44 });
	assert.equal(state.undo.at(-1)?.label, 'set x');

	assert.equal(handleBridgeCommit({
		scope: 'base',
		id: 'bonusLogo',
		before: { x: 44 },
		after: { x: 70, y: 20 },
		label: 'drag',
	}), true);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusLogo'), { x: 70, y: 20 });
	assert.equal(state.undo.at(-1)?.label, 'drag');
	assert.match(validateElementId('container#3'), /reserved for a temporary runtime Container/i);

	state.temporaryContainerIds.add('formerAutoRoot');
	state.tree = [{
		id: 'formerAutoRoot',
		type: 'container',
		identityStable: true,
		spawned: false,
	}];
	assert.equal(
		canPersistLayoutTarget('formerAutoRoot'),
		false,
		'a runtime slot remembered from an earlier screen must stay blocked before save',
	);
	assert.equal(setProp('base', 'formerAutoRoot', 'x', 10), false);
	assert.match(validateElementId('formerAutoRoot'), /reserved for a temporary runtime Container/i);
	assert.equal(
		addSpawnedElement({ id: 'formerAutoRoot', kind: 'container', parentId: null }),
		false,
		'programmatic creation must enforce the same reserved-id policy as the dialog',
	);
	state.temporaryContainerIds.delete('formerAutoRoot');
	state.temporaryContainerIds.clear();
});

test('unsafe temporary parent ids cannot enter editor-created element definitions', async () => {
	state.selection = null;
	state.undo = [];
	state.redo = [];
	state.tree = [];
	state.overrides.working = { version: 1, profiles: {}, elements: [] };

	assert.equal(addSpawnedElement(
		{ id: 'bonusLogo', kind: 'sprite', assetKey: 'logo.png', parentId: 'container#3' },
		{ x: 10, y: 20 },
	), false);
	assert.deepEqual(state.overrides.working, { version: 1, profiles: {}, elements: [] });
	assert.equal(state.undo.length, 0, 'a rejected add must be atomic');

	state.overrides.working.elements.push({
		id: 'bonusLogo',
		kind: 'sprite',
		assetKey: 'logo.png',
		parentId: null,
	});
	assert.equal(await reparentSpawnedElement('bonusLogo', 'container#99'), false);
	assert.equal(state.overrides.working.elements[0].parentId, null);
	assert.equal(state.undo.length, 0, 'a rejected reparent must not record an edit');

	assert.equal(addSpawnedElement({
		id: 'namedRoot',
		kind: 'container',
		parentId: null,
	}), true);
	assert.equal(state.overrides.working.elements.at(-1)?.id, 'namedRoot');
	assert.equal(state.undo.at(-1)?.label, 'add container');
});

test('legacy editor Containers using reserved ids can be renamed or permanently deleted', async () => {
	state.selection = 'container#3';
	state.undo = [];
	state.redo = [];
	state.tree = [{
		id: 'container#3',
		type: 'container',
		spawned: true,
		definitionId: 'container#3',
		identityStable: false,
	}];
	state.temporaryContainerIds.clear();
	state.temporaryContainerIds.add('container#3');
	state.overrides.working = {
		version: 1,
		elements: [{ id: 'container#3', kind: 'container', parentId: null }],
		profiles: { base: { 'container#3': { x: 25, y: 30 } } },
	};

	assert.equal(renameSpawnedElement('container#3', 'bonusRoot'), true);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'container#3'), false);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'bonusRoot'), true);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusRoot'), { x: 25, y: 30 });
	assert.equal(getEntry(state.overrides.working, 'base', 'container#3'), undefined);
	assert.equal(undo(), true);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'container#3'), true);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'bonusRoot'), false);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'container#3'), { x: 25, y: 30 });
	assert.equal(redo(), true);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'bonusRoot'), true);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusRoot'), { x: 25, y: 30 });

	assert.equal(await deleteSpawnedElement('bonusRoot'), true);
	assert.equal(state.overrides.working.elements.length, 0);
	assert.equal(getEntry(state.overrides.working, 'base', 'bonusRoot'), undefined);
	assert.equal(undo(), true);
	assert.equal(state.overrides.working.elements.some(({ id }) => id === 'bonusRoot'), true);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusRoot'), { x: 25, y: 30 });
	state.temporaryContainerIds.clear();
});

test('renaming a legacy definition also repairs its temporary parent binding', () => {
	state.selection = 'container#3';
	state.undo = [];
	state.redo = [];
	state.tree = [];
	state.temporaryContainerIds.clear();
	state.temporaryContainerIds.add('container#3');
	state.temporaryContainerIds.add('container#9');
	state.overrides.working = {
		version: 1,
		elements: [{ id: 'container#3', kind: 'container', parentId: 'container#9' }],
		profiles: { base: { 'container#3': { x: 25, y: 30 } } },
	};

	assert.equal(renameSpawnedElement('container#3', 'bonusRoot'), true);
	assert.deepEqual(state.overrides.working.elements, [{
		id: 'bonusRoot',
		kind: 'container',
		parentId: null,
	}]);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'bonusRoot'), { x: 25, y: 30 });
	assert.equal(undo(), true);
	assert.deepEqual(state.overrides.working.elements, [{
		id: 'container#3',
		kind: 'container',
		parentId: 'container#9',
	}]);
	assert.deepEqual(getEntry(state.overrides.working, 'base', 'container#3'), { x: 25, y: 30 });
	state.temporaryContainerIds.clear();
});
