import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const stateSource = await readFile(new URL('../src/renderer/js/state.js', import.meta.url), 'utf8');
const stateUrl = moduleUrl(stateSource);
const identitySource = await readFile(
	new URL('../src/shared/layoutIdentity.js', import.meta.url),
	'utf8',
);
const identityUrl = moduleUrl(identitySource);
const bridgeSource = (
	await readFile(new URL('../src/renderer/js/bridge.js', import.meta.url), 'utf8')
)
	.replace("'./state.js'", `'${stateUrl}'`)
	.replace("'../../shared/layoutIdentity.js'", `'${identityUrl}'`);
const bridgeUrl = moduleUrl(bridgeSource);

const [{ state, on }, {
	EXPECTED_BRIDGE_REVISION,
	currentBridgeNavigationSession,
	initBridge,
	resetBridgeNavigation,
	bridgeRequest,
	sendEditorMode,
}] = await Promise.all([
	import(stateUrl),
	import(bridgeUrl),
]);

const messages = [];
let messageHandler;
let commitCount = 0;
const performanceSamples = [];
globalThis.window = {
	addEventListener: (name, handler) => {
		if (name === 'message') messageHandler = handler;
	},
};

const frameWindow = {
	postMessage: (message) => messages.push(message),
};
initBridge({
	contentWindow: frameWindow,
});

const bridgeModule = await import(bridgeUrl);
bridgeModule.setCommitHandler(() => {
	commitCount += 1;
});
on('performance', (sample) => performanceSamples.push(sample));

const payloads = () => messages.map(({ type, payload }) => ({ type, payload }));
const clearMessages = () => {
	messages.length = 0;
};
const activeNavigationSession = () => currentBridgeNavigationSession();
const gameMessage = (type, payload, navigationSession = activeNavigationSession()) => ({
	source: frameWindow,
	data: { __sle: true, type, payload, navigationSession },
});

test('tree messages remember temporary Container ids across screen remounts', () => {
	state.preview.connected = true;
	messageHandler(gameMessage('tree', {
		nodes: [
			{ id: 'container', type: 'container', identityStable: false },
			{ id: 'container#3', type: 'container', identityStable: false },
			{ id: 'logo', type: 'sprite', identityStable: true },
		],
	}));
	assert.deepEqual([...state.temporaryContainerIds].sort(), ['container', 'container#3']);
	messageHandler(gameMessage('tree', { nodes: [] }));
	assert.deepEqual(
		[...state.temporaryContainerIds].sort(),
		['container', 'container#3'],
		'temporary identities must survive a screen unmount until the project changes',
	);
	messageHandler(gameMessage('tree', {
		nodes: [{
			id: 'reusedAcrossType',
			type: 'sprite',
			identityStable: true,
			temporaryRuntimeId: true,
		}],
	}));
	assert.equal(state.temporaryContainerIds.has('reusedAcrossType'), true);
	state.preview.connected = false;
});

test('resetting preview navigation ignores delayed tree messages from the old game', () => {
	state.tree = [{ id: 'oldProjectLogo', type: 'sprite' }];
	state.preview.connected = true;
	const oldSession = activeNavigationSession();
	resetBridgeNavigation();
	messageHandler(gameMessage('tree', {
		nodes: [{ id: 'oldContainer', type: 'container', identityStable: false }],
	}, oldSession));
	assert.deepEqual(state.tree, [{ id: 'oldProjectLogo', type: 'sprite' }]);
	assert.equal(state.temporaryContainerIds.has('oldContainer'), false);
	messageHandler(gameMessage('commit', { id: 'oldContainer' }, oldSession));
	assert.equal(commitCount, 0, 'queued commits from the old document must be ignored too');
});

test('a delayed hello from the previous iframe document cannot reopen the bridge', () => {
	state.preview.connected = true;
	const oldSession = currentBridgeNavigationSession();
	resetBridgeNavigation();
	clearMessages();
	messageHandler(gameMessage('hello', {
		bridgeVersion: 11,
		bridgeRevision: EXPECTED_BRIDGE_REVISION,
		layoutType: 'desktop',
		width: 1280,
		height: 720,
	}, oldSession));
	assert.equal(state.preview.connected, false);
	assert.deepEqual(messages, []);
});

test('performance samples reset on reconnect and only the current navigation session is accepted', () => {
	state.performance.open = true;
	state.performance.latest = { fps: 12 };
	performanceSamples.length = 0;
	resetBridgeNavigation();
	const firstSession = activeNavigationSession();
	assert.equal(state.performance.available, false);
	assert.equal(state.performance.latest, null);

	messageHandler(gameMessage('hello', {
		bridgeVersion: 11,
		bridgeRevision: EXPECTED_BRIDGE_REVISION,
		layoutType: 'desktop',
		width: 1280,
		height: 720,
		performanceWired: true,
	}, firstSession));
	assert.equal(state.performance.available, true);
	assert.equal(
		payloads().find(({ type }) => type === 'init')?.payload?.performanceMonitor,
		true,
		'an open monitor must be re-enabled by the reconnect init message',
	);
	clearMessages();

	const firstSample = { fps: 60, timestamp: 250 };
	messageHandler(gameMessage('performanceSample', firstSample, firstSession));
	assert.deepEqual(performanceSamples, [firstSample]);

	resetBridgeNavigation();
	const secondSession = activeNavigationSession();
	assert.equal(state.performance.available, false);
	assert.equal(state.performance.latest, null);
	messageHandler(gameMessage('performanceSample', { fps: 1, timestamp: 999 }, firstSession));
	assert.deepEqual(performanceSamples, [firstSample], 'a delayed sample from the old document is ignored');

	messageHandler(gameMessage('hello', {
		bridgeVersion: 11,
		bridgeRevision: EXPECTED_BRIDGE_REVISION,
		layoutType: 'desktop',
		width: 1280,
		height: 720,
		performanceWired: true,
	}, secondSession));
	const secondSample = { fps: 58, timestamp: 500 };
	messageHandler(gameMessage('performanceSample', secondSample, secondSession));
	assert.deepEqual(performanceSamples, [firstSample, secondSample]);

	state.performance.open = false;
	messageHandler(gameMessage('performanceSample', { fps: 57, timestamp: 750 }, secondSession));
	assert.deepEqual(performanceSamples, [firstSample, secondSample], 'closed monitor drops live samples');
	resetBridgeNavigation();
	clearMessages();
});

test('test-book runner capability resets on navigation and start acknowledgements resolve requests', async () => {
	resetBridgeNavigation();
	const session = activeNavigationSession();
	assert.equal(state.testCases.runnerAvailable, false);
	messageHandler(gameMessage('hello', {
		bridgeVersion: 11,
		bridgeRevision: EXPECTED_BRIDGE_REVISION,
		layoutType: 'desktop',
		width: 1280,
		height: 720,
		testBookRunnerWired: true,
	}, session));
	assert.equal(state.testCases.runnerAvailable, true);
	clearMessages();

	const pending = bridgeRequest('startTestBook', {
		mode: 'base',
		bookId: 4,
		outcome: { bookId: 4, payoutMultiplier: 4000, events: [{ type: 'reveal' }] },
	});
	const request = messages.at(-1);
	assert.equal(request.type, 'startTestBook');
	assert.equal(request.payload.mode, 'base');
	messageHandler(gameMessage('testBookStarted', {
		reqId: request.payload.reqId,
		ok: true,
		mode: 'base',
		bookId: 4,
	}, session));
	assert.deepEqual(await pending, {
		reqId: request.payload.reqId,
		ok: true,
		mode: 'base',
		bookId: 4,
	});

	resetBridgeNavigation();
	assert.equal(state.testCases.runnerAvailable, false);
	clearMessages();
});

test('Edit acquires the supported playout gate before enabling the editing shield', () => {
	state.gameEvents = ['__layoutEditorPauseAfterCurrentEvent', '__layoutEditorResume'];

	sendEditorMode('edit');

	assert.deepEqual(payloads(), [
		{
			type: 'emitGameEvent',
			payload: { name: '__layoutEditorPauseAfterCurrentEvent' },
		},
		{ type: 'mode', payload: { mode: 'edit' } },
	]);
	clearMessages();
});

test('Play removes the editing shield before resuming supported playout', () => {
	state.gameEvents = ['__layoutEditorPauseAfterCurrentEvent', '__layoutEditorResume'];

	sendEditorMode('preview');

	assert.deepEqual(payloads(), [
		{ type: 'mode', payload: { mode: 'preview' } },
		{
			type: 'emitGameEvent',
			payload: { name: '__layoutEditorResume' },
		},
	]);
	clearMessages();
});

test('games without playout hooks receive the existing mode message only', () => {
	state.gameEvents = [];

	sendEditorMode('edit');

	assert.deepEqual(payloads(), [{ type: 'mode', payload: { mode: 'edit' } }]);
	clearMessages();
});

test('a partial hook registration cannot acquire a gate that Play cannot release', () => {
	state.gameEvents = ['__layoutEditorPauseAfterCurrentEvent'];

	sendEditorMode('edit');

	assert.deepEqual(payloads(), [{ type: 'mode', payload: { mode: 'edit' } }]);
	clearMessages();
});

test('an iframe reconnect while editing reacquires the gate before init', () => {
	state.mode = 'edit';
	state.gameEvents = [];
	messageHandler(gameMessage('hello', {
		bridgeVersion: 9,
		bridgeRevision: EXPECTED_BRIDGE_REVISION,
		layoutType: 'desktop',
		width: 1280,
		height: 720,
		gameEvents: ['__layoutEditorPauseAfterCurrentEvent', '__layoutEditorResume'],
	}));

	const sent = payloads();
	assert.equal(sent[0].type, 'emitGameEvent');
	assert.deepEqual(sent[0].payload, { name: '__layoutEditorPauseAfterCurrentEvent' });
	assert.equal(sent[1].type, 'init');
	clearMessages();
});
