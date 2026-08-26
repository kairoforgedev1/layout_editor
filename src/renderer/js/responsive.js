/**
 * Responsive-layout editor operations.
 *
 * Every mutation is sent to the in-game bridge. The bridge owns live Pixi
 * geometry, performs source-aware base/profile edits, preserves appearance, and
 * returns one atomic commit for undo/redo.
 */
import { state } from './state.js';
import { bridgeSend } from './bridge.js';
import { activeScopeProfile } from './overrides.js';

export const responsiveActive = (cfg) =>
	!!cfg &&
	typeof cfg === 'object' &&
	(!!cfg.x || !!cfg.y || !!cfg.stretchX || !!cfg.stretchY || !!cfg.aspect ||
		cfg.logicalW != null || cfg.logicalH != null ||
		(!!cfg.scaleMode && cfg.scaleMode !== 'parent'));

export const positionResponsive = (cfg) =>
	!!cfg && typeof cfg === 'object' && (!!cfg.x || !!cfg.y || !!cfg.stretchX || !!cfg.stretchY);

export const scaleModeOf = (cfg) =>
	cfg && typeof cfg === 'object' ? (cfg.scaleMode ?? 'parent') : 'parent';

export const sizeModeOf = (cfg) => {
	if (!cfg || typeof cfg !== 'object') return 'parent';
	return cfg.aspect ?? cfg.scaleMode ?? 'parent';
};

export const referenceOf = (cfg) =>
	cfg && typeof cfg === 'object' ? (cfg.ref ?? 'viewport') : 'viewport';

export const axisModeOf = (cfg, axis) => {
	if (!cfg || typeof cfg !== 'object') return 'none';
	const stretch = axis === 'x' ? cfg.stretchX : cfg.stretchY;
	if (stretch) return 'stretch';
	const rule = cfg[axis];
	if (!rule) return 'none';
	if (rule.anchor >= 0.75) return 'end';
	if (rule.anchor >= 0.25) return 'center';
	return 'start';
};

export const SIZE_MODES = [
	{
		value: 'parent',
		label: 'Inherit parent (native)',
		hint: 'No extra size calculation. The element follows its Pixi parent exactly once.',
	},
	{
		value: 'game',
		label: 'Follow Stake game layout',
		hint: 'Uses the exact mainLayout scale and design-space position used by Stake game content.',
	},
	{
		value: 'fixed',
		label: 'Keep screen-pixel size',
		hint: 'Cancels ancestor scaling so the on-screen size stays constant.',
	},
	{
		value: 'contain',
		label: 'Fit inside reference',
		hint: 'Uniformly contains the asset inside the selected reference frame.',
	},
	{
		value: 'cover',
		label: 'Cover reference',
		hint: 'Uniformly covers the selected reference frame (background behavior).',
	},
];

export const selectionResponsive = () => state.values?.responsive ?? null;

const sendOp = (id, op) =>
	bridgeSend('responsive', { id, scope: activeScopeProfile(), ...op });

export const setAxisMode = (id, axis, mode, ref) =>
	sendOp(id, { op: 'axis', axis, mode, ref });

export const setReference = (id, ref) => sendOp(id, { op: 'ref', ref });
export const clearResponsive = (id) => sendOp(id, { op: 'clear' });
export const inheritResponsive = (id) => sendOp(id, { op: 'inherit' });

export const setScaleMode = (id, mode, ref) => sendOp(id, { op: 'scaleMode', mode, ref });
export const setAspect = (id, mode, ref) => sendOp(id, { op: 'aspect', mode, ref });
export const setSizeMode = (id, mode, ref) => {
	if (mode === 'contain' || mode === 'cover') setAspect(id, mode, ref);
	else setScaleMode(id, mode, ref);
};

/** Fill both axes atomically. `zero` removes all margins (viewport background). */
export const fillFrame = (id, ref, zero = false) =>
	sendOp(id, { op: 'fill', ref, zero });

export const fillParent = (id, ref) => fillFrame(id, ref, false);
export const fullscreen = (id, ref = 'viewport') => fillFrame(id, ref, true);

export function setScaleBase(id, value) {
	if (!(value > 0)) return;
	// The bridge applies this magnitude to the rule at the active edit target,
	// preserving its X/Y ratio and mirror signs. The renderer's effective rule may
	// come from a different profile while Base is being edited.
	sendOp(id, { op: 'scaleBase', value });
}

export function setResponsiveNumber(id, group, field, value) {
	if (!Number.isFinite(value)) return;
	sendOp(id, { op: 'number', group, field, value });
}

// Compatibility helpers for integrations/extensions that used the v5 UI API.
export const setAnchor = (id, ax, ay) => sendOp(id, { op: 'anchor', ax, ay });
export const toggleStretchX = (id, on) => sendOp(id, { op: 'stretchX', on });
export const toggleStretchY = (id, on) => sendOp(id, { op: 'stretchY', on });
