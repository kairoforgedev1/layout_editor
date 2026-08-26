import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const stateUrl = moduleUrl(`
	export const state = {
		config: {},
		project: null,
		procs: { dev: { status: 'stopped' }, rgs: { status: 'stopped' } },
		preview: {
			connected: false,
			status: 'idle',
			layoutType: null,
			gameW: 0,
			gameH: 0,
			url: null,
		},
		performance: { open: false, available: false, latest: null },
		testCases: {
			open: false,
			scanStatus: 'idle',
			scanError: null,
			directory: null,
			directoryPresent: false,
			manifests: [],
			fileErrors: [],
			selectedManifestId: null,
			selectedBookKey: null,
			filter: '',
			runnerAvailable: false,
			running: false,
			lastResult: null,
		},
		overrides: {
			working: { version: 1, profiles: {} },
			saved: { version: 1, profiles: {} },
			fileError: null,
		},
		tree: [],
		temporaryContainerIds: new Set(),
		selection: null,
		values: null,
		undo: [],
		redo: [],
	};
	export const emitted = [];
	export const toasts = [];
	export const logs = [];
	export const emit = (name) => emitted.push(name);
	export const clone = (value) => value === undefined
		? undefined
		: JSON.parse(JSON.stringify(value));
	export const toast = (...args) => toasts.push(args);
	export const log = (...args) => logs.push(args);
`);

const bridgeUrl = moduleUrl(`
	let flushImplementation = async () => ({ ok: true });
	export const setFlushImplementation = (next) => { flushImplementation = next; };
	export const flushBridgeEdits = (...args) => flushImplementation(...args);
	export const awaitBridge = () => {};
	export const resetBridgeNavigation = () => {};
	export const currentBridgeNavigationSession = () => 1;
`);

const identitySource = await readFile(
	new URL('../src/shared/layoutIdentity.js', import.meta.url),
	'utf8',
);
const identityUrl = moduleUrl(identitySource);

const host = {};
const previewFrame = { src: '' };
globalThis.window = { editorHost: host };
globalThis.document = {
	getElementById(id) {
		return id === 'game-frame' ? previewFrame : null;
	},
};

const projectSource = (await readFile(
	new URL('../src/renderer/js/project.js', import.meta.url),
	'utf8',
))
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'./bridge.js'", `'${bridgeUrl}'`)
	.replace("'../../shared/layoutIdentity.js'", `'${identityUrl}'`);

const [
	{ state, emitted, toasts },
	{ setFlushImplementation },
	{ openProject, saveOverrides },
] = await Promise.all([
	import(stateUrl),
	import(bridgeUrl),
	import(moduleUrl(projectSource)),
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

const clone = (value) => JSON.parse(JSON.stringify(value));

const resetState = () => {
	state.config = {};
	state.project = null;
	state.preview.connected = false;
	state.preview.status = 'idle';
	state.preview.layoutType = null;
	state.preview.gameW = 0;
	state.preview.gameH = 0;
	state.preview.url = null;
	state.performance.open = false;
	state.performance.available = false;
	state.performance.latest = null;
	state.overrides.fileError = null;
	state.overrides.saved = { version: 1, profiles: {} };
	state.overrides.working = { version: 1, profiles: {} };
	state.tree = [];
	state.temporaryContainerIds.clear();
	state.selection = null;
	state.values = null;
	state.undo = [];
	state.redo = [];
	emitted.length = 0;
	toasts.length = 0;
	previewFrame.src = '';
	setFlushImplementation(async () => ({ ok: true }));
};

test('a completed snapshot save preserves edits made while the write is pending', async () => {
	resetState();
	const project = { appDir: 'project-a', overridesPath: 'project-a/layoutOverrides.data.ts' };
	const initial = {
		version: 1,
		profiles: { base: { logo: { x: 10, y: 20 } } },
	};
	state.project = project;
	state.overrides.saved = clone(initial);
	state.overrides.working = clone(initial);

	const writeGate = deferred();
	let submitted;
	host.writeOverrides = (_path, data) => {
		submitted = data;
		return writeGate.promise;
	};

	const saving = saveOverrides({ flush: false });
	assert.notEqual(submitted, state.overrides.working, 'the main process must receive an immutable snapshot');
	assert.deepEqual(submitted, initial);

	state.overrides.working.profiles.base.logo.x = 99;
	state.overrides.working.profiles.base.logo.visible = false;
	assert.equal(submitted.profiles.base.logo.x, 10, 'a newer edit must not mutate the submitted snapshot');

	const written = {
		version: 1,
		profiles: { base: { logo: { x: 10, y: 20 } } },
	};
	writeGate.resolve({ ok: true, data: written });
	assert.equal(await saving, true);

	assert.deepEqual(state.overrides.saved, written, 'the confirmed disk result becomes the saved baseline');
	assert.deepEqual(state.overrides.working, {
		version: 1,
		profiles: { base: { logo: { x: 99, y: 20, visible: false } } },
	}, 'edits made after submission stay in working data');
	assert.match(toasts.at(-1)?.[0] ?? '', /newer layout edits remain unsaved/i);
});

test('switching projects while a bridge flush is pending prevents the old project save', async () => {
	resetState();
	const oldProject = {
		appDir: 'project-a',
		overridesPath: 'project-a/layoutOverrides.data.ts',
	};
	state.project = oldProject;
	state.overrides.working = {
		version: 1,
		profiles: { base: { oldLogo: { x: 10 } } },
	};

	const flushGate = deferred();
	setFlushImplementation(() => flushGate.promise);
	let writeCalls = 0;
	host.writeOverrides = async () => {
		writeCalls += 1;
		return { ok: true };
	};
	host.inspectProject = async (picked) => ({
		ok: true,
		appDir: picked,
		overridesPath: `${picked}/layoutOverrides.data.ts`,
		integration: { pixiSveltePatched: true, loaderWired: true },
	});
	host.setConfig = async (partial) => partial;
	host.readOverrides = async () => ({
		ok: true,
		data: {
			version: 1,
			profiles: { base: { newLogo: { x: 70 } } },
		},
	});

	const savingOldProject = saveOverrides();
	assert.equal(await openProject('project-b'), true);
	assert.equal(state.project.appDir, 'project-b');
	assert.deepEqual(state.overrides.working.profiles, { base: { newLogo: { x: 70 } } });

	flushGate.resolve({ ok: true });
	assert.equal(await savingOldProject, false);
	assert.equal(writeCalls, 0, 'the old project must not be written after the active project changes');
	assert.equal(state.project.appDir, 'project-b');
	assert.deepEqual(state.overrides.working.profiles, { base: { newLogo: { x: 70 } } });
});
