/** "Add element" dialog: asset browser + name/parent selection, the standalone
 *  asset picker used by "Replace asset", and the project asset recheck flow. */
import { state, on, emit, toast, log } from './state.js';
import { bridgeSend, bridgeRequest } from './bridge.js';
import { addSpawnedElement, validateElementId } from './overrides.js';
import { showModal } from './dialogs.js';
import { hardReloadGame } from './project.js';
import {
	buildParentOptions,
	contextualParentOption,
	recommendedParentValue,
	parentHelpText,
	GLOBAL_STAGE_PARENT,
} from './elementParents.js';

const previewCache = new Map(); // assetKey -> dataURL
let previewRequestQueue = new Map(); // assetKey -> Promise resolvers (batched per render)
let previewRequestScheduled = false;
const previewRequestsInFlight = new Map(); // assetKey -> shared Promise
let assetCache = null; // last listAssets result
let assetCacheGeneration = 0;
const SPINE_BRIDGE_VERSION = 9;

export async function fetchAssets(refresh = false, type = 'texture') {
	if (!assetCache || refresh) {
		const result = await bridgeRequest('listAssets');
		if (!result.wired) {
			toast('The game has not wired spawned elements (wireSpawnedElements) — see Setup menu.', 'error', 7000);
		}
		assetCache = result.assets ?? [];
	}
	return type ? assetCache.filter((asset) => asset.type === type) : assetCache;
}

export function clearAssetCaches() {
	assetCache = null;
	previewCache.clear();
	assetCacheGeneration += 1;
}

// invalidate the list cache whenever the preview (re)connects — a reload may carry new assets
let wasConnected = false;
on('preview', () => {
	if (state.preview.connected && !wasConnected) clearAssetCaches();
	wasConnected = state.preview.connected;
});

export const preferredSpineAnimation = (asset) => {
	const animations = asset?.animations ?? [];
	return (
		animations.find((name) => name.toLowerCase() === 'idle') ??
		animations.find((name) => /(?:^|[_-])idle$/i.test(name)) ??
		animations[0] ??
		''
	);
};

// ---------------------------------------------------------------------------
// Recheck project assets (scan disk, register new ones in assets.ts)
// ---------------------------------------------------------------------------

const manualNote = (scan) => {
	const lines = [
		'Layout Editor asset recheck details.',
		`Project app: ${state.project?.appDir}`,
		scan?.assetsTsPath ? `Registration file: ${scan.assetsTsPath}` : 'Registration file not found (expected src/game/assets.ts).',
		'',
		'Detected but not registered:',
		...(scan?.newAtlases ?? []).map((a) => `- atlas ${a.rel} (${a.frameCount} frames)`),
		...(scan?.newImages ?? []).map((i) => `- image ${i.rel}`),
		...(scan?.newSpines ?? []).map(
			(s) =>
				`- spine ${s.skeletonRel} + ${s.atlasRel} → ${s.key} ` +
				`(scale ${s.scale}, ${s.animations.length} animation(s))` +
				(s.loadIssue ? ` — ${s.loadIssue}` : ''),
		),
		...(scan?.spineIssues ?? []).map((issue) => `- spine ${issue.dir}: ${issue.reason}`),
		'',
		'Each sprite atlas needs an entry in the asset map like:',
		"  myAtlas: { type: 'sprites', src: new URL('../../assets/<path>.json', import.meta.url).href },",
		"plain images use type: 'sprite', and Spine entries use type: 'spine' with atlas, skeleton and scale.",
	];
	return lines.join('\n');
};

export async function recheckAssets(afterRegister) {
	if (!state.project) return toast('Open a project first.');
	const scanKey = state.project.appDir.replace(/\\/g, '/').toLowerCase();
	const sinceMs = state.config?.assetScanTimes?.[scanKey] ?? 0;
	const scan = await window.editorHost.scanAssets(state.project.appDir, sinceMs);
	if (scan.scannedAtMs) {
		state.config = await window.editorHost.setConfig({
			assetScanTimes: {
				...(state.config?.assetScanTimes ?? {}),
				[scanKey]: scan.scannedAtMs,
			},
		});
	}
	if (!scan.ok) {
		const choice = await showModal({
			title: 'Recheck assets',
			body: `${scan.error}\n\nUse "Copy details" to get a note describing what was detected for a manual or AI-assisted fix.`,
			buttons: [
				{ label: 'Copy details', value: 'copy' },
				{ label: 'Close', value: null, primary: true },
			],
		});
		if (choice === 'copy') {
			await navigator.clipboard.writeText(manualNote(scan));
			toast('Details copied to clipboard.', 'ok');
		}
		return;
	}

	const changed = scan.changedFiles ?? [];
	const newAtlases = scan.newAtlases ?? [];
	const newImages = scan.newImages ?? [];
	const newSpines = scan.newSpines ?? [];
	const spineIssues = scan.spineIssues ?? [];
	const found = newAtlases.length + newImages.length + newSpines.length;
	if (!found && !spineIssues.length) {
		// Nothing to register. Replaced-in-place files (e.g. a repainted image
		// inside an existing atlas) still need a cache-busting reload to appear.
		if (changed.length) {
			const preview = changed.slice(0, 8).map((c) => `  • ${c.rel}${c.isAtlasPage ? '  (atlas page image)' : ''}`);
			const more = changed.length > preview.length ? `\n  …and ${changed.length - preview.length} more` : '';
			const choice = await showModal({
				title: 'Recheck assets',
				body:
					`No new assets to register, but ${changed.length} asset file(s) changed on disk ` +
					`since the last check:\n\n${preview.join('\n')}${more}\n\n` +
					`Replaced files are served from cache until the game is reloaded with the cache cleared.`,
				buttons: [
					{ label: 'Reload game', value: 'reload', primary: true },
					{ label: 'Close', value: null },
				],
			});
			if (choice === 'reload') await hardReloadGame();
			return;
		}
		toast(`No new assets found (${scan.registeredCount} source files already registered).`, 'ok', 5000);
		return;
	}

	// collision check: frame names that already exist as runtime asset keys
	let runtimeKeys = new Set();
	try {
		runtimeKeys = new Set((await fetchAssets(true, null)).map((asset) => asset.key));
	} catch {
		// preview not running — skip collision info
	}

	const wrap = document.createElement('div');
	const intro = document.createElement('p');
	intro.style.marginTop = '0';
	intro.innerHTML = found
		? `Found <b>${newAtlases.length}</b> sprite atlas(es), <b>${newImages.length}</b> image(s), and <b>${newSpines.length}</b> Spine skeleton(s) under <code>static/assets</code>.`
		: 'No automatically registrable assets found; review the Spine warnings below.';
	wrap.appendChild(intro);

	const list = document.createElement('div');
	list.className = 'check-list';
	const selected = new Map(); // entry -> checkbox
	const spineScales = new Map(); // spine entry -> editable parser scale
	const row = ({ entry, glyph, cls, title, note, checkable }) => {
		const el = document.createElement('div');
		el.className = 'check-row';
		if (checkable) {
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.checked = true;
			selected.set(entry, box);
			el.appendChild(box);
		} else {
			el.innerHTML = `<span class="ic ${cls}">${glyph}</span>`;
		}
		const titleEl = document.createElement('span');
		titleEl.textContent = title;
		const noteEl = document.createElement('span');
		noteEl.className = 'note';
		noteEl.textContent = note ?? '';
		el.appendChild(titleEl);
		el.appendChild(noteEl);
		list.appendChild(el);
		return el;
	};
	for (const atlas of newAtlases) {
		const collisions = atlas.frames.filter((frame) => runtimeKeys.has(frame));
		row({
			entry: atlas,
			checkable: atlas.imageOk,
			glyph: '✗',
			cls: 'fail',
			title: `atlas ${atlas.rel} → key "${atlas.key}"`,
			note:
				`${atlas.frameCount} frame(s)` +
				(atlas.imageOk ? '' : ` — image "${atlas.imageName}" MISSING, will not load`) +
				(atlas.hasIndexTs ? ' — folder index.ts detected (not used by this loader)' : '') +
				(collisions.length ? ` — ${collisions.length} frame name(s) overlap existing assets: ${collisions.slice(0, 4).join(', ')}` : ''),
		});
	}
	for (const image of newImages) {
		row({ entry: image, checkable: true, title: `image ${image.rel} → key "${image.key}"`, note: 'plain sprite' });
	}
	for (const spine of newSpines) {
		const collisions = runtimeKeys.has(spine.key);
		const el = row({
			entry: spine,
			checkable: spine.loadOk ?? spine.imageOk,
			glyph: '✗',
			cls: 'fail',
			title: `spine ${spine.skeletonRel} → key "${spine.key}"`,
			note:
				`${spine.animations.length} animation(s), atlas ${spine.atlasRel}` +
				(spine.loadIssue ? ` — ${spine.loadIssue}` : '') +
				(collisions ? ' — key overlaps an existing runtime asset' : ''),
		});
		if (spine.loadOk ?? spine.imageOk) {
			const scaleLabel = document.createElement('label');
			scaleLabel.className = 'spine-scale';
			scaleLabel.textContent = 'scale';
			scaleLabel.title =
				'Stake parser scale applied while reading the skeleton. Suggested from this project’s existing Spine entries.';
			const scale = document.createElement('input');
			scale.type = 'number';
			scale.min = '0.01';
			scale.step = '0.1';
			scale.value = spine.scale;
			scaleLabel.appendChild(scale);
			el.insertBefore(scaleLabel, el.querySelector('.note'));
			spineScales.set(spine, scale);
		}
	}
	for (const issue of spineIssues) {
		row({
			glyph: '–',
			cls: 'warn',
			title: `spine ${issue.dir}`,
			note: issue.reason,
		});
	}
	wrap.appendChild(list);

	if (found) {
		const filesNote = document.createElement('p');
		filesNote.className = 'dim';
		filesNote.textContent = scan.anchorOk
			? `Registering will append entries to ${scan.assetsTsPath} (one-time .sle-backup) and the game preview will reload via the dev server.`
			: `Cannot update ${scan.assetsTsPath} automatically (no "export default {" anchor).`;
		wrap.appendChild(filesNote);
	}
	if (changed.length) {
		const changedNote = document.createElement('p');
		changedNote.className = 'dim';
		changedNote.textContent =
			`${changed.length} registered asset file(s) also changed on disk. ` +
			'Reload game clears the preview cache without registering the new entries.';
		wrap.appendChild(changedNote);
	}

	const registrable = scan.anchorOk && selected.size > 0;
	const choice = await showModal({
		title: 'Recheck assets — new assets detected',
		body: wrap,
		buttons: [
			{ label: 'Copy details', value: 'copy' },
			...(changed.length ? [{ label: 'Reload game', value: 'reload' }] : []),
			{ label: 'Cancel', value: null },
			...(registrable ? [{ label: 'Register & reload', value: 'register', primary: true }] : []),
		],
	});
	if (choice === 'copy') {
		await navigator.clipboard.writeText(manualNote(scan));
		toast('Details copied to clipboard.', 'ok');
		return;
	}
	if (choice === 'reload') {
		await hardReloadGame();
		return;
	}
	if (choice !== 'register') return;

	const entries = [...selected.entries()]
		.filter(([, box]) => box.checked)
		.map(([entry]) => {
			if (entry.kind !== 'spine') return entry;
			return { ...entry, scale: Number(spineScales.get(entry)?.value) };
		});
	if (!entries.length) return toast('Nothing selected to register.');
	const invalidScale = entries.find(
		(entry) => entry.kind === 'spine' && (!Number.isFinite(entry.scale) || entry.scale <= 0),
	);
	if (invalidScale) {
		toast(`"${invalidScale.key}" needs a Spine scale greater than zero.`, 'error', 6000);
		return;
	}
	const result = await window.editorHost.registerAssets(state.project.appDir, entries);
	if (!result.ok) {
		toast(`Asset registration failed: ${result.error}`, 'error', 8000);
		return;
	}
	clearAssetCaches();
	log('editor', `[assets] registered ${result.added.join(', ') || '(none)'} in ${result.file}`);
	toast(
		`Registered ${result.added.length} asset entr${result.added.length === 1 ? 'y' : 'ies'} in assets.ts — reloading the preview to load them.`,
		'ok',
		8000,
	);
	// A full cache-busting reload is deliberate: Vite's partial Svelte-HMR of the assets module
	// remounts the app mid-session and can leave the asset loader in a reset state.
	// Unsaved layout changes survive — the editor re-syncs them on reconnect.
	if (state.preview.url) setTimeout(hardReloadGame, 1200);
	afterRegister?.(result, entries);
}

async function loadPreviews(keys) {
	const missing = keys.filter((key) => !previewCache.has(key));
	for (let i = 0; i < missing.length; i += 24) {
		const chunk = missing.slice(i, i + 24);
		try {
			const { previews } = await bridgeRequest('assetPreviews', { keys: chunk }, 20000);
			for (const [key, url] of Object.entries(previews ?? {})) previewCache.set(key, url);
		} catch {
			break; // preview generation is best-effort
		}
	}
}

/** Return a cached/generated thumbnail for an inspector asset card. */
export function getAssetPreview(assetKey) {
	if (!assetKey) return Promise.resolve(null);
	if (previewCache.has(assetKey)) return Promise.resolve(previewCache.get(assetKey));
	if (previewRequestsInFlight.has(assetKey)) return previewRequestsInFlight.get(assetKey);
	const request = new Promise((resolve) => {
		if (!previewRequestQueue.has(assetKey)) previewRequestQueue.set(assetKey, []);
		previewRequestQueue.get(assetKey).push(resolve);
		if (previewRequestScheduled) return;
		previewRequestScheduled = true;
		queueMicrotask(async () => {
			previewRequestScheduled = false;
			const queued = previewRequestQueue;
			previewRequestQueue = new Map();
			try {
				await loadPreviews([...queued.keys()]);
			} finally {
				for (const [key, resolvers] of queued) {
					const preview = previewCache.get(key) ?? null;
					for (const finish of resolvers) finish(preview);
					previewRequestsInFlight.delete(key);
				}
			}
		});
	});
	previewRequestsInFlight.set(assetKey, request);
	return request;
}

function buildAssetGrid({
	onPick,
	onInvalidate = null,
	onAccept = null,
	assetType = 'texture',
	defer = false,
	initialKey = null,
}) {
	const wrap = document.createElement('div');
	wrap.className = 'asset-browser';
	wrap.dataset.assetType = assetType;
	const isSpine = assetType === 'spine';

	const bar = document.createElement('div');
	bar.className = 'asset-bar';
	const search = document.createElement('input');
	search.type = 'search';
	search.placeholder = isSpine ? 'Search Spine assets…' : 'Search image assets…';
	search.setAttribute('aria-label', isSpine ? 'Search Spine assets' : 'Search image assets');
	const refresh = document.createElement('button');
	refresh.type = 'button';
	refresh.textContent = '⟳';
	refresh.title = 'Refresh asset list from the running game';
	refresh.setAttribute('aria-label', 'Refresh asset list');
	const recheck = document.createElement('button');
	recheck.type = 'button';
	recheck.textContent = 'Recheck project…';
	recheck.title =
		'Rescan static/assets for newly added sprite or Spine assets and register them in assets.ts';
	const count = document.createElement('span');
	count.className = 'dim';
	bar.appendChild(search);
	bar.appendChild(refresh);
	bar.appendChild(recheck);
	bar.appendChild(count);
	wrap.appendChild(bar);

	const grid = document.createElement('div');
	grid.className = 'asset-grid';
	grid.setAttribute('aria-label', isSpine ? 'Spine assets' : 'Image assets');
	wrap.appendChild(grid);

	let assets = [];
	let selectedKey = initialKey || null;
	let started = false;
	let loadedGeneration = -1;
	let loading = false;
	let loadError = null;
	let initialPickNotified = false;
	let initialScrolled = false;

	const stateMessage = (message, kind = '') => {
		const el = document.createElement('div');
		el.className = `asset-state${kind ? ` ${kind}` : ''}`;
		el.textContent = message;
		grid.appendChild(el);
	};

	const selectAsset = (asset, accept = false) => {
		selectedKey = asset.key;
		initialPickNotified = true;
		onPick?.(asset);
		for (const tile of grid.querySelectorAll('.asset-tile')) {
			const selected = tile.dataset.assetKey === selectedKey;
			tile.classList.toggle('selected', selected);
			tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
		}
		if (accept) onAccept?.(asset);
	};

	const render = () => {
		const term = search.value.trim().toLowerCase();
		const filtered = assets.filter((asset) => !term || asset.key.toLowerCase().includes(term));
		count.textContent = term && assets.length
			? `${filtered.length} of ${assets.length}`
			: `${assets.length} ${isSpine ? 'Spine' : 'image'} asset(s)`;
		grid.innerHTML = '';
		grid.setAttribute('aria-busy', loading ? 'true' : 'false');
		if (loading) {
			stateMessage(`Loading ${isSpine ? 'Spine' : 'image'} assets…`, 'loading');
			return;
		}
		if (loadError) {
			stateMessage(`Could not load assets: ${loadError}`, 'error');
			return;
		}
		if (!assets.length) {
			stateMessage(
				`No ${isSpine ? 'Spine' : 'image'} assets are available in the running game.`,
				'empty',
			);
			return;
		}
		if (!filtered.length) {
			stateMessage(`No assets match “${search.value.trim()}”.`, 'empty');
			return;
		}
		if (initialKey && !assets.some((asset) => asset.key === initialKey)) {
			stateMessage(`The current asset “${initialKey}” is unavailable. Choose a replacement.`, 'warning');
		}

		const visible = filtered.slice(0, 400);
		for (const asset of visible) {
			const tile = document.createElement('button');
			tile.type = 'button';
			tile.className = 'asset-tile' + (asset.key === selectedKey ? ' selected' : '');
			tile.dataset.assetKey = asset.key;
			tile.setAttribute('aria-pressed', asset.key === selectedKey ? 'true' : 'false');
			const img = document.createElement('img');
			img.alt = '';
			if (previewCache.has(asset.key)) img.src = previewCache.get(asset.key);
			const name = document.createElement('div');
			name.className = 'asset-name';
			name.textContent = asset.key;
			tile.title =
				`${asset.key}${asset.width ? ` — ${asset.width}×${asset.height}px` : ''}` +
				(isSpine ? ` — ${(asset.animations ?? []).length} animation(s)` : '');
			tile.appendChild(img);
			tile.appendChild(name);
			if (asset.key === initialKey) {
				const current = document.createElement('span');
				current.className = 'asset-current';
				current.textContent = 'Current';
				tile.appendChild(current);
			}
			tile.addEventListener('click', () => selectAsset(asset));
			tile.addEventListener('dblclick', (event) => {
				if (!onAccept) return;
				event.preventDefault();
				selectAsset(asset, true);
			});
			tile.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' || !onAccept) return;
				event.preventDefault();
				selectAsset(asset, true);
			});
			grid.appendChild(tile);
		}
		if (filtered.length > visible.length) {
			stateMessage(`Showing the first ${visible.length} matches. Refine your search to see the rest.`, 'limit');
		}
		if (!initialScrolled && selectedKey) {
			const selected = [...grid.querySelectorAll('.asset-tile')]
				.find((tile) => tile.dataset.assetKey === selectedKey);
			if (selected) {
				initialScrolled = true;
				requestAnimationFrame(() => selected.scrollIntoView({ block: 'nearest' }));
			}
		}
		loadPreviews(visible.map((asset) => asset.key)).then(() => {
			if (!wrap.isConnected) return;
			for (const tile of grid.querySelectorAll('.asset-tile')) {
				const img = tile.querySelector('img');
				const key = tile.dataset.assetKey;
				if (!img.getAttribute('src') && previewCache.has(key)) img.src = previewCache.get(key);
			}
		});
	};

	search.addEventListener('input', render);
	const ensureAssets = async (force = false) => {
		if (force) clearAssetCaches();
		if (!force && started && loadedGeneration === assetCacheGeneration) return assets;
		started = true;
		loading = true;
		loadError = null;
		refresh.disabled = true;
		render();
		try {
			assets = await fetchAssets(false, assetType);
			loadedGeneration = assetCacheGeneration;
			if (selectedKey && !assets.some((asset) => asset.key === selectedKey)) {
				const invalidKey = selectedKey;
				selectedKey = null;
				onInvalidate?.(invalidKey);
			}
			if (!initialPickNotified && initialKey && selectedKey === initialKey) {
				const initialAsset = assets.find((asset) => asset.key === selectedKey);
				if (initialAsset) {
					initialPickNotified = true;
					onPick?.(initialAsset, { initial: true });
				}
			}
			return assets;
		} catch (error) {
			assets = [];
			loadError = String(error?.message ?? error);
			if (selectedKey) {
				const invalidKey = selectedKey;
				selectedKey = null;
				onInvalidate?.(invalidKey);
			}
			throw error;
		} finally {
			loading = false;
			refresh.disabled = false;
			render();
		}
	};
	wrap.ensureAssets = ensureAssets;
	wrap.focusSearch = () => search.focus();
	refresh.addEventListener('click', () => ensureAssets(true).catch(() => {}));
	recheck.addEventListener('click', () =>
		recheckAssets((result, registeredEntries) => {
			// The registration path reloads the preview. Refresh from the newly
			// connected game, then poll because Stake's async AssetsLoader can
			// finish after the bridge hello.
			const expectedKeys = new Set(
				registeredEntries.flatMap((entry) => {
					if (assetType === 'spine') return entry.kind === 'spine' ? [entry.key] : [];
					if (entry.kind === 'image') return [entry.key];
					if (entry.kind === 'atlas') return entry.frames ?? [];
					return [];
				}),
			);
			let stopReconnect = null;
			let sawDisconnect = !state.preview.connected;
			stopReconnect = on('preview', async () => {
				if (!wrap.isConnected) {
					stopReconnect?.();
					return;
				}
				if (!state.preview.connected) {
					sawDisconnect = true;
					return;
				}
				if (!sawDisconnect) return;
				stopReconnect?.();
				const poll = async (attempt = 0) => {
					if (!wrap.isConnected || !state.preview.connected) return;
					try {
						assets = await fetchAssets(true, assetType);
						loadError = null;
						started = true;
						loadedGeneration = assetCacheGeneration;
						render();
						const keys = new Set(assets.map((asset) => asset.key));
						if (!expectedKeys.size || [...expectedKeys].every((key) => keys.has(key))) return;
					} catch {
						// Retry below; the visible ⟳ button remains the final fallback.
					}
					if (attempt < 40) setTimeout(() => poll(attempt + 1), 350);
				};
				poll();
			});
		}),
	);

	if (!defer) ensureAssets().catch(() => {});

	return wrap;
}

const closeDialog = (backdrop, reason = 'programmatic') => {
	if (typeof backdrop?.closeDialog === 'function') backdrop.closeDialog(reason);
	else backdrop?.remove();
};

function dialogShell(title, { onDismiss } = {}) {
	const previousFocus = document.activeElement;
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';
	const modal = document.createElement('div');
	modal.className = 'modal modal-wide';
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	const h = document.createElement('h3');
	h.textContent = title;
	h.id = `asset-dialog-title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	modal.setAttribute('aria-labelledby', h.id);
	modal.appendChild(h);
	const body = document.createElement('div');
	body.className = 'modal-body';
	modal.appendChild(body);
	const foot = document.createElement('div');
	foot.className = 'modal-foot';
	modal.appendChild(foot);
	backdrop.appendChild(modal);
	let closed = false;
	const keydown = (event) => {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		const openDialogs = document.querySelectorAll('#modal-root > .modal-backdrop');
		if (openDialogs[openDialogs.length - 1] !== backdrop) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		closeDialog(backdrop, 'escape');
	};
	backdrop.closeDialog = (reason = 'programmatic') => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', keydown);
		backdrop.remove();
		onDismiss?.(reason);
		if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
			previousFocus.focus();
		}
	};
	backdrop.addEventListener('mousedown', (event) => {
		if (event.target === backdrop) closeDialog(backdrop, 'backdrop');
	});
	document.addEventListener('keydown', keydown);
	document.getElementById('modal-root').appendChild(backdrop);
	return { backdrop, body, foot };
}

/** Standalone picker used by "Replace asset". Resolves to an asset descriptor. */
export function pickAsset(assetType = 'texture', options = {}) {
	if (assetType && typeof assetType === 'object') {
		options = assetType;
		assetType = options.assetType ?? 'texture';
	} else if (typeof options === 'string') {
		options = { currentKey: options };
	}
	const currentKey = options?.currentKey ?? null;
	const title = options?.title ??
		(assetType === 'spine' ? 'Choose a Spine asset' : 'Choose an image asset');
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const { backdrop, body, foot } = dialogShell(title, {
			onDismiss: () => finish(null),
		});
		let picked = null;
		const selection = document.createElement('div');
		selection.className = 'asset-picker-selection dim';
		selection.setAttribute('aria-live', 'polite');
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => closeDialog(backdrop, 'cancel'));
		const ok = document.createElement('button');
		ok.type = 'button';
		ok.className = 'primary';
		ok.textContent = options?.acceptLabel ?? 'Use asset';
		ok.disabled = true;
		const accept = (asset = picked) => {
			if (!asset || settled) return;
			finish(asset);
			closeDialog(backdrop, 'accepted');
		};
		ok.addEventListener('click', () => accept());
		const browser = buildAssetGrid({
			onPick: (asset) => {
				picked = asset;
				ok.disabled = false;
				selection.textContent =
					`Selected: ${asset.key}` +
					(asset.width && asset.height ? ` — ${asset.width}×${asset.height}px` : '');
			},
			onInvalidate: () => {
				picked = null;
				ok.disabled = true;
				selection.textContent = 'Selection cleared — choose an available asset.';
			},
			onAccept: accept,
			assetType,
			initialKey: currentKey,
		});
		body.appendChild(browser);
		body.appendChild(selection);
		foot.appendChild(cancel);
		foot.appendChild(ok);
		setTimeout(() => browser.focusSearch?.(), 0);
	});
}

export function showAddElementDialog(options = {}) {
	if (!state.preview.connected) return toast('Start the game preview first.');
	if (!state.preview.spawnWired) {
		toast('This game has not wired spawned elements — run Setup → Integration status.', 'error', 7000);
		return;
	}
	const dialogOptions = typeof options === 'string' ? { parentId: options } : (options ?? {});
	const requestedParentId = dialogOptions.parentId ?? null;
	const availableParents = buildParentOptions({
		definitions: state.overrides.working.elements ?? [],
		liveNodes: state.tree,
	}).filter(({ value }) => !state.temporaryContainerIds.has(value));
	if (requestedParentId && !availableParents.some(({ value }) => value === requestedParentId)) {
		const requestedNode = state.tree.find(({ id }) => id === requestedParentId);
		const contextOption = contextualParentOption(requestedNode);
		if (contextOption) availableParents.push(contextOption);
	}
	if (requestedParentId && !availableParents.some(({ value }) => value === requestedParentId)) {
		toast(
			`“${requestedParentId}” is no longer available as a Container or Graphics parent.`,
			'error',
			8000,
		);
		return;
	}
	const { backdrop, body, foot } = dialogShell(
		dialogOptions.title ?? (requestedParentId ? `Add child — ${requestedParentId}` : 'Add element'),
	);
	if (dialogOptions.intro) {
		const intro = document.createElement('div');
		intro.className = 'resp-notice';
		intro.textContent = dialogOptions.intro;
		body.appendChild(intro);
	}

	let kind = 'sprite';
	const pickedAssets = { sprite: null, spine: null };
	let spineAnimation = '';

	// type toggle
	const typeRow = document.createElement('div');
	typeRow.className = 'prop-row';
	typeRow.innerHTML = '<label>Type</label>';
	const btnSprite = document.createElement('button');
	btnSprite.textContent = 'Image asset';
	btnSprite.className = 'active';
	const btnSpine = document.createElement('button');
	btnSpine.textContent = 'Spine animation';
	if ((state.preview.bridgeVersion ?? 0) < SPINE_BRIDGE_VERSION) {
		btnSpine.disabled = true;
		btnSpine.title =
			'Update the game integration through Setup → Integration status before adding Spine elements.';
	}
	const btnContainer = document.createElement('button');
	btnContainer.textContent = 'Container (group)';
	typeRow.appendChild(btnSprite);
	typeRow.appendChild(btnSpine);
	typeRow.appendChild(btnContainer);
	body.appendChild(typeRow);

	// name
	const nameRow = document.createElement('div');
	nameRow.className = 'prop-row';
	nameRow.innerHTML = '<label>Name</label>';
	const nameInput = document.createElement('input');
	nameInput.style.flex = '1';
	nameInput.placeholder = dialogOptions.namePlaceholder ?? 'e.g. promoBanner';
	nameRow.appendChild(nameInput);
	body.appendChild(nameRow);

	// parent
	const parentRow = document.createElement('div');
	parentRow.className = 'prop-row';
	parentRow.innerHTML = '<label>Parent</label>';
	const parentSel = document.createElement('select');
	for (const option of availableParents) {
		const opt = document.createElement('option');
		opt.value = option.value;
		opt.textContent = option.label;
		opt.title = option.description;
		parentSel.appendChild(opt);
	}
	parentSel.value = recommendedParentValue(
		availableParents,
		requestedParentId ?? state.selection,
	);
	if (dialogOptions.lockParent) parentSel.disabled = true;
	parentRow.appendChild(parentSel);
	body.appendChild(parentRow);

	const hint = document.createElement('div');
	hint.className = 'dim';
	hint.style.margin = '4px 0';
	const updateParentHint = () => {
		const option = availableParents.find(({ value }) => value === parentSel.value);
		hint.textContent = parentHelpText(option);
		hint.className = option?.unsafe ? 'resp-notice' : 'dim';
		parentSel.title = hint.textContent;
	};
	updateParentHint();
	parentSel.addEventListener('change', updateParentHint);
	body.appendChild(hint);

	// Spine playback uses Stake's normal track-0 AnimationState contract.
	const animationRow = document.createElement('div');
	animationRow.className = 'prop-row';
	animationRow.style.display = 'none';
	animationRow.innerHTML = '<label>Animation</label>';
	const animationSelect = document.createElement('select');
	animationSelect.disabled = true;
	const loopLabel = document.createElement('label');
	loopLabel.className = 'inline-check';
	const loopInput = document.createElement('input');
	loopInput.type = 'checkbox';
	loopInput.checked = true;
	loopLabel.appendChild(loopInput);
	loopLabel.append(' Loop');
	animationRow.appendChild(animationSelect);
	animationRow.appendChild(loopLabel);
	body.appendChild(animationRow);
	animationSelect.addEventListener('change', () => {
		spineAnimation = animationSelect.value;
	});

	const useAssetName = (asset) => {
		if (!nameInput.value.trim()) {
			nameInput.value = asset.key
				.replace(/\.(png|webp|jpg|jpeg)$/i, '')
				.replace(/[^A-Za-z0-9_.-]+/g, '-');
		}
	};
	const populateAnimations = (asset) => {
		animationSelect.innerHTML = '';
		const animations = asset?.animations ?? [];
		if (!animations.length) {
			const option = document.createElement('option');
			option.value = '';
			option.textContent = 'Setup pose (no animations)';
			animationSelect.appendChild(option);
			animationSelect.disabled = true;
			loopInput.disabled = true;
			spineAnimation = '';
			return;
		}
		for (const name of animations) {
			const option = document.createElement('option');
			option.value = name;
			option.textContent = name;
			animationSelect.appendChild(option);
		}
		spineAnimation = preferredSpineAnimation(asset);
		animationSelect.value = spineAnimation;
		animationSelect.disabled = false;
		loopInput.disabled = false;
	};

	// Both visual types reuse the same browser/search/refresh/recheck component.
	const imageBrowser = buildAssetGrid({
		onPick: (asset) => {
			pickedAssets.sprite = asset;
			useAssetName(asset);
			validate();
		},
		onInvalidate: () => {
			pickedAssets.sprite = null;
			validate();
		},
		assetType: 'texture',
	});
	const spineBrowser = buildAssetGrid({
		onPick: (asset) => {
			pickedAssets.spine = asset;
			populateAnimations(asset);
			useAssetName(asset);
			validate();
		},
		onInvalidate: () => {
			pickedAssets.spine = null;
			populateAnimations(null);
			validate();
		},
		assetType: 'spine',
		defer: true,
	});
	spineBrowser.style.display = 'none';
	body.appendChild(imageBrowser);
	body.appendChild(spineBrowser);

	const error = document.createElement('div');
	error.className = 'dim';
	error.style.color = 'var(--warn)';
	foot.appendChild(error);

	const cancel = document.createElement('button');
	cancel.textContent = 'Cancel';
	cancel.addEventListener('click', () => closeDialog(backdrop));
	const ok = document.createElement('button');
	ok.className = 'primary';
	ok.textContent = dialogOptions.acceptLabel ?? 'Add element';
	ok.disabled = true;
	foot.appendChild(cancel);
	foot.appendChild(ok);

	const validate = () => {
		const id = nameInput.value.trim();
		const problem = validateElementId(id);
		error.textContent = id ? (problem ?? '') : '';
		ok.disabled = !!problem || (kind !== 'container' && !pickedAssets[kind]);
	};
	nameInput.addEventListener('input', validate);

	const setKind = (nextKind) => {
		kind = nextKind;
		btnSprite.classList.toggle('active', kind === 'sprite');
		btnSpine.classList.toggle('active', kind === 'spine');
		btnContainer.classList.toggle('active', kind === 'container');
		imageBrowser.style.display = kind === 'sprite' ? '' : 'none';
		spineBrowser.style.display = kind === 'spine' ? '' : 'none';
		animationRow.style.display = kind === 'spine' ? '' : 'none';
		if (kind === 'sprite') imageBrowser.ensureAssets().catch(() => {});
		if (kind === 'spine') spineBrowser.ensureAssets().catch(() => {});
		validate();
	};
	btnSprite.addEventListener('click', () => setKind('sprite'));
	btnSpine.addEventListener('click', () => setKind('spine'));
	btnContainer.addEventListener('click', () => setKind('container'));
	if (dialogOptions.initialKind) setKind(dialogOptions.initialKind);
	if (dialogOptions.lockKind) typeRow.style.display = 'none';

	ok.addEventListener('click', () => {
		const id = nameInput.value.trim();
		const parentId = parentSel.value === GLOBAL_STAGE_PARENT ? null : parentSel.value;
		const parentOption = availableParents.find(({ value }) => value === parentSel.value);
		const def = { id, kind, parentId, order: 0 };
		if (kind !== 'container') def.assetKey = pickedAssets[kind].key;
		if (kind === 'spine' && spineAnimation) {
			def.animationName = spineAnimation;
			def.loop = loopInput.checked;
		}
		// place stage-rooted elements near the screen center; others at parent origin
		let baseEntry = dialogOptions.rootAtOrigin && kind === 'container'
			? { x: 0, y: 0 }
			: parentId
			? { x: 0, y: 0 }
			: { x: Math.round(state.preview.gameW / 2), y: Math.round(state.preview.gameH / 2) };
		if (parentId && parentOption?.childDefaults) {
			const defaults = kind === 'sprite'
				? parentOption.childDefaults
				: {
					...(Number.isFinite(parentOption.childDefaults.x) ? { x: parentOption.childDefaults.x } : {}),
					...(Number.isFinite(parentOption.childDefaults.y) ? { y: parentOption.childDefaults.y } : {}),
				};
			baseEntry = { ...baseEntry, ...defaults };
		}
		if (!addSpawnedElement(def, baseEntry)) return;
		closeDialog(backdrop);
		state.selection = id;
		bridgeSend('select', { id });
		emit('selection');
		toast(
			dialogOptions.successMessage?.replace('{id}', id) ?? (parentOption?.unsafe
				? `Added “${id}” to the live parent “${parentId}”. Add a stable Pixi label before relying on this parent after reload.`
				: `Added “${id}” — drag it into place, then Save.`),
			parentOption?.unsafe ? 'error' : 'ok',
			parentOption?.unsafe ? 9000 : 4000,
		);
	});
}
