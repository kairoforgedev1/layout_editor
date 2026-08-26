import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

class FakeClassList {
	constructor(owner) {
		this.owner = owner;
	}

	#values() {
		return new Set(String(this.owner.className ?? '').split(/\s+/).filter(Boolean));
	}

	#write(values) {
		this.owner.className = [...values].join(' ');
	}

	add(...names) {
		const values = this.#values();
		for (const name of names) values.add(name);
		this.#write(values);
	}

	remove(...names) {
		const values = this.#values();
		for (const name of names) values.delete(name);
		this.#write(values);
	}

	toggle(name, force) {
		const values = this.#values();
		const present = force === undefined ? !values.has(name) : !!force;
		if (present) values.add(name);
		else values.delete(name);
		this.#write(values);
		return present;
	}

	contains(name) {
		return this.#values().has(name);
	}
}

class FakeElement {
	constructor(tagName = 'div', id = '') {
		this.tagName = tagName.toUpperCase();
		this.id = id;
		this.className = '';
		this.classList = new FakeClassList(this);
		this.attributes = new Map();
		this.children = [];
		this.disabled = false;
		this.checked = false;
		this.value = '';
		this.textContent = '';
		this.title = '';
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	toggleAttribute(name, force) {
		const present = force === undefined ? !this.attributes.has(name) : !!force;
		if (present) this.attributes.set(name, '');
		else this.attributes.delete(name);
		return present;
	}

	#flatten(nodes) {
		return nodes.flatMap((node) => node?.isFragment ? node.children : [node]);
	}

	append(...nodes) {
		this.children.push(...this.#flatten(nodes));
	}

	appendChild(node) {
		this.append(node);
		return node;
	}

	replaceChildren(...nodes) {
		this.children = this.#flatten(nodes);
	}

	addEventListener() {}
	focus() {}
}

const elements = new Map();
const addElement = (id, { className = '', textContent = '', tagName = 'div' } = {}) => {
	const element = new FakeElement(tagName, id);
	element.className = className;
	element.textContent = textContent;
	elements.set(id, element);
	return element;
};

addElement('testcases-panel', { className: 'hidden' });
addElement('btn-testcases', { tagName: 'button' });
addElement('tc-scan-status');
addElement('tc-filter', { tagName: 'input' });
addElement('btn-testcases-refresh', { tagName: 'button' });
addElement('tc-manifest', { tagName: 'select' });
addElement('tc-list');
addElement('tc-list-count');
addElement('tc-file-warning', { className: 'tc-warning hidden' });
const startButton = addElement('btn-testcases-start', {
	className: 'tc-start-button',
	textContent: 'Start Round',
	tagName: 'button',
});
const startSpinner = addElement('tc-start-spinner', { className: 'tc-start-spinner' });
const startLabel = addElement('tc-start-label', { textContent: 'Start Round', tagName: 'span' });
startButton.append(startSpinner, startLabel);
addElement('tc-run-status', { className: 'tc-run-status' });

globalThis.document = {
	getElementById: (id) => elements.get(id) ?? null,
	createElement: (tagName) => new FakeElement(tagName),
	createDocumentFragment: () => {
		const fragment = new FakeElement('fragment');
		fragment.isFragment = true;
		return fragment;
	},
};

const host = {};
globalThis.window = {
	editorHost: host,
	addEventListener() {},
};

const stateUrl = moduleUrl(`
	export const state = {
		project: null,
		preview: { connected: false },
		performance: { open: false },
		testCases: {
			open: true,
			scanStatus: 'ready',
			scanError: null,
			directory: null,
			directoryPresent: true,
			manifests: [],
			fileErrors: [],
			selectedManifestId: null,
			selectedBookKey: null,
			filter: '',
			runnerAvailable: true,
			running: false,
			lastResult: null,
		},
		zoom: { fit: false },
		gameState: '',
	};
	export const emitted = [];
	export const toasts = [];
	export const logs = [];
	const listeners = new Map();
	export const emit = (name, payload) => {
		emitted.push([name, payload]);
		for (const listener of listeners.get(name) ?? []) listener(payload);
	};
	export const on = (name, listener) => {
		if (!listeners.has(name)) listeners.set(name, new Set());
		listeners.get(name).add(listener);
	};
	export const toast = (...args) => toasts.push(args);
	export const log = (...args) => logs.push(args);
`);

const bridgeUrl = moduleUrl(`
	export const calls = [];
	let implementation = async () => ({ ok: true });
	export const setBridgeImplementation = (next) => { implementation = next; };
	export const bridgeRequest = (...args) => {
		calls.push(args);
		return implementation(...args);
	};
`);

const projectUrl = moduleUrl(`
	export const calls = [];
	let implementation = async () => true;
	export const setEnsureRgsImplementation = (next) => { implementation = next; };
	export const ensureRgs = (...args) => {
		calls.push(args);
		return implementation(...args);
	};
`);

const toolbarUrl = moduleUrl(`
	export const modes = [];
	export const setMode = (mode) => modes.push(mode);
`);

const viewportUrl = moduleUrl('export const applyViewport = () => {};');
const performanceUrl = moduleUrl('export const setPerformanceMonitorOpen = () => {};');
const modelUrl = moduleUrl(await readFile(
	new URL('../src/renderer/js/testCaseModel.js', import.meta.url),
	'utf8',
));

const panelSource = (await readFile(
	new URL('../src/renderer/js/testCasesPanel.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'./bridge.js'", `'${bridgeUrl}'`)
	.replace("'./viewport.js'", `'${viewportUrl}'`)
	.replace("'./toolbar.js'", `'${toolbarUrl}'`)
	.replace("'./project.js'", `'${projectUrl}'`)
	.replace("'./performanceMonitor.js'", `'${performanceUrl}'`)
	.replace("'./testCaseModel.js'", `'${modelUrl}'`);

const [
	{ state, toasts },
	bridge,
	project,
	{ startSelectedTestBook },
] = await Promise.all([
	import(stateUrl),
	import(bridgeUrl),
	import(projectUrl),
	import(moduleUrl(panelSource)),
]);

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

const selectedBook = {
	key: 'base:42',
	mode: 'base',
	bookId: 42,
	payoutX: 12.5,
	sourceIndex: 3,
};

const resetHarness = () => {
	state.project = {
		appDir: 'game/app',
		env: { rgsUrl: 'http://127.0.0.1:8787', sessionID: 'session' },
	};
	state.preview.connected = true;
	state.testCases.open = true;
	state.testCases.scanStatus = 'ready';
	state.testCases.scanError = null;
	state.testCases.directoryPresent = true;
	state.testCases.fileErrors = [];
	state.testCases.manifests = [{
		id: 'manifest-id',
		sourceToken: 'manifest-token',
		fileName: 'books.json',
		books: [selectedBook],
	}];
	state.testCases.selectedManifestId = 'manifest-id';
	state.testCases.selectedBookKey = selectedBook.key;
	state.testCases.filter = '';
	state.testCases.runnerAvailable = true;
	state.testCases.running = false;
	state.testCases.runPhase = null;
	state.testCases.lastResult = null;
	state.gameState = '';
	toasts.length = 0;
	bridge.calls.length = 0;
	project.calls.length = 0;
	bridge.setBridgeImplementation(async () => ({ ok: true }));
	project.setEnsureRgsImplementation(async () => true);
	host.runTestCase = async () => ({
		ok: true,
		mode: selectedBook.mode,
		bookId: selectedBook.bookId,
		outcome: { bookId: selectedBook.bookId, events: [] },
	});
};

const currentRadio = () => elements.get('tc-list').children[0]?.children[0];

const assertPendingUi = (phase = 'preparing') => {
	assert.equal(state.testCases.running, true);
	assert.equal(startButton.disabled, true);
	assert.equal(startButton.classList.contains('loading'), true);
	assert.equal(startButton.getAttribute('aria-busy'), 'true');
	assert.equal(startLabel.textContent, 'Starting…');
	assert.equal(elements.get('tc-run-status').classList.contains('loading'), true);
	assert.match(
		elements.get('tc-run-status').textContent,
		phase === 'starting' ? /waiting for the game to start/i : /loading and starting/i,
	);
	assert.equal(elements.get('tc-manifest').disabled, true);
	assert.equal(elements.get('btn-testcases-refresh').disabled, true);
	assert.equal(elements.get('tc-filter').disabled, true);
	assert.equal(currentRadio()?.disabled, true);
};

const assertIdleUi = () => {
	assert.equal(state.testCases.running, false);
	assert.equal(startButton.disabled, false);
	assert.equal(startButton.classList.contains('loading'), false);
	assert.notEqual(startButton.getAttribute('aria-busy'), 'true');
	assert.equal(startLabel.textContent, 'Start Round');
	assert.equal(elements.get('tc-run-status').classList.contains('loading'), false);
	assert.equal(elements.get('tc-manifest').disabled, false);
	assert.equal(elements.get('btn-testcases-refresh').disabled, false);
	assert.equal(elements.get('tc-filter').disabled, false);
	assert.equal(currentRadio()?.disabled, false);
};

test('Start Round enters a synchronous loading state and ignores a second invocation', async () => {
	resetHarness();
	const rgsGate = deferred();
	const bridgeGate = deferred();
	project.setEnsureRgsImplementation(() => rgsGate.promise);
	bridge.setBridgeImplementation(() => bridgeGate.promise);

	const firstRun = startSelectedTestBook();
	assertPendingUi();

	assert.equal(await startSelectedTestBook(), false, 'a repeated click must not start another run');
	assert.equal(project.calls.length, 1);
	assert.equal(bridge.calls.length, 0);

	rgsGate.resolve(true);
	for (let index = 0; index < 5 && bridge.calls.length === 0; index += 1) {
		await Promise.resolve();
	}
	assert.equal(bridge.calls.length, 1);
	assertPendingUi('starting');

	bridgeGate.resolve({ ok: true });
	assert.equal(await firstRun, true);
	assert.equal(project.calls.length, 1);
	assert.equal(bridge.calls.length, 1);
	assertIdleUi();
	assert.deepEqual(state.testCases.lastResult, {
		text: 'Started Base · book #42 · 12.5x.',
		kind: 'success',
	});
});

test('Start Round restores its controls and reports an error after a failed launch', async () => {
	resetHarness();
	const runGate = deferred();
	host.runTestCase = () => runGate.promise;

	const running = startSelectedTestBook();
	await Promise.resolve();
	assertPendingUi();

	runGate.resolve({ ok: false, error: 'Book loader unavailable' });
	assert.equal(await running, false);
	assertIdleUi();
	assert.deepEqual(state.testCases.lastResult, {
		text: 'Could not start round: Book loader unavailable',
		kind: 'error',
	});
	assert.match(toasts.at(-1)?.[0] ?? '', /book loader unavailable/i);
});
