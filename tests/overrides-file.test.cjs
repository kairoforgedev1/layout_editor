const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeData, readOverrides, writeOverrides } = require('../src/main/overridesFile');

test('normalization only removes temporary ids supplied from typed tree metadata', () => {
	const source = {
		version: 1,
		profiles: { base: { 'container#3': { x: 10 }, logo: { x: 20 } } },
	};
	assert.deepEqual(normalizeData(source).profiles.base, source.profiles.base);
	assert.deepEqual(
		normalizeData(source, { temporaryContainerIds: ['container#3'] }).profiles.base,
		{ logo: { x: 20 } },
	);
	const bareSource = {
		version: 1,
		profiles: { base: { container: { y: 30 }, logo: { x: 20 } } },
	};
	assert.deepEqual(normalizeData(bareSource).profiles.base, bareSource.profiles.base);
	assert.deepEqual(
		normalizeData(bareSource, { temporaryContainerIds: ['container'] }).profiles.base,
		{ logo: { x: 20 } },
	);
});

test('writer removes obsolete and shadowed responsive fields, then verifies the file', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-overrides-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'layoutOverrides.data.ts');
	const result = writeOverrides(file, {
		version: 1,
		profiles: {
			base: {
				badge: {
					responsive: { ref: 'game', x: { anchor: 1, offset: -20 } },
				},
			},
			desktop: {
				logo: {
					x: 640,
					y: 360,
					width: 400,
					scaleX: 2,
					scaleY: 2,
					responsive: {
						ref: 'game',
						x: { anchor: 0.5, offset: 0 },
						y: { anchor: 0.5, offset: 0 },
						scaleMode: 'screen',
						scaleBase: { x: 0.7, y: 0.7 },
						scaleRefW: 1280,
						scaleRefH: 720,
					},
				},
			},
			portrait: {
				badge: { x: 999 },
			},
		},
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.data.profiles.desktop.logo, {
		responsive: {
			ref: 'game',
			x: { anchor: 0.5, offset: 0 },
			y: { anchor: 0.5, offset: 0 },
			scaleMode: 'game',
			scaleBase: { x: 0.7, y: 0.7 },
		},
	});
	assert.equal(result.data.profiles.portrait, undefined, 'inherited responsive X makes profile static X dead');
	assert.deepEqual(readOverrides(file).data, result.data);
	assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /scaleRef|scaleMode": "screen"/);
});

test('writer preserves editor-created Spine playback definitions', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-overrides-spine-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'layoutOverrides.data.ts');
	const element = {
		id: 'celebration',
		kind: 'spine',
		parentId: null,
		assetKey: 'bigwin',
		animationName: 'idle',
		loop: true,
	};

	const result = writeOverrides(file, {
		version: 1,
		profiles: {},
		elements: [element],
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.data.elements, [element]);
	assert.deepEqual(readOverrides(file).data.elements, [element]);
});

test('writer preserves authored sprite asset replacements per Base and profile', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-overrides-assets-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'layoutOverrides.data.ts');
	const profiles = {
		base: {
			logo: {
				assetKey: 'logo-default.webp',
				x: 120,
			},
		},
		portrait: {
			logo: {
				assetKey: 'logo-portrait.webp',
				responsive: { ref: 'game', x: { anchor: 0.5, offset: 0 } },
			},
		},
	};

	const result = writeOverrides(file, {
		version: 1,
		profiles,
	});

	assert.equal(result.ok, true);
	assert.equal(result.data.profiles.base.logo.assetKey, 'logo-default.webp');
	assert.equal(result.data.profiles.portrait.logo.assetKey, 'logo-portrait.webp');
	assert.deepEqual(readOverrides(file).data, result.data);
	assert.match(fs.readFileSync(file, 'utf8'), /"assetKey": "logo-portrait\.webp"/);
});

test('writer drops known temporary Container overrides and rejects unsafe saved parents', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-overrides-temporary-containers-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'layoutOverrides.data.ts');

	const data = {
		version: 1,
		profiles: {
			base: {
				'container#1': { x: 10, y: 20 },
				'container#3': { visible: false },
				bonusLogo: { x: 44, y: 28 },
			},
			portrait: {
				'container#99': { scaleX: 2, scaleY: 2 },
				bonusLogo: { x: 12 },
			},
		},
		elements: [
			{ id: 'namedRoot', kind: 'container', parentId: null },
			{ id: 'unsafeChild', kind: 'sprite', assetKey: 'unsafe.png', parentId: 'container#3' },
			{ id: 'safeChild', kind: 'sprite', assetKey: 'safe.png', parentId: 'namedRoot' },
		],
	};
	const legacyDefinition = {
		version: 1,
		profiles: { base: { 'container#3': { x: 10 } } },
		elements: [{ id: 'container#3', kind: 'container', parentId: null }],
	};
	assert.throws(
		() => writeOverrides(file, legacyDefinition, {
			temporaryContainerIds: ['container#3'],
		}),
		/Editor elements cannot use temporary runtime ids.*container#3/i,
	);
	assert.throws(
		() => writeOverrides(file, data, {
			temporaryContainerIds: ['container#1', 'container#3', 'container#99'],
		}),
		/Temporary runtime parents cannot be saved.*unsafeChild.*container#3/i,
	);
	data.elements.find(({ id }) => id === 'unsafeChild').parentId = 'anonymousRoot';
	assert.throws(
		() => writeOverrides(file, data, { temporaryContainerIds: ['anonymousRoot'] }),
		/Temporary runtime parents cannot be saved.*unsafeChild.*anonymousRoot/i,
	);
	data.elements.find(({ id }) => id === 'unsafeChild').parentId = null;
	const result = writeOverrides(file, data, {
		temporaryContainerIds: ['container#1', 'container#3', 'container#99'],
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.data.profiles, {
		base: { bonusLogo: { x: 44, y: 28 } },
		portrait: { bonusLogo: { x: 12 } },
	});
	assert.equal(result.data.elements.find(({ id }) => id === 'unsafeChild')?.parentId, null);
	assert.equal(
		result.data.elements.find(({ id }) => id === 'safeChild')?.parentId,
		'namedRoot',
	);
	assert.deepEqual(readOverrides(file).data, result.data);
	assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /container#(?:1|3|99)/);
});
