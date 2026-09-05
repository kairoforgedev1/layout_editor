import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const stateUrl = moduleUrl(`
	export const state = { selection: null, values: null };
	export const emitted = [];
	export const emit = (name, payload) => emitted.push([name, payload]);
`);

const bridgeUrl = moduleUrl(`
	export const sent = [];
	export const bridgeSend = (type, payload) => sent.push([type, payload]);
`);

const selectionSource = (await readFile(
	new URL('../src/renderer/js/selection.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'./bridge.js'", `'${bridgeUrl}'`);

const [{ state, emitted }, bridge, { clearSelection }] = await Promise.all([
	import(stateUrl),
	import(bridgeUrl),
	import(moduleUrl(selectionSource)),
]);

const reset = () => {
	state.selection = 'someElement';
	state.values = { id: 'someElement', type: 'sprite' };
	emitted.length = 0;
	bridge.sent.length = 0;
};

test('clearing drops the editor selection and its cached values', () => {
	reset();
	clearSelection();

	assert.equal(state.selection, null);
	assert.equal(state.values, null, 'stale values would outlive the selection');
});

test('the game is told too, so the preview stops outlining the element', () => {
	reset();
	clearSelection();

	assert.deepEqual(bridge.sent, [['select', { id: null }]]);
});

test('one selection event is emitted so the panels re-render', () => {
	reset();
	clearSelection();

	assert.deepEqual(emitted, [['selection', undefined]]);
});

test('clearing an already-empty selection is harmless and still notifies', () => {
	reset();
	state.selection = null;
	state.values = null;
	emitted.length = 0;
	bridge.sent.length = 0;

	assert.doesNotThrow(() => clearSelection());
	assert.equal(state.selection, null);
	// Still told: the game may hold a highlight the editor never knew about.
	assert.deepEqual(bridge.sent, [['select', { id: null }]]);
});
