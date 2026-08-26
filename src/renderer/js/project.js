/** Project opening, dev-server / mock-RGS orchestration and preview loading. */
import { state, emit, clone, toast, log } from './state.js';
import {
	awaitBridge,
	currentBridgeNavigationSession,
	flushBridgeEdits,
	resetBridgeNavigation,
} from './bridge.js';
import {
	isTemporaryContainerId,
	isTemporaryLayoutContainer,
} from '../../shared/layoutIdentity.js';

const host = window.editorHost;
let openGeneration = 0;

export async function openProject(dir = null) {
	const picked = dir ?? (await host.pickFolder(state.config.lastProject ?? undefined));
	if (!picked) return false;
	const generation = ++openGeneration;
	const info = await host.inspectProject(picked);
	if (generation !== openGeneration) return false;
	if (!info.ok) {
		toast(info.error, 'error', 6000);
		return false;
	}
	resetBridgeNavigation();
	const previewFrame = document.getElementById('game-frame');
	if (previewFrame) previewFrame.src = 'about:blank';
	state.project = null;
	state.config = await host.setConfig({ lastProject: picked });
	if (generation !== openGeneration) return false;

	if (!info.integration.pixiSveltePatched || !info.integration.loaderWired) {
		toast(
			'This project is missing the Layout Editor integration (pixi-svelte override runtime ' +
				'and/or src/game/layoutOverrides.ts). See the editor README for the setup steps.',
			'error',
			9000,
		);
	}

	const result = await host.readOverrides(info.overridesPath);
	if (generation !== openGeneration) return false;
	result.data.elements ??= [];
	state.overrides.fileError = result.ok ? null : result.error;
	state.overrides.saved = clone(result.data);
	state.overrides.working = clone(result.data);
	state.tree = [];
	state.selection = null;
	state.values = null;
	state.temporaryContainerIds.clear();
	state.preview.connected = false;
	state.preview.status = 'idle';
	state.preview.layoutType = null;
	state.preview.gameW = 0;
	state.preview.gameH = 0;
	state.preview.url = null;
	state.performance.available = false;
	state.performance.latest = null;
	state.testCases.scanStatus = 'idle';
	state.testCases.scanError = null;
	state.testCases.directory = null;
	state.testCases.directoryPresent = false;
	state.testCases.manifests = [];
	state.testCases.fileErrors = [];
	state.testCases.selectedManifestId = null;
	state.testCases.selectedBookKey = null;
	state.testCases.filter = '';
	state.testCases.runnerAvailable = false;
	state.testCases.running = false;
	state.testCases.runPhase = null;
	state.testCases.lastResult = null;
	state.project = info;
	state.undo.length = 0;
	state.redo.length = 0;
	if (result.error) toast(result.error, 'error', 9000);

	log('editor', `[project] opened ${info.appDir}`);
	emit('project');
	emit('overrides');
	emit('tree');
	emit('selection');
	emit('preview');
	return true;
}

export async function reloadLastProject() {
	state.config = await host.getConfig();
	if (state.config.lastProject) {
		try {
			return await openProject(state.config.lastProject);
		} catch (error) {
			log('editor', `[project] failed to reopen last project: ${error}`);
		}
	}
	return false;
}

const parseRgsPort = (rgsUrl) => {
	try {
		const url = new URL(rgsUrl);
		if (!['localhost', '127.0.0.1'].includes(url.hostname)) return null;
		return Number(url.port || 80);
	} catch {
		return null;
	}
};

export async function ensureRgs() {
	const project = state.project;
	if (!project) return false;
	const port = parseRgsPort(project.env.rgsUrl);
	if (port === null) {
		// remote RGS — nothing to manage locally
		state.procs.rgs = { status: 'remote', port: null };
		emit('proc');
		return true;
	}
	if (await host.checkPort(port)) {
		state.procs.rgs = { status: 'ready', port, attached: true };
		emit('proc');
		log('rgs', `[editor] attached to running mock RGS on port ${port}`);
		return true;
	}
	if (!project.mockRgsDir) {
		toast('Mock RGS is not running and no mock-rgs-server folder was found (looked in rgs/mock-rgs-server, the workspace root, and next to the workspace).', 'error', 7000);
		state.procs.rgs = { status: 'stopped', port };
		emit('proc');
		return false;
	}
	state.procs.rgs = { status: 'starting', port };
	emit('proc');
	const result = await host.startProc({
		kind: 'rgs',
		cwd: project.mockRgsDir,
		command: 'npm',
		args: ['start'],
		expectedPort: port,
	});
	state.procs.rgs = result.ok ? { status: 'ready', port: result.port } : { status: 'error', port };
	emit('proc');
	if (!result.ok) toast(`Mock RGS failed to start: ${result.error}`, 'error', 7000);
	return result.ok;
}

export async function ensureDevServer() {
	const project = state.project;
	if (!project) return null;
	if (state.procs.dev.status === 'ready' && state.procs.dev.port) return state.procs.dev.port;
	if (await host.checkPort(project.devPort)) {
		state.procs.dev = { status: 'ready', port: project.devPort, attached: true };
		emit('proc');
		log('dev', `[editor] attached to running dev server on port ${project.devPort}`);
		return project.devPort;
	}
	state.procs.dev = { status: 'starting', port: project.devPort };
	emit('proc');
	const result = await host.startProc({
		kind: 'dev',
		cwd: project.appDir,
		command: 'pnpm',
		args: ['dev'],
		expectedPort: project.devPort,
	});
	state.procs.dev = result.ok
		? { status: 'ready', port: result.port }
		: { status: 'error', port: project.devPort };
	emit('proc');
	if (!result.ok) toast(`Dev server failed to start: ${result.error}`, 'error', 7000);
	return result.ok ? result.port : null;
}

export function buildGameUrl(port) {
	const env = state.project.env;
	const params = new URLSearchParams({
		sessionID: env.sessionID,
		rgs_url: env.rgsUrl,
		lang: env.lang,
		currency: env.currency,
		device: env.device,
		social: env.social,
		demo: env.demo,
		editor: '1',
	});
	return `http://localhost:${port}/?${params.toString()}`;
}

const bridgeDocumentUrl = (url) => {
	const next = new URL(url);
	next.searchParams.set('__sle_session', String(currentBridgeNavigationSession()));
	return next.toString();
};

export async function startPreview() {
	if (!state.project) {
		toast('Open a project first.');
		return;
	}
	state.preview.status = 'starting';
	emit('preview');
	await ensureRgs();
	const port = await ensureDevServer();
	if (!port) {
		state.preview.status = 'idle';
		emit('preview');
		return;
	}
	state.preview.url = buildGameUrl(port);
	state.preview.status = 'loading';
	emit('preview');
	const frame = document.getElementById('game-frame');
	resetBridgeNavigation();
	frame.src = bridgeDocumentUrl(state.preview.url);
	awaitBridge();
	log('editor', `[preview] loading ${state.preview.url}`);
}

export function restartPreview() {
	const frame = document.getElementById('game-frame');
	if (!state.preview.url) return startPreview();
	resetBridgeNavigation();
	state.preview.status = 'loading';
	state.preview.connected = false;
	emit('preview');
	frame.src = bridgeDocumentUrl(state.preview.url);
	awaitBridge();
	log('editor', '[preview] reloading');
}

/**
 * Reload the game preview after dropping the HTTP cache.
 *
 * Plain restartPreview() reuses cached responses, so an asset file that was
 * replaced in place — e.g. a repainted page image inside an already-registered
 * atlas — keeps rendering the old pixels. Clearing the cache first forces the
 * dev server to be re-hit for every asset.
 */
export async function hardReloadGame() {
	if (!state.project) {
		toast('Open a project first.');
		return false;
	}
	if (!state.preview.url) return startPreview();
	const result = await host.clearCache();
	if (!result?.ok) log('editor', `[preview] cache clear failed: ${result?.error ?? 'unknown'}`);
	restartPreview();
	toast('Game reloaded (cache cleared).', 'ok', 2500);
	return true;
}

export async function saveOverrides({ flush = true } = {}) {
	const project = state.project;
	if (!project) return false;
	if (state.overrides.fileError) {
		toast(`Cannot save: ${state.overrides.fileError}`, 'error', 8000);
		return false;
	}
	if (flush) {
		try {
			const flushed = await flushBridgeEdits();
			if (flushed?.ok === false) throw new Error(flushed.error || 'preview navigation changed');
		} catch (error) {
			toast(`Save paused: the game has not confirmed its latest layout edit (${error.message ?? error}).`, 'error', 7000);
			return false;
		}
	}
	if (state.project !== project) return false;
	for (const node of state.tree) {
		if (isTemporaryLayoutContainer(node)) state.temporaryContainerIds.add(node.id);
	}
	const unsafeDefinitions = (state.overrides.working.elements ?? [])
		.filter((element) =>
			isTemporaryContainerId(element?.id) || state.temporaryContainerIds.has(element?.id))
		.map((element) => element.id);
	if (unsafeDefinitions.length) {
		toast(
			`Cannot save editor elements using temporary runtime ids: ${unsafeDefinitions.join(', ')}. Rename or permanently delete each legacy element first.`,
			'error',
			9000,
		);
		return false;
	}
	const unsafeParents = (state.overrides.working.elements ?? [])
		.filter((element) => {
			const parentId = element?.parentId ?? '';
			return isTemporaryContainerId(parentId) || state.temporaryContainerIds.has(parentId);
		})
		.map((element) => `${element.id} → ${element.parentId}`);
	if (unsafeParents.length) {
		toast(
			`Cannot save temporary parent bindings: ${unsafeParents.join(', ')}. Switch to a screen where each element is mounted, then choose the Pixi stage or a named Parent. If it cannot mount, repair its parentId in layoutOverrides.data.ts.`,
			'error',
			9000,
		);
		return false;
	}
	// Write an immutable snapshot. Bridge commits and inspector edits may arrive
	// while the main process is formatting/writing the file; those newer edits
	// must remain in `working` instead of being replaced by the save result.
	const submitted = clone(state.overrides.working);
	const submittedKey = JSON.stringify(submitted);
	const result = await host.writeOverrides(
		project.overridesPath,
		submitted,
		[...state.temporaryContainerIds],
	);
	if (state.project !== project) return false;
	if (!result.ok) {
		toast(`Save failed: ${result.error}`, 'error', 7000);
		return false;
	}
	const saved = clone(result.data ?? submitted);
	const hasNewerEdits = JSON.stringify(state.overrides.working) !== submittedKey;
	state.overrides.saved = saved;
	if (!hasNewerEdits) state.overrides.working = clone(saved);
	emit('overrides');
	toast(
		hasNewerEdits
			? 'Saved the confirmed snapshot; newer layout edits remain unsaved.'
			: `Saved layout overrides to ${project.overridesPath}`,
		'ok',
	);
	log('editor', `[save] wrote ${project.overridesPath}`);
	return true;
}

/** Wire proc:event stream from the main process into state + logs. */
export function initProcEvents() {
	host.onProcEvent((event) => {
		const { kind } = event;
		if (event.event === 'log') {
			log(kind === 'rgs' ? 'rgs' : 'dev', event.line);
			return;
		}
		if (event.event === 'ready') {
			state.procs[kind] = { status: 'ready', port: event.port };
		} else if (event.event === 'exit') {
			state.procs[kind] = { status: 'stopped', port: null };
			log(kind === 'rgs' ? 'rgs' : 'dev', `[editor] process exited (code ${event.code})`);
		} else if (event.event === 'starting') {
			state.procs[kind] = { ...state.procs[kind], status: 'starting' };
		}
		emit('proc');
	});
}
