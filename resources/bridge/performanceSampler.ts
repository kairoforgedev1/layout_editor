/**
 * Low-overhead Pixi application performance sampler used only by editor sessions.
 *
 * The sampler is detached by default. When enabled it adds two constant-time
 * ticker callbacks plus Pixi renderer lifecycle probes and counts actual
 * renderer draw submissions. It never walks the scene graph or reads bounds.
 */

export const PERFORMANCE_SAMPLE_INTERVAL_MS = 250;
export const PERFORMANCE_SUSPEND_GAP_MS = 1000;

// Run before every normal application ticker listener. The actual render phase
// is measured with renderer lifecycle runners below, not approximate priorities.
const FRAME_BEGIN_PRIORITY = Number.POSITIVE_INFINITY;
const FRAME_END_PRIORITY = Number.NEGATIVE_INFINITY;

type AnyValue = any;

export type PerformanceSample = {
	fps: number;
	frameMs: number;
	updateMs: number;
	renderMs: number;
	drawCalls: number | null;
	drawCallsMin: number | null;
	drawCallsMax: number | null;
	renderer: string;
	timestamp: number;
};

type SamplerOptions = {
	getApp: () => AnyValue;
	post: (sample: PerformanceSample) => void;
	now?: () => number;
	sampleIntervalMs?: number;
	suspendGapMs?: number;
};

type DrawCounter = {
	backend: string;
	supported: boolean;
	stop: () => void;
};

const round = (value: number, decimals = 2) => {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
};

/** Patch one method defensively and return a lossless restore callback. */
const countMethod = (
	target: AnyValue,
	key: string,
	onCall: () => void,
): (() => void) | null => {
	const original = target?.[key];
	if (typeof original !== 'function') return null;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		onCall();
		return original.apply(this, args);
	};
	try {
		target[key] = wrapped;
		if (target[key] !== wrapped) return null;
	} catch {
		return null;
	}
	return () => {
		try {
			if (target[key] === wrapped) target[key] = original;
		} catch {
			// A renderer being destroyed during navigation needs no further cleanup.
		}
	};
};

/** Count real WebGL/WebGPU draw submissions for the installed Pixi 8 renderer. */
export function instrumentRendererDrawCalls(
	renderer: AnyValue,
	onDraw: () => void,
): DrawCounter {
	const restores: (() => void)[] = [];
	let submissionHookActive = false;
	const backend = String(renderer?.name ?? (
		renderer?.geometry?.draw ? 'webgl' : renderer?.encoder?.draw ? 'webgpu' : 'unknown'
	)).toLowerCase();

	if (renderer?.geometry?.draw) {
		// Every WebGL batch/custom render path ends in GlGeometrySystem.draw().
		const restore = countMethod(renderer.geometry, 'draw', onDraw);
		if (restore) {
			restores.push(restore);
			submissionHookActive = true;
		}
	} else if (renderer?.encoder?.beginRenderPass) {
		// WebGPU pipes (batches, Graphics, custom geometry) can either call
		// GpuEncoderSystem.draw() or submit directly to its current render pass.
		// Instrumenting draw/drawIndexed on every pass counts both without double
		// counting and includes non-batchable Graphics.
		const encoder = renderer.encoder;
		const instrumentPass = () => {
			const pass = encoder.renderPassEncoder;
			const draw = countMethod(pass, 'draw', onDraw);
			const drawIndexed = countMethod(pass, 'drawIndexed', onDraw);
			if (draw || drawIndexed) submissionHookActive = true;
		};
		for (const key of ['beginRenderPass', 'restoreRenderPass']) {
			const original = encoder[key];
			if (typeof original !== 'function') continue;
			const wrapped = function (this: unknown, ...args: unknown[]) {
				const result = original.apply(this, args);
				instrumentPass();
				return result;
			};
			try {
				encoder[key] = wrapped;
				if (encoder[key] === wrapped) {
					restores.push(() => {
						try {
							if (encoder[key] === wrapped) encoder[key] = original;
						} catch {
							// Renderer teardown owns the remaining object lifetime.
						}
					});
				}
			} catch {
				// Keep draw-call support unavailable if native objects are immutable.
			}
		}
	}

	return {
		backend,
		get supported() {
			// WebGPU native methods are only known to be writable after the first
			// pass begins. Until then the UI correctly reports draw calls as N/A.
			return submissionHookActive;
		},
		stop: () => {
			for (let index = restores.length - 1; index >= 0; index--) restores[index]();
			restores.length = 0;
		},
	};
}

export function createPerformanceSampler({
	getApp,
	post,
	now = () => performance.now(),
	sampleIntervalMs = PERFORMANCE_SAMPLE_INTERVAL_MS,
	suspendGapMs = PERFORMANCE_SUSPEND_GAP_MS,
}: SamplerOptions) {
	let active = false;
	let ticker: AnyValue = null;
	let renderer: AnyValue = null;
	let renderHooks: AnyValue = null;
	let drawCounter: DrawCounter | null = null;
	let frameStart: number | null = null;
	let renderStart: number | null = null;
	let currentRenderMs = 0;
	let currentDrawCalls = 0;
	let lastFrameStart: number | null = null;
	let windowStart = 0;
	let frameCount = 0;
	let frameGapCount = 0;
	let frameGapTotal = 0;
	let frameMsTotal = 0;
	let updateMsTotal = 0;
	let renderMsTotal = 0;
	let drawCallsTotal = 0;
	let drawCallsMin = Number.POSITIVE_INFINITY;
	let drawCallsMax = 0;

	const resetWindow = (stamp: number) => {
		windowStart = stamp;
		frameCount = 0;
		frameGapCount = 0;
		frameGapTotal = 0;
		frameMsTotal = 0;
		updateMsTotal = 0;
		renderMsTotal = 0;
		drawCallsTotal = 0;
		drawCallsMin = Number.POSITIVE_INFINITY;
		drawCallsMax = 0;
	};

	const beginFrame = () => {
		if (!active) return;
		const stamp = now();
		if (!Number.isFinite(stamp)) return;
		if (lastFrameStart !== null) {
			const gap = stamp - lastFrameStart;
			if (gap > suspendGapMs) {
				// Ignore background-tab/devtools pauses instead of reporting a false
				// multi-second frame and near-zero FPS.
				resetWindow(stamp);
			} else if (gap > 0) {
				frameGapTotal += gap;
				frameGapCount++;
			}
		}
		lastFrameStart = stamp;
		frameStart = stamp;
		renderStart = null;
		currentRenderMs = 0;
		currentDrawCalls = 0;
	};

	const beforeRender = () => {
		if (!active || frameStart === null) return;
		const stamp = now();
		if (!Number.isFinite(stamp) || stamp < frameStart) return;
		if (renderStart === null) renderStart = stamp;
	};

	const afterRender = () => {
		if (!active || frameStart === null || renderStart === null) return;
		const stamp = now();
		if (!Number.isFinite(stamp) || stamp < renderStart) return;
		currentRenderMs += stamp - renderStart;
		renderStart = null;
	};

	const endFrame = () => {
		if (!active || frameStart === null) return;
		const stamp = now();
		if (!Number.isFinite(stamp) || stamp < frameStart) return;
		if (renderStart !== null && stamp >= renderStart) {
			currentRenderMs += stamp - renderStart;
			renderStart = null;
		}
		const frameMs = stamp - frameStart;
		const renderMs = Math.min(frameMs, currentRenderMs);
		const updateMs = Math.max(0, frameMs - renderMs);
		frameStart = null;
		if (frameMs > suspendGapMs) {
			resetWindow(stamp);
			return;
		}

		frameCount++;
		frameMsTotal += frameMs;
		updateMsTotal += updateMs;
		renderMsTotal += renderMs;
		if (drawCounter?.supported) {
			drawCallsTotal += currentDrawCalls;
			drawCallsMin = Math.min(drawCallsMin, currentDrawCalls);
			drawCallsMax = Math.max(drawCallsMax, currentDrawCalls);
		}

		if (
			stamp - windowStart < sampleIntervalMs ||
			frameCount === 0 ||
			frameGapCount === 0
		) return;

		const drawSupported = !!drawCounter?.supported && drawCallsMin !== Number.POSITIVE_INFINITY;
		post({
			fps: round((frameGapCount * 1000) / frameGapTotal),
			frameMs: round(frameMsTotal / frameCount),
			updateMs: round(updateMsTotal / frameCount),
			renderMs: round(renderMsTotal / frameCount),
			drawCalls: drawSupported ? round(drawCallsTotal / frameCount) : null,
			drawCallsMin: drawSupported ? drawCallsMin : null,
			drawCallsMax: drawSupported ? drawCallsMax : null,
			renderer: drawCounter?.backend ?? 'unknown',
			timestamp: round(stamp),
		});
		resetWindow(stamp);
	};

	const onDraw = () => {
		if (active && frameStart !== null) currentDrawCalls++;
	};

	const start = () => {
		if (active) return true;
		const app = getApp?.();
		if (
			!app?.ticker?.add ||
			!app?.ticker?.remove ||
			!app?.renderer?.runners?.prerender?.add ||
			!app?.renderer?.runners?.postrender?.add
		) return false;
		ticker = app.ticker;
		renderer = app.renderer;
		drawCounter = instrumentRendererDrawCalls(renderer, onDraw);
		renderHooks = { prerender: beforeRender, postrender: afterRender };
		active = true;
		lastFrameStart = null;
		frameStart = null;
		renderStart = null;
		const stamp = now();
		resetWindow(Number.isFinite(stamp) ? stamp : 0);
		ticker.add(beginFrame, undefined, FRAME_BEGIN_PRIORITY);
		ticker.add(endFrame, undefined, FRAME_END_PRIORITY);
		renderer.runners?.prerender?.add?.(renderHooks);
		// SystemRunner.add appends. Move the start hook to the front so update time
		// ends before any renderer work; keep postrender appended to include teardown.
		const prerenderItems = renderer.runners?.prerender?.items;
		const hookIndex = prerenderItems?.indexOf?.(renderHooks) ?? -1;
		if (hookIndex > 0) prerenderItems.unshift(prerenderItems.splice(hookIndex, 1)[0]);
		renderer.runners?.postrender?.add?.(renderHooks);
		return true;
	};

	const stop = () => {
		if (!active) return;
		active = false;
		try {
			ticker?.remove?.(beginFrame);
			ticker?.remove?.(endFrame);
			renderer?.runners?.prerender?.remove?.(renderHooks);
			renderer?.runners?.postrender?.remove?.(renderHooks);
		} catch {
			// Navigation may destroy the application before beforeunload runs.
		}
		drawCounter?.stop();
		ticker = null;
		renderer = null;
		renderHooks = null;
		drawCounter = null;
		frameStart = null;
		renderStart = null;
		lastFrameStart = null;
	};

	return {
		start,
		stop,
		setEnabled: (enabled: boolean) => enabled ? start() : (stop(), true),
		get enabled() {
			return active;
		},
	};
}
