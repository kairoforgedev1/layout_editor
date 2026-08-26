/** Framework-free validation and bounded history for live game performance data. */

export const PERFORMANCE_HISTORY_LIMIT = 96;

const REQUIRED_FIELDS = ['fps', 'frameMs', 'updateMs', 'renderMs'];
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;

export function normalizePerformanceSample(value) {
	if (!value || typeof value !== 'object') return null;
	for (const field of REQUIRED_FIELDS) {
		if (!finiteNonNegative(value[field])) return null;
	}
	if (value.drawCalls !== null && !finiteNonNegative(value.drawCalls)) return null;
	if (value.drawCallsMin !== null && !finiteNonNegative(value.drawCallsMin)) return null;
	if (value.drawCallsMax !== null && !finiteNonNegative(value.drawCallsMax)) return null;
	if (!finiteNonNegative(value.timestamp)) return null;
	return {
		fps: value.fps,
		frameMs: value.frameMs,
		updateMs: value.updateMs,
		renderMs: value.renderMs,
		drawCalls: value.drawCalls,
		drawCallsMin: value.drawCallsMin,
		drawCallsMax: value.drawCallsMax,
		renderer: typeof value.renderer === 'string' && value.renderer ? value.renderer : 'unknown',
		timestamp: value.timestamp,
	};
}

export function createPerformanceHistory(limit = PERFORMANCE_HISTORY_LIMIT) {
	return {
		limit: Math.max(1, Math.floor(limit) || PERFORMANCE_HISTORY_LIMIT),
		samples: [],
		latest: null,
	};
}

export function appendPerformanceSample(history, value) {
	const sample = normalizePerformanceSample(value);
	if (!sample) return false;
	history.samples.push(sample);
	const overflow = history.samples.length - history.limit;
	if (overflow > 0) history.samples.splice(0, overflow);
	history.latest = sample;
	return true;
}

export function resetPerformanceHistory(history) {
	history.samples.length = 0;
	history.latest = null;
}

export function performanceMetricSummary(
	history,
	field,
	{ minField = field, maxField = field } = {},
) {
	const values = history.samples
		.map((sample) => sample[field])
		.filter(finiteNonNegative);
	if (!values.length) return null;
	const minima = history.samples
		.map((sample) => sample[minField])
		.filter(finiteNonNegative);
	const maxima = history.samples
		.map((sample) => sample[maxField])
		.filter(finiteNonNegative);
	return {
		current: values.at(-1),
		min: Math.min(...(minima.length ? minima : values)),
		avg: values.reduce((sum, value) => sum + value, 0) / values.length,
		max: Math.max(...(maxima.length ? maxima : values)),
	};
}
