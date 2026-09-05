/**
 * Panel chrome: a draggable divider for the element list, and an inspector that
 * gets out of the way when there is nothing to inspect.
 *
 * Both exist for one reason — the preview is the part of this window that
 * matters, and fixed-width side panels were taking space away from it.
 */
import { state } from './state.js';
import { applyViewport } from './viewport.js';

const $ = (id) => document.getElementById(id);

const LEFT_MIN = 200;
export const LEFT_DEFAULT = 270;
const NUDGE = 10;
const NUDGE_COARSE = 40;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** A drag must never eat the preview the list exists to describe. */
const leftMax = () => Math.max(LEFT_MIN, Math.round((window.innerWidth || 1280) * 0.5));

export function setLeftWidth(px) {
	const width = clamp(Math.round(Number(px)) || LEFT_DEFAULT, LEFT_MIN, leftMax());
	const left = $('left');
	if (!left) return width;
	if (state.panels.leftWidth === width && left.style.width) return width;
	left.style.width = `${width}px`;
	state.panels.leftWidth = width;
	// Fit is measured from the viewport box, which just changed.
	if (state.zoom.fit) applyViewport();
	return width;
}

/**
 * Hide the inspector column rather than leaving an empty 330px of panel.
 *
 * Callers pass whether there is anything to show; deciding that is the
 * inspector's business, not this module's.
 */
export function setInspectorVisible(visible) {
	const right = $('right');
	if (!right || right.hidden === !visible) return;
	right.hidden = !visible;
	if (state.zoom.fit) applyViewport();
}

/** One config write per gesture, not one per pointer sample. */
async function saveLeftWidth() {
	try {
		state.config = await window.editorHost.setConfig({
			leftPanelWidth: state.panels.leftWidth,
		});
	} catch {
		// A preference that failed to persist is not worth interrupting a resize.
	}
}

function initLeftResizer() {
	const resizer = $('left-resizer');
	const left = $('left');
	if (!resizer || !left) return;

	let pointerId = null;
	let startX = 0;
	let startWidth = 0;

	resizer.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) return;
		pointerId = event.pointerId;
		startX = event.clientX;
		startWidth = left.getBoundingClientRect().width;
		resizer.classList.add('dragging');
		document.body.classList.add('resizing');
		// Capture keeps the drag alive when the pointer crosses the game iframe,
		// which otherwise swallows the move events into the guest document.
		try {
			resizer.setPointerCapture(pointerId);
		} catch {
			// Older engines manage without it; the document listener still fires.
		}
		event.preventDefault();
	});

	resizer.addEventListener('pointermove', (event) => {
		if (pointerId === null || event.pointerId !== pointerId) return;
		setLeftWidth(startWidth + (event.clientX - startX));
	});

	const endDrag = (event) => {
		if (pointerId === null || event.pointerId !== pointerId) return;
		pointerId = null;
		resizer.classList.remove('dragging');
		document.body.classList.remove('resizing');
		void saveLeftWidth();
	};
	resizer.addEventListener('pointerup', endDrag);
	resizer.addEventListener('pointercancel', endDrag);

	// It is a real separator, so the arrow keys should move it.
	resizer.addEventListener('keydown', (event) => {
		const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
		if (event.key === 'ArrowLeft') setLeftWidth(state.panels.leftWidth - step);
		else if (event.key === 'ArrowRight') setLeftWidth(state.panels.leftWidth + step);
		else if (event.key === 'Home') setLeftWidth(LEFT_DEFAULT);
		else return;
		event.preventDefault();
		void saveLeftWidth();
	});

	resizer.addEventListener('dblclick', () => {
		setLeftWidth(LEFT_DEFAULT);
		void saveLeftWidth();
	});

	// Re-clamp when the window shrinks, so the list cannot end up wider than the
	// ceiling it was allowed at its old size.
	window.addEventListener('resize', () => setLeftWidth(state.panels.leftWidth));
}

/** Adopt the stored width; the resizer is wired first so it works regardless. */
async function restoreLeftWidth() {
	let stored = null;
	try {
		stored = (await window.editorHost.getConfig())?.leftPanelWidth ?? null;
	} catch {
		stored = null;
	}
	return setLeftWidth(stored ?? LEFT_DEFAULT);
}

export function initPanels() {
	initLeftResizer();
	setLeftWidth(LEFT_DEFAULT);
	return restoreLeftWidth();
}
