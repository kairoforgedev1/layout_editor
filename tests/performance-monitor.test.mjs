import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const metricsSource = await readFile(
	new URL('../src/renderer/js/performanceMetrics.js', import.meta.url),
	'utf8',
);
const {
	appendPerformanceSample,
	createPerformanceHistory,
	normalizePerformanceSample,
	performanceMetricSummary,
	resetPerformanceHistory,
} = await import(moduleUrl(metricsSource));

const {
	createPerformanceSampler,
	instrumentRendererDrawCalls,
} = await import('../resources/bridge/performanceSampler.ts');

const sample = (index, changes = {}) => ({
	fps: 60 + index,
	frameMs: 10 + index,
	updateMs: 4 + index,
	renderMs: 6,
	drawCalls: 2 + index,
	drawCallsMin: 1 + index,
	drawCallsMax: 3 + index,
	renderer: 'webgl',
	timestamp: index,
	...changes,
});

test('performance history is bounded, summarizes retained samples, and resets completely', () => {
	const history = createPerformanceHistory(3);
	for (let index = 0; index < 5; index++) {
		assert.equal(appendPerformanceSample(history, sample(index)), true);
	}

	assert.equal(history.limit, 3);
	assert.deepEqual(history.samples.map(({ timestamp }) => timestamp), [2, 3, 4]);
	assert.equal(history.latest.timestamp, 4);
	assert.deepEqual(performanceMetricSummary(history, 'fps'), {
		current: 64,
		min: 62,
		avg: 63,
		max: 64,
	});
	assert.deepEqual(
		performanceMetricSummary(history, 'drawCalls', {
			minField: 'drawCallsMin',
			maxField: 'drawCallsMax',
		}),
		{ current: 6, min: 3, avg: 5, max: 7 },
	);

	resetPerformanceHistory(history);
	assert.deepEqual(history.samples, []);
	assert.equal(history.latest, null);
	assert.equal(performanceMetricSummary(history, 'fps'), null);
	assert.equal(appendPerformanceSample(history, sample(10)), true);
	assert.deepEqual(history.samples.map(({ timestamp }) => timestamp), [10]);
});

test('performance samples reject malformed and non-finite metrics without changing history', () => {
	const history = createPerformanceHistory(4);
	const invalid = [
		null,
		{},
		sample(1, { fps: Number.NaN }),
		sample(1, { frameMs: Number.POSITIVE_INFINITY }),
		sample(1, { updateMs: -1 }),
		sample(1, { renderMs: undefined }),
		sample(1, { drawCalls: -1 }),
		sample(1, { drawCallsMin: Number.NaN }),
		sample(1, { drawCallsMax: Number.POSITIVE_INFINITY }),
		sample(1, { timestamp: -1 }),
	];
	for (const value of invalid) {
		assert.equal(normalizePerformanceSample(value), null);
		assert.equal(appendPerformanceSample(history, value), false);
	}
	assert.deepEqual(history.samples, []);
	assert.equal(history.latest, null);

	const unsupportedDrawCounter = sample(2, {
		drawCalls: null,
		drawCallsMin: null,
		drawCallsMax: null,
		renderer: '',
	});
	assert.equal(appendPerformanceSample(history, unsupportedDrawCounter), true);
	assert.equal(history.latest.renderer, 'unknown');
	assert.equal(history.latest.drawCalls, null);
});

class FakeRunner {
	items = [];

	add(item) {
		this.items.push(item);
	}

	remove(item) {
		const index = this.items.indexOf(item);
		if (index >= 0) this.items.splice(index, 1);
	}

	emit(method) {
		for (const item of [...this.items]) item?.[method]?.();
	}
}

const createSamplerHarness = ({ sampleIntervalMs = 50, suspendGapMs = 1000 } = {}) => {
	let clock = 0;
	let nativeDraws = 0;
	let sceneReads = 0;
	const listeners = [];
	const ticker = {
		add(fn, _context, priority) {
			listeners.push({ fn, priority });
		},
		remove(fn) {
			const index = listeners.findIndex((entry) => entry.fn === fn);
			if (index >= 0) listeners.splice(index, 1);
		},
	};
	const prerender = new FakeRunner();
	const postrender = new FakeRunner();
	const originalDraw = function () {
		nativeDraws += 1;
		return nativeDraws;
	};
	const renderer = {
		name: 'webgl',
		geometry: { draw: originalDraw },
		runners: { prerender, postrender },
	};
	const stage = {};
	Object.defineProperty(stage, 'children', {
		get() {
			sceneReads += 1;
			throw new Error('the constant-time sampler must not traverse the scene graph');
		},
	});
	const app = { ticker, renderer, stage };
	const samples = [];
	const sampler = createPerformanceSampler({
		getApp: () => app,
		post: (value) => samples.push(value),
		now: () => clock,
		sampleIntervalMs,
		suspendGapMs,
	});
	const frame = (start, updateMs = 2, renderMs = 3, draws = 0) => {
		const orderedListeners = [...listeners].sort((a, b) => b.priority - a.priority);
		clock = start;
		orderedListeners[0]?.fn();
		clock = start + updateMs;
		prerender.emit('prerender');
		for (let count = 0; count < draws; count++) renderer.geometry.draw();
		clock = start + updateMs + renderMs;
		postrender.emit('postrender');
		orderedListeners.at(-1)?.fn();
	};
	return {
		app,
		frame,
		listeners,
		originalDraw,
		postrender,
		prerender,
		renderer,
		sampler,
		samples,
		get nativeDraws() { return nativeDraws; },
		get sceneReads() { return sceneReads; },
	};
};

test('sampler emits at bounded cadence and counts actual WebGL draw submissions', () => {
	const harness = createSamplerHarness({ sampleIntervalMs: 50 });
	assert.equal(harness.sampler.start(), true);
	assert.equal(harness.sampler.start(), true, 'enabling twice must not attach duplicate hooks');
	assert.equal(harness.listeners.length, 2, 'one begin and one end callback bracket the app ticker');
	assert.equal(harness.listeners[0].priority, Number.POSITIVE_INFINITY);
	assert.equal(harness.listeners[1].priority, Number.NEGATIVE_INFINITY);
	assert.equal(harness.prerender.items.length, 1);
	assert.equal(harness.postrender.items.length, 1);

	harness.frame(0, 2, 3, 1);
	harness.frame(16, 2, 3, 3);
	harness.frame(32, 2, 3, 2);
	assert.equal(harness.samples.length, 0, 'frame callbacks must not post on every frame');
	harness.frame(48, 2, 3, 4);

	assert.deepEqual(harness.samples, [{
		fps: 62.5,
		frameMs: 5,
		updateMs: 2,
		renderMs: 3,
		drawCalls: 2.5,
		drawCallsMin: 1,
		drawCallsMax: 4,
		renderer: 'webgl',
		timestamp: 53,
	}]);
	assert.equal(harness.nativeDraws, 10, 'instrumentation must preserve the renderer method');
	assert.equal(harness.sceneReads, 0, 'sampling must remain constant-time with respect to scene size');

	harness.frame(64, 2, 3, 1);
	harness.frame(80, 2, 3, 1);
	harness.frame(96, 2, 3, 1);
	assert.equal(harness.samples.length, 1, 'the next interval has not elapsed yet');

	harness.sampler.setEnabled(false);
	assert.equal(harness.sampler.enabled, false);
	assert.equal(harness.listeners.length, 0);
	assert.equal(harness.prerender.items.length, 0);
	assert.equal(harness.postrender.items.length, 0);
	assert.equal(harness.renderer.geometry.draw, harness.originalDraw, 'disable must restore WebGL instrumentation');
	harness.frame(112, 2, 3, 5);
	assert.equal(harness.samples.length, 1, 'disabled sampling must not emit further metrics');
});

test('sampler resets its aggregation window after a suspended/background gap', () => {
	const harness = createSamplerHarness({ sampleIntervalMs: 30, suspendGapMs: 1000 });
	assert.equal(harness.sampler.setEnabled(true), true);
	harness.frame(0, 2, 3, 1);
	harness.frame(16, 2, 3, 1);
	assert.equal(harness.samples.length, 0);

	// A two-second pause must not become one giant frame or near-zero FPS sample.
	harness.frame(2000, 2, 3, 2);
	harness.frame(2016, 2, 3, 2);
	harness.frame(2032, 2, 3, 2);
	assert.equal(harness.samples.length, 1);
	assert.equal(harness.samples[0].fps, 62.5);
	assert.equal(harness.samples[0].frameMs, 5);
	assert.equal(harness.samples[0].drawCalls, 2);
	assert.equal(harness.samples[0].timestamp, 2037);
	harness.sampler.stop();
});

test('WebGPU draw instrumentation becomes supported after wrapping a native render pass', () => {
	let countedDraws = 0;
	let nativeDraws = 0;
	let nativeIndexedDraws = 0;
	let beginCalls = 0;
	let restoreCalls = 0;
	const pass = {
		draw(...args) {
			nativeDraws += 1;
			return `draw:${args.join(',')}`;
		},
		drawIndexed(...args) {
			nativeIndexedDraws += 1;
			return `indexed:${args.join(',')}`;
		},
	};
	const encoder = {
		renderPassEncoder: null,
		beginRenderPass(descriptor) {
			beginCalls += 1;
			this.renderPassEncoder = pass;
			return descriptor;
		},
		restoreRenderPass() {
			restoreCalls += 1;
			return this.renderPassEncoder;
		},
	};
	const originalBegin = encoder.beginRenderPass;
	const originalRestore = encoder.restoreRenderPass;
	const counter = instrumentRendererDrawCalls(
		{ name: 'webgpu', encoder },
		() => { countedDraws += 1; },
	);

	assert.equal(counter.backend, 'webgpu');
	assert.equal(counter.supported, false, 'encoder hooks alone do not prove native pass methods are writable');
	assert.notEqual(encoder.beginRenderPass, originalBegin);
	assert.notEqual(encoder.restoreRenderPass, originalRestore);
	assert.equal(encoder.beginRenderPass('main-pass'), 'main-pass');
	assert.equal(beginCalls, 1);
	assert.equal(counter.supported, true, 'support begins after draw submission methods are wrapped');

	assert.equal(pass.draw(3, 1), 'draw:3,1');
	assert.equal(pass.drawIndexed(6, 2), 'indexed:6,2');
	assert.equal(countedDraws, 2, 'draw and drawIndexed each represent one GPU submission');
	assert.equal(nativeDraws, 1, 'the original draw method still runs exactly once');
	assert.equal(nativeIndexedDraws, 1, 'the original indexed draw method still runs exactly once');

	counter.stop();
	assert.equal(encoder.beginRenderPass, originalBegin, 'stop restores the encoder begin hook');
	assert.equal(encoder.restoreRenderPass, originalRestore, 'stop restores the encoder restore hook');
	assert.equal(encoder.restoreRenderPass(), pass);
	assert.equal(restoreCalls, 1);
});

test('WebGPU draw support remains unavailable when native pass methods are immutable', () => {
	let countedDraws = 0;
	let nativeDraws = 0;
	const pass = {};
	Object.defineProperties(pass, {
		draw: {
			value() { nativeDraws += 1; },
			writable: false,
			configurable: false,
		},
		drawIndexed: {
			value() { nativeDraws += 1; },
			writable: false,
			configurable: false,
		},
	});
	const encoder = {
		renderPassEncoder: null,
		beginRenderPass() {
			this.renderPassEncoder = pass;
		},
		restoreRenderPass() {
			return this.renderPassEncoder;
		},
	};
	const originalBegin = encoder.beginRenderPass;
	const originalRestore = encoder.restoreRenderPass;
	const counter = instrumentRendererDrawCalls(
		{ name: 'webgpu', encoder },
		() => { countedDraws += 1; },
	);

	assert.equal(counter.supported, false);
	encoder.beginRenderPass();
	assert.equal(counter.supported, false, 'immutable GPU methods must be reported as unsupported');
	pass.draw();
	pass.drawIndexed();
	assert.equal(nativeDraws, 2);
	assert.equal(countedDraws, 0);

	counter.stop();
	assert.equal(encoder.beginRenderPass, originalBegin);
	assert.equal(encoder.restoreRenderPass, originalRestore);
});
