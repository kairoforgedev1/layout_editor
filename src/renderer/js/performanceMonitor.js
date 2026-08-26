/** Docked, low-frequency performance monitor UI. */
import { state, emit, on } from './state.js';
import { bridgeSend } from './bridge.js';
import { applyViewport } from './viewport.js';
import {
	appendPerformanceSample,
	createPerformanceHistory,
	performanceMetricSummary,
	resetPerformanceHistory,
} from './performanceMetrics.js';

const history = createPerformanceHistory();
const $ = (id) => document.getElementById(id);

const METRICS = [
	{ field: 'fps', prefix: 'fps', unit: ' fps', decimals: 1, floor: 60 },
	{ field: 'updateMs', prefix: 'update', unit: ' ms', decimals: 2, floor: 4 },
	{ field: 'renderMs', prefix: 'render', unit: ' ms', decimals: 2, floor: 4 },
	{
		field: 'drawCalls',
		prefix: 'draw',
		unit: '',
		decimals: 1,
		floor: 10,
		minField: 'drawCallsMin',
		maxField: 'drawCallsMax',
	},
];

const format = (value, decimals, unit = '') =>
	Number.isFinite(value) ? `${value.toFixed(decimals)}${unit}` : '—';

const drawChart = (canvas, values, floor) => {
	const cssWidth = Math.max(1, canvas.clientWidth || 240);
	const cssHeight = Math.max(1, canvas.clientHeight || 72);
	const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
	const width = Math.round(cssWidth * ratio);
	const height = Math.round(cssHeight * ratio);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, width, height);
	if (!values.length) return;
	const max = Math.max(floor, ...values) * 1.1;
	ctx.strokeStyle = '#252a32';
	ctx.lineWidth = ratio;
	for (const fraction of [0.25, 0.5, 0.75]) {
		const y = Math.round(height * fraction) + 0.5;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}
	ctx.strokeStyle = '#ff5f56';
	ctx.lineWidth = 1.5 * ratio;
	ctx.lineJoin = 'round';
	ctx.beginPath();
	for (let index = 0; index < values.length; index++) {
		const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
		const y = height - Math.min(height, (values[index] / max) * height);
		if (index === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.stroke();
};

const renderMetric = (metric) => {
	const summary = performanceMetricSummary(history, metric.field, metric);
	const value = $(`perf-${metric.prefix}-value`);
	const stats = $(`perf-${metric.prefix}-stats`);
	const canvas = $(`perf-${metric.prefix}-chart`);
	if (!summary) {
		value.textContent = '—';
		stats.textContent = 'min — · avg — · max —';
		drawChart(canvas, [], metric.floor);
		return;
	}
	value.textContent = format(summary.current, metric.decimals, metric.unit);
	stats.textContent =
		`min ${format(summary.min, metric.decimals)} · ` +
		`avg ${format(summary.avg, metric.decimals)} · ` +
		`max ${format(summary.max, metric.decimals)}`;
	drawChart(
		canvas,
		history.samples.map((sample) => sample[metric.field]).filter(Number.isFinite),
		metric.floor,
	);
};

const render = () => {
	const panel = $('performance-panel');
	const button = $('btn-performance');
	panel.classList.toggle('hidden', !state.performance.open);
	button.classList.toggle('active', state.performance.open);
	button.setAttribute('aria-expanded', String(state.performance.open));
	const status = $('perf-status');
	if (!state.preview.connected) status.textContent = 'Waiting for game preview…';
	else if (!state.performance.available) status.textContent = 'Update the project bridge to enable metrics.';
	else if (!history.latest) status.textContent = 'Collecting first sample…';
	else status.textContent = `${history.latest.renderer} · ${history.samples.length} samples`;
	for (const metric of METRICS) renderMetric(metric);
};

const sendEnabled = () => {
	if (state.preview.connected && state.performance.available) {
		bridgeSend('performanceMonitor', { enabled: state.performance.open });
	}
};

export function setPerformanceMonitorOpen(open, { restoreFocus = true } = {}) {
	const next = !!open;
	if (state.performance.open === next) return;
	state.performance.open = next;
	if (!next) {
		state.performance.latest = null;
		resetPerformanceHistory(history);
	}
	sendEnabled();
	render();
	emit('performanceOpen', next);
	requestAnimationFrame(() => {
		if (state.zoom.fit) applyViewport();
		if (!next && restoreFocus) $('btn-performance').focus();
	});
}

export const togglePerformanceMonitor = () =>
	setPerformanceMonitorOpen(!state.performance.open);

export function initPerformanceMonitor() {
	$('btn-performance').addEventListener('click', togglePerformanceMonitor);
	$('btn-performance-close').addEventListener('click', () => setPerformanceMonitorOpen(false));
	on('performance', (sample) => {
		if (!state.performance.open || !appendPerformanceSample(history, sample)) return;
		state.performance.latest = history.latest;
		render();
	});
	on('preview', () => {
		if (!state.preview.connected) {
			state.performance.latest = null;
			resetPerformanceHistory(history);
		} else sendEnabled();
		render();
	});
	on('project', () => {
		state.performance.latest = null;
		resetPerformanceHistory(history);
		render();
	});
	window.addEventListener('resize', () => state.performance.open && render());
	render();
}
