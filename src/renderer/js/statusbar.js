/** Bottom status bar + log panel. */
import { state, on } from './state.js';
import { aspectString } from './resolutions.js';
import { unsavedCount } from './overrides.js';

const $ = (id) => document.getElementById(id);

const dot = (status) =>
	status === 'ready' || status === 'remote'
		? '<span class="ok">●</span>'
		: status === 'starting'
			? '<span class="warn">●</span>'
			: status === 'error'
				? '<span class="bad">●</span>'
				: '○';

function renderStatus() {
	$('st-project').textContent = state.project ? state.project.appName : 'no project';
	$('st-project').title = state.project?.appDir ?? '';
	$('st-dev').innerHTML = `dev ${dot(state.procs.dev.status)}${state.procs.dev.port ? ' :' + state.procs.dev.port : ''}`;
	$('st-rgs').innerHTML = `rgs ${dot(state.procs.rgs.status)}${state.procs.rgs.port ? ' :' + state.procs.rgs.port : ''}`;
	const { width, height } = state.resolution;
	$('st-res').textContent = `${width}×${height} (${aspectString(width, height)})`;
	const previewBit = state.preview.connected
		? `profile: ${state.preview.layoutType}`
		: state.preview.status === 'loading' || state.preview.status === 'starting'
			? `preview ${state.preview.status}…`
			: 'preview off';
	$('st-profile').textContent = `${previewBit} · target: ${state.scope === 'base' ? 'base' : state.preview.layoutType ?? 'profile'} · ${state.mode} mode`;
	$('st-state').textContent = state.gameState ? `state: ${state.gameState}` : '';
	const values = state.values;
	$('st-sel').textContent =
		state.selection && values
			? `${state.selection}  x:${Math.round(values.effective.x)} y:${Math.round(values.effective.y)} ` +
				`${Math.round(values.bounds?.width ?? 0)}×${Math.round(values.bounds?.height ?? 0)}px`
			: '';
	const unsaved = unsavedCount();
	const el = $('st-unsaved');
	el.textContent = unsaved ? `● ${unsaved} unsaved change(s)` : 'all changes saved';
	el.classList.toggle('dirty', unsaved > 0);
}

// The game streams `values` ~60×/sec while an element is selected. Only the live
// selection read-out reflects it — recomputing the whole bar (incl. the unsaved
// diff, which idle animation can't change) every frame was wasted work and lag.
function updateLiveSelectionStatus() {
	const values = state.values;
	$('st-state').textContent = state.gameState ? `state: ${state.gameState}` : '';
	$('st-sel').textContent =
		state.selection && values
			? `${state.selection}  x:${Math.round(values.effective.x)} y:${Math.round(values.effective.y)} ` +
				`${Math.round(values.bounds?.width ?? 0)}×${Math.round(values.bounds?.height ?? 0)}px`
			: '';
}

const MAX_LOG_LINES = 600;

function initLogPanel() {
	const bodies = {
		dev: $('log-dev'),
		rgs: $('log-rgs'),
		editor: $('log-editor'),
	};
	on('log', ({ source, line }) => {
		const body = bodies[source] ?? bodies.editor;
		body.textContent += line + '\n';
		const lines = body.textContent.split('\n');
		if (lines.length > MAX_LOG_LINES) body.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
		if (!document.getElementById('logpanel').classList.contains('hidden')) {
			body.scrollTop = body.scrollHeight;
		}
	});
	for (const tab of document.querySelectorAll('.log-tabs button[data-tab]')) {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.log-tabs button[data-tab]').forEach((b) => b.classList.remove('active'));
			document.querySelectorAll('.log-body').forEach((b) => b.classList.remove('active'));
			tab.classList.add('active');
			bodies[tab.dataset.tab].classList.add('active');
		});
	}
	$('btn-log-clear').addEventListener('click', () => {
		document.querySelector('.log-body.active').textContent = '';
	});
	$('btn-log-close').addEventListener('click', () => {
		document.getElementById('logpanel').classList.add('hidden');
	});
}

export function initStatusbar() {
	for (const event of ['project', 'proc', 'preview', 'overrides', 'selection', 'resolution', 'mode', 'scope']) {
		on(event, renderStatus);
	}
	on('values', updateLiveSelectionStatus);
	initLogPanel();
	renderStatus();
}
