import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const identitySource = await readFile(
	new URL('../src/shared/layoutIdentity.js', import.meta.url),
	'utf8',
);
const identityUrl = moduleUrl(identitySource);

const importSourceModule = async (relativePath, replacements = []) => {
	let source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
	for (const [from, to] of replacements) source = source.replace(from, to);
	return import(moduleUrl(source));
};

const {
	buildParentOptions,
	contextualParentOption,
	recommendedParentValue,
	parentHelpText,
	GLOBAL_STAGE_PARENT,
} = await importSourceModule('../src/renderer/js/elementParents.js', [
	["'../../shared/layoutIdentity.js'", `'${identityUrl}'`],
]);

const {
	isTemporaryContainerId,
	isTemporaryLayoutContainer,
} = await import(identityUrl);

const {
	editorDefinitionId,
	editorDefinitionForNode,
	hasRuntimeIdentityConflict,
} = await importSourceModule('../src/renderer/js/elementOwnership.js');

test('parent choices include only explicit game targets and describe stage attachment honestly', () => {
	const options = buildParentOptions({
		definitions: [{ id: 'logo_container', kind: 'container', parentId: null }],
		liveNodes: [
			{ id: 'container#59', type: 'container', identityStable: false, spawned: false },
			{
				id: 'uiFadeGroup',
				type: 'container',
				identityStable: true,
				spawned: false,
				parentTarget: {
					label: 'Stake UI — fade group',
					description: 'Follows the native UI hide/show events.',
					order: 20,
				},
			},
			{
				id: 'uiLogoSlot',
				type: 'container',
				identityStable: true,
				spawned: false,
				parentTarget: {
					label: 'Stake UI — logo slot',
					description: 'Uses the native responsive logo position.',
					order: 30,
					childDefaults: {
						x: 0,
						y: 0,
						anchorX: 1,
						anchorY: 0,
						unsupported: 42,
					},
				},
			},
			{
				id: 'gameContent',
				type: 'container',
				identityStable: true,
				spawned: false,
				parentTarget: {
					label: 'Game content',
					description: 'Uses Stake MainContainer game coordinates.',
					order: 10,
				},
			},
			{
				id: 'safeGraphicsHost',
				type: 'graphics',
				identityStable: true,
				spawned: false,
				parentTarget: {
					label: 'Graphics overlay host',
					description: 'A stable Graphics node that explicitly accepts editor children.',
					order: 15,
				},
			},
			{ id: 'i18nTest', type: 'container', identityStable: true, spawned: false },
			{
				id: 'container#12',
				type: 'container',
				identityStable: true,
				spawned: false,
				parentTarget: {
					label: 'Unsafe automatic target',
					description: 'Must still be excluded.',
					order: 1,
				},
			},
			{ id: 'logo_container', type: 'container', identityStable: true, spawned: true },
		],
	});

	assert.deepEqual(
		options.map((option) => option.value),
		[GLOBAL_STAGE_PARENT, 'logo_container', 'gameContent', 'safeGraphicsHost', 'uiFadeGroup', 'uiLogoSlot'],
	);
	assert.match(options[0].label, /persistent attachment/i);
	assert.match(parentHelpText(options[0]), /overlays can still cover/i);
	assert.equal(options[5].label, 'Stake UI — logo slot');
	assert.equal(parentHelpText(options[5]), 'Uses the native responsive logo position.');
	assert.deepEqual(options[5].childDefaults, { x: 0, y: 0, anchorX: 1, anchorY: 0 });
	assert.equal(recommendedParentValue(options), GLOBAL_STAGE_PARENT);
});

test('the selected offered container is recommended and malformed target metadata is ignored', () => {
	const options = buildParentOptions({
		definitions: [{ id: 'logo_container', kind: 'container' }],
		liveNodes: [{
			id: 'missingDescription',
			type: 'container',
			identityStable: true,
			parentTarget: { label: 'Incomplete target', order: 1 },
		}],
	});
	assert.equal(recommendedParentValue(options, 'logo_container'), 'logo_container');
	assert.equal(recommendedParentValue(options, 'missingDescription'), GLOBAL_STAGE_PARENT);
});

test('a hierarchy context action can target the exact live Graphics object with an instability warning', () => {
	const option = contextualParentOption({
		id: 'Graphics#15',
		type: 'graphics',
		identityStable: false,
	});
	assert.equal(option.value, 'Graphics#15');
	assert.equal(option.kind, 'context');
	assert.equal(option.unsafe, true);
	assert.match(option.description, /exact live object/i);
	assert.match(option.description, /unique Pixi label/i);
	assert.equal(contextualParentOption({ id: 'logo', type: 'sprite' }), null);
});

test('temporary Container slots are read-only without making their stable children temporary', () => {
	for (const id of ['container#1', 'container#3', 'container#99']) {
		assert.equal(isTemporaryContainerId(id), true);
		assert.equal(
			isTemporaryLayoutContainer({ id, type: 'container', identityStable: true }),
			true,
			`${id} must remain temporary even if stale metadata claims its identity is stable`,
		);
		assert.equal(
			contextualParentOption({ id, type: 'container', identityStable: false }),
			null,
			`${id} must not be offered as a persistent parent`,
		);
	}

	assert.equal(
		isTemporaryLayoutContainer({ id: 'container', type: 'container', identityStable: false }),
		true,
		'the first anonymous Container slot has no numeric suffix but is still temporary',
	);
	assert.equal(isTemporaryContainerId('container'), false);
	assert.equal(isTemporaryContainerId('Graphics#3'), false);

	const stableChild = {
		id: 'bonusContent',
		type: 'container',
		parentId: 'container#3',
		identityStable: true,
	};
	assert.equal(isTemporaryLayoutContainer(stableChild), false);
	const stableChildOption = contextualParentOption(stableChild);
	assert.equal(stableChildOption?.value, 'bonusContent');
	assert.equal(stableChildOption?.kind, 'context');
	assert.equal(stableChildOption?.unsafe, false);

	assert.equal(
		isTemporaryLayoutContainer({
			id: 'container#3',
			type: 'container',
			spawned: true,
			identityStable: true,
		}),
		true,
		'the reserved numbered-container namespace stays unsafe even in legacy editor data',
	);
	assert.equal(
		buildParentOptions({ definitions: [{ id: 'container#3', kind: 'container' }] })
			.some(({ value }) => value === 'container#3'),
		false,
	);
});

test('runtime ownership uses the persisted definition id instead of a suffixed Pixi id', () => {
	const node = { id: 'logo#2', spawned: true, definitionId: 'logo' };
	const definitions = [{ id: 'logo', kind: 'sprite' }];
	assert.equal(editorDefinitionId(node), 'logo');
	assert.equal(editorDefinitionForNode(node, definitions), definitions[0]);
	assert.equal(hasRuntimeIdentityConflict(node), true);
	assert.equal(editorDefinitionForNode({ id: 'logo', spawned: false }, definitions), null);
});
