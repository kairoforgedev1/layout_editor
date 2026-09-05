import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const stateUrl = moduleUrl(`
	export const state = {
		panels: { leftWidth: 270 },
		zoom: { fit: true },
		config: {},
	};
`);

const viewportUrl = moduleUrl(`
	export const fits = [];
	export const applyViewport = () => fits.push(Date.now());
`);

const panelsSource = (await readFile(
	new URL('../src/renderer/js/panels.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'./viewport.js'", `'${viewportUrl}'`);

const [{ state }, viewport, panels] = await Promise.all([
	import(stateUrl),
	import(viewportUrl),
	import(moduleUrl(panelsSource)),
]);

class FakePanel {
	constructor(id, width = 270) {
		this.id = id;
		this.style = {};
		this.hidden = false;
		this.rectWidth = width;
	}

	getBoundingClientRect() {
		return { width: this.rectWidth };
	}
}

const setup = ({ innerWidth = 1600, fit = true } = {}) => {
	const left = new FakePanel('left');
	const right = new FakePanel('right');
	globalThis.document = {
		getElementById: (id) => ({ left, right }[id] ?? null),
		body: { classList: { add() {}, remove() {} } },
	};
	globalThis.window = { innerWidth, editorHost: { setConfig: async () => ({}) } };
	state.panels.leftWidth = 270;
	state.zoom.fit = fit;
	viewport.fits.length = 0;
	return { left, right };
};

test('a width inside the allowed range is applied verbatim', () => {
	const { left } = setup();
	assert.equal(panels.setLeftWidth(420), 420);
	assert.equal(left.style.width, '420px');
	assert.equal(state.panels.leftWidth, 420);
});

test('dragging past the minimum stops at it', () => {
	const { left } = setup();
	assert.equal(panels.setLeftWidth(40), 200, 'the list stays usable');
	assert.equal(left.style.width, '200px');
});

test('dragging cannot take more than half the window from the preview', () => {
	setup({ innerWidth: 1600 });
	assert.equal(panels.setLeftWidth(1500), 800);

	// On a narrow window the floor wins over the ceiling: the list is still usable.
	setup({ innerWidth: 320 });
	assert.equal(panels.setLeftWidth(1500), 200);
});

test('resizing refits the preview only while zoom is set to Fit', () => {
	setup({ fit: true });
	panels.setLeftWidth(400);
	assert.equal(viewport.fits.length, 1, 'Fit is measured from the viewport box');

	setup({ fit: false });
	panels.setLeftWidth(400);
	assert.equal(viewport.fits.length, 0, 'a manual zoom must not be disturbed');
});

test('re-applying the same width does no work', () => {
	setup();
	panels.setLeftWidth(400);
	viewport.fits.length = 0;
	panels.setLeftWidth(400);
	assert.equal(viewport.fits.length, 0, 'no redundant refit on a no-op resize');
});

test('hiding the inspector frees the column and refits', () => {
	const { right } = setup({ fit: true });
	panels.setInspectorVisible(false);
	assert.equal(right.hidden, true);
	assert.equal(viewport.fits.length, 1, 'the preview grows into the freed width');
});

test('showing it again restores the column', () => {
	const { right } = setup();
	panels.setInspectorVisible(false);
	viewport.fits.length = 0;
	panels.setInspectorVisible(true);
	assert.equal(right.hidden, false);
	assert.equal(viewport.fits.length, 1);
});

test('an unchanged visibility is a no-op', () => {
	const { right } = setup();
	// Already visible: re-asserting must not refit on every inspector render.
	panels.setInspectorVisible(true);
	assert.equal(right.hidden, false);
	assert.equal(viewport.fits.length, 0);
});

test('a missing inspector element is tolerated', () => {
	setup();
	globalThis.document.getElementById = () => null;
	assert.doesNotThrow(() => panels.setInspectorVisible(false));
	assert.doesNotThrow(() => panels.setLeftWidth(400));
});
