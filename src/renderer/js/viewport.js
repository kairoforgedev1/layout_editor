/** Center preview viewport: resolution, zoom (fit/manual), stage sizing. */
import { state, emit, on, log } from './state.js';
import { PRESETS, computeLayoutType, aspectString } from './resolutions.js';
import { bridgeRequest } from './bridge.js';

const ZOOM_STEPS = [0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

const els = {};
let viewportGeneration = 0;

const fitScale = () => {
	const vp = els.viewport.getBoundingClientRect();
	const { width, height } = state.resolution;
	return Math.min((vp.width - 48) / width, (vp.height - 48) / height, 1);
};

export const currentScale = () => (state.zoom.fit ? fitScale() : state.zoom.level);

export function applyViewport() {
	const { width, height } = state.resolution;
	const scale = Math.max(0.05, currentScale());
	els.stage.style.width = `${width}px`;
	els.stage.style.height = `${height}px`;
	els.stage.style.transform = `scale(${scale})`;
	els.stageOuter.style.width = `${width * scale + 48}px`;
	els.stageOuter.style.height = `${height * scale + 48}px`;
	els.zoomLabel.textContent = state.zoom.fit ? `fit ${(scale * 100).toFixed(0)}%` : `${(scale * 100).toFixed(0)}%`;
	els.vpRes.textContent = `${width} × ${height}  ·  ${aspectString(width, height)}  ·  expected profile: ${computeLayoutType(width, height)}`;
	els.stage.classList.toggle('loaded', !!state.preview.url);
}

/**
 * Wait until the iframe, Stake's mainLayout and Pixi's renderer all agree on
 * one viewport generation. Hiding the iframe during these few frames prevents
 * users from seeing an intermediate size paired with an old position.
 */
export async function syncViewportToGame() {
	if (!state.preview.connected) return false;
	const generation = ++viewportGeneration;
	const { width, height } = state.resolution;
	els.stage.classList.add('syncing');
	await new Promise((resolve) => requestAnimationFrame(resolve));
	if (generation !== viewportGeneration) return false;
	try {
		const result = await bridgeRequest('viewportResize', { generation, width, height }, 3000);
		if (generation !== viewportGeneration || result?.superseded) return false;
		if (!result?.ok) throw new Error(result?.error ?? 'game did not acknowledge the viewport');
		state.preview.layoutType = result.layoutType ?? state.preview.layoutType;
		state.preview.gameW = result.width ?? state.preview.gameW;
		state.preview.gameH = result.height ?? state.preview.gameH;
		emit('preview');
		return true;
	} catch (error) {
		if (generation === viewportGeneration) {
			log('editor', `[viewport] layout synchronisation failed: ${error.message ?? error}`);
		}
		return false;
	} finally {
		if (generation === viewportGeneration) els.stage.classList.remove('syncing');
	}
}

export function setResolution(width, height, presetIndex = -1) {
	state.resolution.width = Math.max(200, Math.round(width));
	state.resolution.height = Math.max(200, Math.round(height));
	state.resolution.presetIndex = presetIndex;
	applyViewport();
	emit('resolution');
	void syncViewportToGame();
}

export function setPreset(index, keepOrientation = true) {
	const preset = PRESETS[index];
	if (!preset) return;
	let { w, h } = preset;
	if (keepOrientation) {
		const currentLandscape = state.resolution.width >= state.resolution.height;
		const presetLandscape = w >= h;
		if (currentLandscape !== presetLandscape) [w, h] = [h, w];
	}
	setResolution(w, h, index);
}

export function toggleOrientation() {
	setResolution(state.resolution.height, state.resolution.width, state.resolution.presetIndex);
}

function zoomStep(direction) {
	const current = currentScale();
	let index = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
	if (index === -1) index = ZOOM_STEPS.length - 1;
	index = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
	state.zoom = { fit: false, level: ZOOM_STEPS[index] };
	applyViewport();
}

export function initViewport() {
	els.viewport = document.getElementById('viewport');
	els.stageOuter = document.getElementById('stage-outer');
	els.stage = document.getElementById('stage');
	els.zoomLabel = document.getElementById('zoom-label');
	els.vpRes = document.getElementById('vp-res');

	document.getElementById('btn-zoom-in').addEventListener('click', () => zoomStep(1));
	document.getElementById('btn-zoom-out').addEventListener('click', () => zoomStep(-1));
	document.getElementById('btn-zoom-fit').addEventListener('click', () => {
		state.zoom = { fit: true, level: 1 };
		applyViewport();
	});
	document.getElementById('btn-zoom-100').addEventListener('click', () => {
		state.zoom = { fit: false, level: 1 };
		applyViewport();
	});
	els.viewport.addEventListener(
		'wheel',
		(event) => {
			if (!event.ctrlKey) return;
			event.preventDefault();
			zoomStep(event.deltaY < 0 ? 1 : -1);
		},
		{ passive: false },
	);

	window.addEventListener('resize', () => state.zoom.fit && applyViewport());
	on('preview', applyViewport);
	applyViewport();
}
