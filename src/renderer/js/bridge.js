/** postMessage client for the in-game editor bridge. */
import { state, emit, log } from './state.js';
import { isTemporaryLayoutContainer } from '../../shared/layoutIdentity.js';

const MSG = '__sle';
/** Bridge version this editor is built for (compared with the game's hello). */
export const EXPECTED_BRIDGE_VERSION = 11;
export const EXPECTED_BRIDGE_REVISION = '2026-08-21-spawned-runtime-hooks-v1';

let frame = null;
let pingTimer = null;
let commitHandler = null;
let hotkeyHandler = null;
let navigationSession = 0;
let awaitingSession = null;

export const setCommitHandler = (fn) => (commitHandler = fn);
export const setHotkeyHandler = (fn) => (hotkeyHandler = fn);

const GAME_PLAYOUT_EVENT_BY_MODE = {
	edit: '__layoutEditorPauseAfterCurrentEvent',
	preview: '__layoutEditorResume',
};

export function bridgeSend(type, payload) {
	frame?.contentWindow?.postMessage({
		[MSG]: true,
		type,
		payload,
		navigationSession: awaitingSession ?? navigationSession,
	}, '*');
}

/**
 * Games may opt into Edit/Play playout control through the existing editor
 * action channel. Unsupported games simply keep their current behavior.
 */
export function syncGamePlayoutMode(mode = state.mode) {
	const name = GAME_PLAYOUT_EVENT_BY_MODE[mode];
	const supported = Object.values(GAME_PLAYOUT_EVENT_BY_MODE).every((eventName) =>
		state.gameEvents.includes(eventName),
	);
	if (name && supported) {
		bridgeSend('emitGameEvent', { name });
	}
}

/** Keep the playout gate and the in-game editing shield race-free. */
export function sendEditorMode(mode) {
	if (mode === 'edit') syncGamePlayoutMode(mode);
	bridgeSend('mode', { mode });
	if (mode === 'preview') syncGamePlayoutMode(mode);
}

// request/response over postMessage (used by the asset browser)
let requestCounter = 0;
const pendingRequests = new Map();

export function bridgeRequest(type, payload = {}, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const reqId = ++requestCounter;
		const entry = { resolve, timer: null };
		pendingRequests.set(reqId, entry);
		bridgeSend(type, { ...payload, reqId });
		entry.timer = setTimeout(() => {
			if (pendingRequests.delete(reqId)) reject(new Error(`bridge request "${type}" timed out`));
		}, timeoutMs);
	});
}

/** Ensure every earlier in-game edit has produced its renderer-side commit. */
export async function flushBridgeEdits(timeoutMs = 2500) {
	if (!state.preview.connected) return { ok: true, skipped: true };
	const result = await bridgeRequest('flushEdits', {}, timeoutMs);
	if (result?.ok === false) throw new Error(result.error || 'Preview navigation changed.');
	return result;
}

const resolveRequest = (payload) => {
	const entry = pendingRequests.get(payload?.reqId);
	if (entry) {
		pendingRequests.delete(payload.reqId);
		clearTimeout(entry.timer);
		entry.resolve(payload);
	}
};

const sendInit = () => {
	// Acquire the gate before the game enables its edit shield. This keeps Promise
	// continuations from advancing book playout between the two messages.
	if (state.mode === 'edit') syncGamePlayoutMode();
	bridgeSend('init', {
		profiles: state.overrides.working.profiles,
		elements: state.overrides.working.elements ?? [],
		mode: state.mode,
		scope: state.scope,
		guides: state.guides,
		selectedId: state.selection,
		performanceMonitor: state.performance.open,
	});
	bridgeSend('viewportResize', {
		generation: 0,
		width: state.resolution.width,
		height: state.resolution.height,
	});
	if (state.mode === 'preview') syncGamePlayoutMode();
};

/** Start pinging until the bridge answers (called after the iframe loads a URL). */
export function awaitBridge() {
	clearInterval(pingTimer);
	if (awaitingSession === null) awaitingSession = ++navigationSession;
	state.preview.connected = false;
	state.performance.available = false;
	state.performance.latest = null;
	state.testCases.runnerAvailable = false;
	emit('preview');
	pingTimer = setInterval(() => {
		if (state.preview.connected) clearInterval(pingTimer);
		else bridgeSend('ping');
	}, 800);
}

/** Invalidate every message from the previously loaded game document. */
export function resetBridgeNavigation() {
	clearInterval(pingTimer);
	pingTimer = null;
	state.preview.connected = false;
	state.performance.available = false;
	state.performance.latest = null;
	state.testCases.runnerAvailable = false;
	awaitingSession = ++navigationSession;
	for (const entry of pendingRequests.values()) {
		clearTimeout(entry.timer);
		entry.resolve({ ok: false, error: 'Preview navigation changed.' });
	}
	pendingRequests.clear();
}

/** Exposed for the iframe load boundary and deterministic bridge tests. */
export const currentBridgeNavigationSession = () => awaitingSession ?? navigationSession;

export function initBridge(frameEl) {
	frame = frameEl;
	window.addEventListener('message', (event) => {
		if (event.source !== frame?.contentWindow) return;
		const message = event.data;
		if (!message || message[MSG] !== true) return;
		const { type, payload } = message;
		const expectedSession = awaitingSession ?? navigationSession;
		if (message.navigationSession !== expectedSession) return;
		// Navigation/project changes disconnect the active game before replacing the
		// iframe. Ignore every queued message from that old document; only a fresh
		// hello may establish the next connection.
		if (type !== 'hello' && type !== 'ping' && !state.preview.connected) return;
		switch (type) {
			case 'hello': {
				if (awaitingSession !== null) {
					navigationSession = awaitingSession;
					awaitingSession = null;
				}
				const first = !state.preview.connected;
				state.preview.connected = true;
				state.preview.status = 'ready';
				state.preview.layoutType = payload.layoutType;
				state.preview.gameW = payload.width;
				state.preview.gameH = payload.height;
				state.preview.bridgeVersion = payload.bridgeVersion ?? 1;
				state.preview.bridgeRevision = payload.bridgeRevision ?? '';
				state.preview.spawnWired = !!payload.spawnWired;
				state.preview.gameLayoutWired = !!payload.gameLayoutWired;
				state.performance.available = !!payload.performanceWired;
				state.testCases.runnerAvailable = !!payload.testBookRunnerWired;
				state.gameEvents = payload.gameEvents ?? [];
				if (
					(payload.bridgeVersion ?? 1) < EXPECTED_BRIDGE_VERSION ||
					payload.bridgeRevision !== EXPECTED_BRIDGE_REVISION
				) {
					log(
						'editor',
						`[bridge] game bridge v${payload.bridgeVersion ?? 1} (${payload.bridgeRevision ?? 'unknown revision'}) does not match expected v${EXPECTED_BRIDGE_VERSION} (${EXPECTED_BRIDGE_REVISION}) — use Setup → Integration status to update`,
					);
				}
				sendInit();
				bridgeSend('requestTree');
				emit('preview');
				emit('gameEvents');
				if (first) log('editor', '[bridge] connected');
				if (!payload.layoutTypeWired) {
					log(
						'editor',
						'[bridge] warning: the game did not call loadLayoutOverrides() — saved overrides will not load at runtime',
					);
				}
				break;
			}
			case 'tree':
				state.tree = payload.nodes ?? [];
				for (const node of state.tree) {
					if (node.temporaryRuntimeId || isTemporaryLayoutContainer(node)) {
						state.temporaryContainerIds.add(node.id);
					}
				}
				emit('tree');
				break;
			case 'layout':
				state.preview.layoutType = payload.layoutType;
				state.preview.gameW = payload.width;
				state.preview.gameH = payload.height;
				emit('preview');
				break;
			case 'selected':
				state.selection = payload.id;
				if (!payload.id) state.values = null;
				emit('selection');
				break;
			case 'values':
				state.values = payload;
				if (payload?.temporaryRuntimeId && payload.id) {
					state.temporaryContainerIds.add(payload.id);
				}
				emit('values');
				break;
			case 'performanceSample':
				if (state.performance.open && state.performance.available) {
					emit('performance', payload);
				}
				break;
			case 'commit':
				commitHandler?.(payload);
				break;
			case 'hotkey':
				hotkeyHandler?.(payload);
				break;
			case 'assets':
			case 'assetPreviewsResult':
			case 'reparentPrepared':
			case 'viewportReady':
			case 'editsFlushed':
			case 'testBookStarted':
				resolveRequest(payload);
				break;
			case 'log':
				log('editor', `[game] ${payload.msg}`);
				break;
		}
	});
}
