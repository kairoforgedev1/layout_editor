import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
	new URL('../src/renderer/js/treeFilters.js', import.meta.url),
	'utf8',
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { matchesTreeFilters, mergePersistedElementNodes } = await import(moduleUrl);

const baseFilters = () => ({
	text: '',
	types: new Set(),
	visibleOnly: false,
	overriddenOnly: false,
	showRemoved: false,
});

test('an exact tree search reveals a hidden reserved id despite other filters', () => {
	const filters = baseFilters();
	filters.text = 'logo';
	filters.visibleOnly = true;
	filters.types.add('container');

	assert.equal(
		matchesTreeFilters(
			{ id: 'logo', type: 'sprite', worldVisible: false },
			filters,
			{ removed: true, hasOverride: true },
		),
		true,
	);
});

test('removed elements remain hidden during ordinary browsing and appear in the removed filter', () => {
	const node = { id: 'logo', type: 'sprite', worldVisible: false };
	const filters = baseFilters();
	assert.equal(matchesTreeFilters(node, filters, { removed: true }), false);

	filters.showRemoved = true;
	assert.equal(matchesTreeFilters(node, filters, { removed: true }), true);
});

test('persisted editor elements stay discoverable when no runtime node mounted', () => {
	const nodes = mergePersistedElementNodes([], [
		{
			id: 'logo',
			kind: 'sprite',
			parentId: 'missingGameContainer',
			assetKey: 'logo.png',
		},
	]);

	assert.deepEqual(nodes, [
		{
			id: 'logo',
			name: 'logo',
			type: 'sprite',
			parentId: null,
			order: Number.MAX_SAFE_INTEGER,
			visible: false,
			worldVisible: false,
			spawned: true,
			definitionId: 'logo',
			identityStable: true,
			persistedOnly: true,
			ownershipConflict: false,
		},
	]);
	assert.equal(
		matchesTreeFilters(nodes[0], { ...baseFilters(), text: 'logo' }, { removed: true }),
		true,
	);
});

test('a detached persisted Spine element keeps its Spine hierarchy type', () => {
	const nodes = mergePersistedElementNodes([], [
		{
			id: 'celebration',
			kind: 'spine',
			assetKey: 'bigwin',
			animationName: 'idle',
			loop: true,
		},
	]);

	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].type, 'spine');
	assert.equal(nodes[0].persistedOnly, true);
});

test('a game node with the same id does not hide a saved editor definition', () => {
	const nodes = mergePersistedElementNodes(
		[
			{
				id: 'logo',
				type: 'container',
				parentId: null,
				spawned: false,
				identityStable: true,
			},
		],
		[{ id: 'logo', kind: 'sprite', parentId: null, assetKey: 'logo.png' }],
	);

	assert.equal(nodes.length, 2);
	assert.equal(nodes[0].spawned, false);
	assert.deepEqual(nodes[1], {
		id: 'logo',
		name: 'logo',
		type: 'sprite',
		parentId: null,
		order: Number.MAX_SAFE_INTEGER,
		visible: false,
		worldVisible: false,
		spawned: true,
		definitionId: 'logo',
		identityStable: true,
		persistedOnly: true,
		ownershipConflict: true,
	});
});

test('a suffixed spawned runtime node is matched through its definition id', () => {
	const runtime = {
		id: 'logo#2',
		type: 'sprite',
		spawned: true,
		definitionId: 'logo',
	};
	const nodes = mergePersistedElementNodes(
		[runtime],
		[{ id: 'logo', kind: 'sprite', parentId: null, assetKey: 'logo.png' }],
	);
	assert.deepEqual(nodes, [runtime]);
});
