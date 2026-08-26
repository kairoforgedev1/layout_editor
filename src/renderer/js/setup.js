/** Setup menu: integration status/install, live verification report, docs. */
import { state, toast, log } from './state.js';
import {
	bridgeSend,
	bridgeRequest,
	EXPECTED_BRIDGE_REVISION,
	EXPECTED_BRIDGE_VERSION,
} from './bridge.js';
import { showMenu, showModal, confirmDialog } from './dialogs.js';
import { applyPatches, canPersistLayoutTarget, getEntry } from './overrides.js';
import { buildGameUrl, restartPreview } from './project.js';

const host = window.editorHost;

const STATUS_LABEL = {
	ready: 'Ready',
	outdated: 'Bridge outdated',
	incomplete: 'Bridge incomplete',
	missing: 'Bridge missing',
	manual: 'Manual setup required',
};

const icon = (status) =>
	({ ok: ['✓', 'pass'], installable: ['●', 'warn'], outdated: ['●', 'warn'], skip: ['–', 'warn'], manual: ['✗', 'fail'] })[
		status
	] ?? ['?', 'warn'];

function checksList(checks) {
	const list = document.createElement('div');
	list.className = 'check-list';
	for (const check of checks) {
		const row = document.createElement('div');
		row.className = 'check-row';
		const [glyph, cls] = icon(check.status);
		row.innerHTML = `<span class="ic ${cls}">${glyph}</span><span></span><span class="note"></span>`;
		row.children[1].textContent = check.title;
		row.children[2].textContent = check.note ?? '';
		list.appendChild(row);
	}
	return list;
}

export async function showIntegrationStatus() {
	if (!state.project) return toast('Open a project first.');
	const analysis = await host.analyzeIntegration(state.project);
	const wrap = document.createElement('div');
	const headline = document.createElement('p');
	headline.style.marginTop = '0';
	headline.innerHTML = `Status: <b>${STATUS_LABEL[analysis.status] ?? analysis.status}</b> (bridge v${analysis.version ?? '—'}, editor expects v${analysis.expectedVersion})`;
	wrap.appendChild(headline);
	wrap.appendChild(checksList(analysis.checks));
	if (analysis.status === 'manual') {
		const note = document.createElement('p');
		note.className = 'dim';
		note.textContent =
			'Some files do not match the standard web-sdk shape, so automatic setup will not touch them. ' +
			'Use "Open setup guide" / "Copy AI setup prompt" from the Setup menu instead.';
		wrap.appendChild(note);
	}

	const canInstall = analysis.checks.some((check) => ['installable', 'outdated'].includes(check.status));
	const choice = await showModal({
		title: 'Editor integration',
		body: wrap,
		buttons: [
			{ label: 'Close', value: null },
			...(canInstall ? [{ label: analysis.status === 'outdated' ? 'Update bridge' : 'Install / repair bridge', value: 'install', primary: true }] : []),
		],
	});
	if (choice !== 'install') return;

	if (
		!(await confirmDialog(
			'Install bridge',
			'The editor will copy its bridge files into packages/pixi-svelte, apply small anchored patches to the SDK ' +
				'(each patched file gets a one-time .sle-backup), create the app loader/data files, and rebuild pixi-svelte. Continue?',
		))
	)
		return;

	const result = await host.installIntegration(state.project);
	if (!result.ok) {
		toast(`Install failed: ${result.error}`, 'error', 9000);
		return;
	}
	toast('Bridge files installed — rebuilding pixi-svelte…', 'ok');
	log('editor', `[setup] install results: ${result.results.map((r) => `${r.id}:${r.action}`).join(', ')}`);
	const rebuild = await host.rebuildBridge(state.project.workspaceRoot);
	if (!rebuild.ok) {
		toast('pixi-svelte rebuild failed — see Logs.', 'error', 9000);
		return;
	}
	toast('Bridge installed and built. Restart the preview to load it.', 'ok', 7000);
	const summary = document.createElement('div');
	summary.appendChild(
		checksList(result.results.map((r) => ({ title: r.id, status: r.action === 'manual' ? 'manual' : 'ok', note: `${r.action}${r.note ? ' — ' + r.note : ''}` }))),
	);
	await showModal({
		title: 'Install results',
		body: summary,
		buttons: [{ label: 'OK', value: true, primary: true }],
	});
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const waitFor = (predicate, timeoutMs = 6000, interval = 200) =>
	new Promise((resolve) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve(true);
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				resolve(false);
			}
		}, interval);
	});

export async function runVerification() {
	if (!state.project) return toast('Open a project first.');
	const checks = [];
	const add = (title, ok, note = '') => checks.push({ title, status: ok === true ? 'ok' : ok === 'warn' ? 'skip' : 'manual', note });

	add('Project opened', true, state.project.appDir);
	add('Layout data file parses', !state.overrides.fileError, state.overrides.fileError ?? '');
	add('Dev server ready', state.procs.dev.status === 'ready', `port ${state.procs.dev.port ?? '—'}`);
	add('Mock RGS ready', ['ready', 'remote'].includes(state.procs.rgs.status), state.procs.rgs.status);
	add('Editor bridge connected', state.preview.connected, state.preview.connected ? `layout: ${state.preview.layoutType}` : 'start the preview first');

	if (state.preview.connected) {
		add(
			'Bridge version',
			state.preview.bridgeVersion >= EXPECTED_BRIDGE_VERSION &&
				state.preview.bridgeRevision === EXPECTED_BRIDGE_REVISION ? true : 'warn',
			`v${state.preview.bridgeVersion} · ${state.preview.bridgeRevision || 'unknown revision'} (editor expects v${EXPECTED_BRIDGE_VERSION} · ${EXPECTED_BRIDGE_REVISION})`,
		);
		add('Layout profiles wired (loadLayoutOverrides)', !!state.preview.layoutType, '');
		add(
			'Editor-created elements wired (wireSpawnedElements)',
			state.preview.spawnWired ? true : 'warn',
			state.preview.spawnWired ? '' : 'new elements will not appear in normal runs',
		);
		add('Hierarchy populated', state.tree.length > 0, `${state.tree.length} elements`);

		// selection round-trip + live override on the first element
		const target = state.tree.find((node) =>
			node.worldVisible && canPersistLayoutTarget(node.id));
		if (target) {
			state.values = null;
			bridgeSend('select', { id: target.id });
			const gotValues = await waitFor(() => state.values?.id === target.id);
			add('Element selection round-trip', gotValues, target.id);
			if (gotValues) {
				const beforeX = state.values.effective.x;
				const profile = state.preview.layoutType;
				const entryBefore = structuredClone(getEntry(state.overrides.working, profile, target.id) ?? null);
				applyPatches(
					[{ profile, id: target.id, entry: { ...(entryBefore ?? {}), x: beforeX + 11 } }],
					{ record: false },
				);
				const moved = await waitFor(() => Math.abs((state.values?.effective?.x ?? beforeX) - (beforeX + 11)) < 0.5);
				applyPatches([{ profile, id: target.id, entry: entryBefore }], { record: false });
				add('Live layout override applies to the preview', moved, target.id);
			}
			bridgeSend('select', { id: null });
		} else {
			add('Element selection round-trip', 'warn', 'no elements in the tree');
		}

		// asset listing (spawn capability)
		if (state.preview.spawnWired) {
			try {
				const assets = await bridgeRequest('listAssets');
				add('Asset browser (listAssets)', (assets.assets ?? []).length > 0, `${(assets.assets ?? []).length} assets`);
			} catch (error) {
				add('Asset browser (listAssets)', false, String(error.message ?? error));
			}
		}
	}

	const writable = await host.checkWritable(state.project.overridesPath);
	add('Layout data file writable', writable.ok, state.project.overridesPath);

	// normal-run check (no ?editor): canvas renders, bridge stays off
	if (state.procs.dev.status === 'ready') {
		toast('Checking the game without editor mode (hidden window)…', 'info', 4000);
		const url = buildGameUrl(state.procs.dev.port).replace(/&editor=1/, '');
		const normal = await host.normalRunCheck(url);
		add(
			'Game runs normally outside editor mode',
			normal.ok,
			normal.error ?? (normal.canvas ? (normal.bridgeAbsent ? 'canvas ok, bridge inactive' : 'bridge active in normal mode!') : 'no canvas rendered'),
		);
	} else {
		add('Game runs normally outside editor mode', 'warn', 'dev server not running');
	}

	const failed = checks.filter((check) => check.status === 'manual').length;
	const wrap = document.createElement('div');
	const headline = document.createElement('p');
	headline.style.marginTop = '0';
	headline.innerHTML = failed
		? `<b>${failed} check(s) failed.</b>`
		: '<b>All checks passed.</b>';
	wrap.appendChild(headline);
	wrap.appendChild(checksList(checks));
	await showModal({ title: 'Bridge verification', body: wrap, buttons: [{ label: 'Close', value: true, primary: true }] });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export function setupMenu(anchor) {
	showMenu(anchor, [
		{ header: 'Editor integration' },
		{ label: 'Integration status / install…', onClick: showIntegrationStatus },
		{ label: 'Verify connection…', onClick: runVerification },
		{
			label: 'Rebuild pixi-svelte bridge',
			onClick: async () => {
				if (!state.project?.workspaceRoot) return toast('Open a project first.');
				toast('Rebuilding pixi-svelte… (see Logs)');
				const result = await host.rebuildBridge(state.project.workspaceRoot);
				toast(result.ok ? 'pixi-svelte rebuilt — restart the preview.' : 'Rebuild failed — see Logs.', result.ok ? 'ok' : 'error');
			},
		},
		{ label: 'Restart preview', onClick: restartPreview },
		{ sep: true },
		{ header: 'New game setup' },
		{
			label: 'Open setup guide',
			onClick: async () => {
				const doc = await host.readDoc('guide');
				if (doc.ok) host.openPath(doc.path);
				else toast(doc.error, 'error');
			},
		},
		{
			label: 'Copy AI setup prompt to clipboard',
			onClick: async () => {
				const doc = await host.readDoc('prompt');
				if (!doc.ok) return toast(doc.error, 'error');
				await navigator.clipboard.writeText(doc.text);
				toast('AI setup prompt copied — paste it into Fable / Claude Code in the target project.', 'ok', 6000);
			},
		},
	]);
}
