import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const resolutionsSource = await readFile(
	new URL('../src/renderer/js/resolutions.js', import.meta.url),
	'utf8',
);
const resolutionsModuleUrl = `data:text/javascript;base64,${Buffer.from(resolutionsSource).toString('base64')}`;
const { PRESETS, computeLayoutType } = await import(resolutionsModuleUrl);

test('includes a preset that activates the native tablet profile in either orientation', () => {
	const nativeTabletPreset = PRESETS.find((preset) => preset.name === 'Native tablet (near-square)');

	assert.ok(nativeTabletPreset, 'missing native-tablet preview preset');
	assert.equal(computeLayoutType(nativeTabletPreset.w, nativeTabletPreset.h), 'tablet');
	assert.equal(computeLayoutType(nativeTabletPreset.h, nativeTabletPreset.w), 'tablet');
});

test('classifies representative Stake viewport shapes', () => {
	assert.equal(computeLayoutType(375, 667), 'portrait');
	assert.equal(computeLayoutType(667, 375), 'landscape');
	assert.equal(computeLayoutType(900, 1024), 'tablet');
	assert.equal(computeLayoutType(1024, 900), 'tablet');
	assert.equal(computeLayoutType(1280, 720), 'desktop');
});

test('keeps the default resolution aligned with the HD 720p preset', async () => {
	const stateSource = await readFile(new URL('../src/renderer/js/state.js', import.meta.url), 'utf8');
	const stateModuleUrl = `data:text/javascript;base64,${Buffer.from(stateSource).toString('base64')}`;
	const { state } = await import(stateModuleUrl);
	const defaultPreset = PRESETS[state.resolution.presetIndex];

	assert.equal(defaultPreset?.name, 'HD 720p');
	assert.deepEqual(
		{ width: defaultPreset.w, height: defaultPreset.h },
		{ width: state.resolution.width, height: state.resolution.height },
	);
});
