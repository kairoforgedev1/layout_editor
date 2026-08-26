import assert from 'node:assert/strict';
import test from 'node:test';

// The runtime is intentionally framework-free apart from Svelte's $state rune.
// Supplying its identity form lets these tests execute the real TypeScript module
// directly under Node's built-in type stripping, without a bundler or Pixi.
globalThis.$state = (value) => value;
globalThis.window = {
	innerWidth: 1280,
	innerHeight: 720,
	addEventListener() {},
};

const responsive = await import('../resources/bridge/layoutOverrides.svelte.ts');

// The production Spine integration supplies SetupPoseBoundsProvider here. Keep
// these framework-free solver tests independent of Pixi/Spine packages while
// exercising the same fixed-rectangle contract.
responsive.registerSpineLayoutBoundsResolver((node) => {
	const data = node?.skeleton?.data;
	if (!data || !Number.isFinite(data.width) || !Number.isFinite(data.height) ||
		data.width <= 0 || data.height <= 0) return null;
	return {
		x: Number.isFinite(data.x) ? data.x : 0,
		y: Number.isFinite(data.y) ? data.y : 0,
		width: data.width,
		height: data.height,
	};
});

const identityTransform = () => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

const makeParent = ({ scaleX = 1, scaleY = 1, parent = null } = {}) => ({
	scale: { x: scaleX, y: scaleY },
	parent,
	getGlobalTransform: identityTransform,
});

const makeSprite = ({
	parent = null,
	width = 100,
	height = 50,
	scaleX = 1,
	scaleY = 1,
	anchorX = 0,
	anchorY = 0,
} = {}) => ({
	parent,
	width,
	height,
	scale: { x: scaleX, y: scaleY },
	anchor: { x: anchorX, y: anchorY },
	texture: {},
});

test('viewport pins and stretches stay tied to viewport edges', () => {
	window.innerWidth = 1200;
	window.innerHeight = 800;

	const pinned = makeSprite();
	const pinResult = responsive.computeResponsive(pinned, {
		ref: 'viewport',
		x: { anchor: 1, offset: -20 },
		y: { anchor: 0.5, offset: 10 },
	});

	assert.deepEqual(pinResult.ref, { x: 0, y: 0, width: 1200, height: 800 });
	assert.equal(pinResult.out.x, 1080);
	assert.equal(pinResult.out.y, 385);
	assert.equal(pinResult.out.x + pinned.width, 1180, 'the visible right edge keeps its 20px margin');
	assert.equal(pinResult.out.y + pinned.height / 2, 410, 'the visible center receives the saved offset');

	const stretched = makeSprite({ anchorX: 0.5, anchorY: 0.5 });
	const stretchResult = responsive.computeResponsive(stretched, {
		ref: 'viewport',
		stretchX: { m0: 10, m1: 30 },
		stretchY: { m0: 20, m1: 20 },
	});

	assert.deepEqual(stretchResult.out, {
		x: 590,
		y: 400,
		width: 1160,
		height: 760,
	});
});

test('stretch placement respects a pivoted, horizontally mirrored transform origin', () => {
	window.innerWidth = 1200;
	window.innerHeight = 800;

	// Local bounds are 100x50, scaled -2x/+3x around a 25,10 pivot. Pixi's
	// local transform therefore places node.x/y 75% across and 20% down the
	// transformed visual AABB (the horizontal ratio flips because of mirroring).
	const node = {
		parent: null,
		x: 300,
		y: 200,
		width: 200,
		height: 150,
		scale: { x: -2, y: 3 },
		anchor: { x: 0, y: 0 },
		texture: {},
		getLocalBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
		getLocalTransform: () => ({ a: -2, b: 0, c: 0, d: 3, tx: 350, ty: 170 }),
	};

	const { out } = responsive.computeResponsive(node, {
		ref: 'viewport',
		stretchX: { m0: 10, m1: 30 },
		stretchY: { m0: 20, m1: 40 },
	});

	assert.deepEqual(out, {
		x: 880,
		y: 168,
		width: 1160,
		height: 740,
	});
	assert.equal(out.x - out.width * 0.75, 10, 'visual left edge should keep its margin');
	assert.equal(out.y - out.height * 0.2, 20, 'visual top edge should keep its margin');
});

test('a stretched axis and a pinned axis are solved independently', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;

	const node = makeSprite({ anchorX: 0.5, anchorY: 0.25 });
	const { out } = responsive.computeResponsive(node, {
		ref: 'viewport',
		stretchX: { m0: 40, m1: 60 },
		y: { anchor: 1, offset: -24 },
	});

	assert.deepEqual(out, {
		x: 490,
		y: 538.5,
		width: 900,
	});
	assert.equal(out.y + (1 - node.anchor.y) * node.height, 576, 'the visible bottom edge stays pinned');
	assert.equal(out.height, undefined, 'pinning Y must not materialise or stretch its size');
});

test('origin-pinned containers ignore animated child bounds', () => {
	window.innerWidth = 1200;
	window.innerHeight = 800;

	let bounds = { x: 0, y: 0, width: 400, height: 300 };
	const node = {
		parent: null,
		x: 0,
		y: 0,
		scale: { x: 1, y: 1 },
		getLocalBounds: () => bounds,
		getLocalTransform: identityTransform,
	};
	const config = {
		ref: 'viewport',
		positionMode: 'origin',
		x: { anchor: 0.5, offset: 12 },
		y: { anchor: 0.5, offset: -8 },
	};

	const initial = responsive.computeResponsive(node, config).out;
	bounds = { x: -500, y: -900, width: 1800, height: 2400 };
	const whileAnimating = responsive.computeResponsive(node, config).out;

	assert.deepEqual(initial, { x: 612, y: 392 });
	assert.deepEqual(whileAnimating, initial);

	bounds = { x: 0, y: 0, width: 200, height: 100 };
	const boundsPinned = responsive.computeResponsive(node, {
		ref: 'viewport',
		x: { anchor: 1, offset: -10 },
	}).out;
	assert.equal(boundsPinned.x, 990);
	assert.equal(boundsPinned.x + bounds.width, 1190, 'default mode still pins a panel by its visible edge');
});

test('Spine layout bounds use the fixed setup AABB without reading the live animation', () => {
	let localBoundsReads = 0;
	let displayWidthReads = 0;
	let displayHeightReads = 0;
	const node = {
		skeleton: {
			data: { x: -50, y: -25, width: 200, height: 100 },
		},
		scale: { x: -2, y: 3 },
		getLocalBounds() {
			localBoundsReads += 1;
			return { x: -900, y: -700, width: 1800, height: 1400 };
		},
	};
	Object.defineProperties(node, {
		width: {
			get() {
				displayWidthReads += 1;
				return 3600;
			},
		},
		height: {
			get() {
				displayHeightReads += 1;
				return 4200;
			},
		},
	});

	assert.deepEqual(
		responsive.getLayoutLocalBounds(node),
		{ x: -50, y: -25, width: 200, height: 100 },
	);
	assert.deepEqual(
		responsive.getLayoutLocalBounds(node),
		{ x: -50, y: -25, width: 200, height: 100 },
	);
	const display = responsive.getLayoutDisplaySize(node);
	assert.equal(display.width, 400);
	assert.equal(display.height, 300);
	assert.equal(localBoundsReads, 0, 'resolved setup bounds should make live pose measurement unnecessary');
	assert.equal(displayWidthReads, 0, 'fixed display width should not read Spine.width');
	assert.equal(displayHeightReads, 0, 'fixed display height should not read Spine.height');
});

test('Spine layout bounds never sample a live pose when fixed bounds are unavailable', () => {
	let localBoundsReads = 0;
	const node = {
		skeleton: {
			data: { x: Number.NaN, y: 0, width: 0, height: 0 },
		},
		scale: { x: 1, y: 1 },
		getLocalBounds() {
			localBoundsReads += 1;
			return { x: -500, y: -400, width: 1000, height: 800 };
		},
	};

	assert.equal(responsive.getLayoutLocalBounds(node), null);
	assert.equal(responsive.getLayoutLocalBounds(node), null, 'an unavailable fixed result should be cached');
	assert.equal(localBoundsReads, 0, 'layout must never inspect the current animation frame');

	// A newly loaded SkeletonData object invalidates the empty result and allows
	// the fixed setup-pose resolver to run once more.
	node.skeleton.data = { x: -30, y: -10, width: 120, height: 80 };
	assert.deepEqual(
		responsive.getLayoutLocalBounds(node),
		{ x: -30, y: -10, width: 120, height: 80 },
	);
	assert.equal(localBoundsReads, 0);
});

test('Spine fixed-provider and SkeletonData identity changes invalidate cached bounds', () => {
	let invalidProviderReads = 0;
	let fixedProviderReads = 0;
	const invalidProvider = {
		calculateBounds() {
			invalidProviderReads += 1;
			return { x: 0, y: 0, width: 0, height: 0 };
		},
	};
	const node = {
		skeleton: { data: { x: -50, y: -25, width: 200, height: 100 } },
		boundsProvider: invalidProvider,
	};

	assert.deepEqual(
		responsive.getLayoutLocalBounds(node),
		{ x: -50, y: -25, width: 200, height: 100 },
		'an invalid explicit provider should fall through to setup-pose bounds',
	);
	assert.deepEqual(responsive.getLayoutLocalBounds(node), { x: -50, y: -25, width: 200, height: 100 });
	assert.equal(invalidProviderReads, 1, 'the provider result should be cached by identity');

	node.boundsProvider = {
		calculateBounds() {
			fixedProviderReads += 1;
			return { x: -10, y: -5, width: 80, height: 40 };
		},
	};
	assert.deepEqual(
		responsive.getLayoutLocalBounds(node),
		{ x: -10, y: -5, width: 80, height: 40 },
		'a replacement fixed provider should invalidate the old setup-pose rectangle',
	);
	assert.equal(fixedProviderReads, 1);
});

test('Spine responsive pins stay fixed while live animation bounds change', () => {
	window.innerWidth = 1200;
	window.innerHeight = 800;
	let liveBounds = { x: -10, y: -5, width: 20, height: 10 };
	let localBoundsReads = 0;
	const node = {
		parent: null,
		x: 0,
		y: 0,
		scale: { x: 1, y: 1 },
		skeleton: {
			data: { x: -50, y: -25, width: 200, height: 100 },
		},
		getLocalBounds() {
			localBoundsReads += 1;
			return liveBounds;
		},
		getLocalTransform() {
			return { a: this.scale.x, b: 0, c: 0, d: this.scale.y, tx: this.x, ty: this.y };
		},
	};
	const config = {
		ref: 'viewport',
		x: { anchor: 1, offset: -20 },
		y: { anchor: 1, offset: -10 },
	};

	const initial = responsive.computeResponsive(node, config).out;
	liveBounds = { x: -900, y: -700, width: 1800, height: 1400 };
	const whileAnimating = responsive.computeResponsive(node, config).out;

	assert.deepEqual(initial, { x: 1030, y: 715 });
	assert.deepEqual(whileAnimating, initial);
	assert.equal(initial.x - 50 + 200, 1180, 'fixed setup right edge keeps its 20px margin');
	assert.equal(initial.y - 25 + 100, 790, 'fixed setup bottom edge keeps its 10px margin');
	assert.equal(localBoundsReads, 0, 'pinning should not sample the current animation pose');
});

test('Spine aspect sizing and placement use the fixed setup AABB', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;
	let dynamicWidth = 20;
	let dynamicHeight = 10;
	let localBoundsReads = 0;
	let displaySizeReads = 0;
	const node = {
		parent: null,
		x: 0,
		y: 0,
		scale: { x: 1, y: 1 },
		skeleton: {
			data: { x: -50, y: -25, width: 200, height: 100 },
		},
		getLocalBounds() {
			localBoundsReads += 1;
			return { x: 0, y: 0, width: dynamicWidth, height: dynamicHeight };
		},
		getLocalTransform() {
			return { a: this.scale.x, b: 0, c: 0, d: this.scale.y, tx: this.x, ty: this.y };
		},
	};
	Object.defineProperties(node, {
		width: {
			get() {
				displaySizeReads += 1;
				return dynamicWidth;
			},
		},
		height: {
			get() {
				displaySizeReads += 1;
				return dynamicHeight;
			},
		},
	});
	const config = {
		aspect: 'contain',
		x: { anchor: 0.5, offset: 0 },
		y: { anchor: 0.5, offset: 0 },
	};

	const initial = responsive.computeResponsive(node, config).out;
	dynamicWidth = 1800;
	dynamicHeight = 1400;
	const whileAnimating = responsive.computeResponsive(node, config).out;

	assert.deepEqual(initial, { scaleX: 5, scaleY: 5, x: 250, y: 175 });
	assert.deepEqual(whileAnimating, initial);
	assert.equal(initial.x - 50 * initial.scaleX, 0, 'fixed setup bounds remain horizontally fitted');
	assert.equal(initial.y - 25 * initial.scaleY, 50, 'fixed setup bounds remain vertically centered');
	assert.equal(localBoundsReads, 0);
	assert.equal(displaySizeReads, 0, 'contain sizing should not read dynamic Spine width/height');
});

test('Spine width and height overrides scale the fixed setup bounds without dynamic size access', () => {
	const scale = { x: -2, y: 3 };
	let displaySizeReads = 0;
	let displaySizeWrites = 0;
	const node = {
		label: 'fixed-spine-size',
		x: 0,
		y: 0,
		visible: true,
		zIndex: 0,
		scale,
		skeleton: {
			data: { x: -50, y: -25, width: 200, height: 100 },
		},
	};
	Object.defineProperties(node, {
		width: {
			get() {
				displaySizeReads += 1;
				return 9999;
			},
			set() {
				displaySizeWrites += 1;
			},
		},
		height: {
			get() {
				displaySizeReads += 1;
				return 7777;
			},
			set() {
				displaySizeWrites += 1;
			},
		},
	});
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: {
			base: {
				'fixed-spine-size': { width: 1000, height: 250 },
			},
		},
	});

	responsive.applyLayoutOverrides(node);
	assert.deepEqual(scale, { x: -5, y: 2.5 });
	assert.equal(node.__sleAuthored.width, 400);
	assert.equal(node.__sleAuthored.height, 300);
	assert.equal(displaySizeReads, 0, 'capturing authored Spine size should use fixed bounds');
	assert.equal(displaySizeWrites, 0, 'applying Spine size should adjust scale directly');

	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.deepEqual(scale, { x: -2, y: 3 }, 'clearing overrides should restore authored scale-derived size');
	assert.equal(displaySizeReads, 0);
	assert.equal(displaySizeWrites, 0);
});

test('Spine size overrides wait for fixed setup bounds without touching native dimensions', (t) => {
	let nativeReads = 0;
	let nativeWrites = 0;
	let localBoundsReads = 0;
	const scale = { x: -2, y: 3 };
	const node = {
		label: 'deferred-fixed-spine-size',
		x: 0,
		y: 0,
		visible: true,
		zIndex: 0,
		scale,
		skeleton: { data: { x: 0, y: 0, width: 0, height: 0 } },
		getLocalBounds() {
			localBoundsReads += 1;
			return { x: -999, y: -999, width: 9999, height: 9999 };
		},
	};
	Object.defineProperties(node, {
		width: {
			get() { nativeReads += 1; return 9999; },
			set() { nativeWrites += 1; },
		},
		height: {
			get() { nativeReads += 1; return 9999; },
			set() { nativeWrites += 1; },
		},
	});
	t.after(() => responsive.replaceLayoutOverrides({}));
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: { base: { 'deferred-fixed-spine-size': { scaleX: -4, width: 600, height: 200 } } },
	});

	responsive.applyLayoutOverrides(node);
	assert.deepEqual(scale, { x: -4, y: 3 }, 'fixed-size fields defer while an independent scale override still applies');
	assert.equal('width' in node.__sleAuthored, false, 'invalid bounds must not poison authored width');
	assert.equal('height' in node.__sleAuthored, false, 'invalid bounds must not poison authored height');

	node.skeleton.data = { x: -30, y: -10, width: 120, height: 80 };
	responsive.applyLayoutOverrides(node);
	assert.deepEqual(scale, { x: -5, y: 2.5 });
	assert.equal(node.__sleAuthored.width, 240);
	assert.equal(node.__sleAuthored.height, 240);

	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.deepEqual(scale, { x: -2, y: 3 }, 'clear should restore the pre-override scale and deferred authored size');
	assert.equal(localBoundsReads, 0, 'no deferred path may inspect live Spine bounds');
	assert.equal(nativeReads, 0);
	assert.equal(nativeWrites, 0);
});

test('aspect contain and cover preserve both mirror signs', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;

	// Displayed 400x400 at -2x/-4x means a natural 200x100 asset.
	const mirrored = makeSprite({ width: 400, height: 400, scaleX: -2, scaleY: -4 });
	const contain = responsive.computeResponsive(mirrored, { aspect: 'contain' }).out;
	const cover = responsive.computeResponsive(mirrored, { aspect: 'cover' }).out;

	assert.deepEqual(contain, { scaleX: -5, scaleY: -5 });
	assert.deepEqual(cover, { scaleX: -6, scaleY: -6 });
});

test('persisted aspect signs survive a positive authored scale reset', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;

	const resetToPositive = makeSprite({ width: 200, height: 100, scaleX: 1, scaleY: 1 });
	const { out } = responsive.computeResponsive(resetToPositive, {
		aspect: 'contain',
		aspectSign: { x: -1, y: 1 },
		x: { anchor: 0.5, offset: 0 },
		y: { anchor: 0.5, offset: 0 },
	});

	assert.deepEqual(out, { scaleX: -5, scaleY: 5, x: 1000, y: 50 });
	assert.equal(out.x + 200 * out.scaleX, 0, 'mirrored visual left edge should remain fitted');
});

test('aspect positioning owns only configured axes and centers an anchor-zero contain fit', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;

	const node = makeSprite({ width: 200, height: 100, anchorX: 0, anchorY: 0 });
	const xOnly = responsive.computeResponsive(node, {
		aspect: 'contain',
		x: { anchor: 0.5, offset: 0 },
	}).out;
	assert.equal(xOnly.x, 0);
	assert.equal(xOnly.y, undefined, 'an unconfigured axis must retain its authored position');

	const centered = responsive.computeResponsive(node, {
		aspect: 'contain',
		x: { anchor: 0.5, offset: 0 },
		y: { anchor: 0.5, offset: 0 },
	}).out;
	assert.deepEqual(centered, { scaleX: 5, scaleY: 5, x: 0, y: 50 });

	const visual = {
		left: centered.x,
		top: centered.y,
		right: centered.x + 200 * centered.scaleX,
		bottom: centered.y + 100 * centered.scaleY,
	};
	assert.ok(visual.left >= 0 && visual.top >= 0);
	assert.ok(visual.right <= window.innerWidth && visual.bottom <= window.innerHeight);
	assert.equal((visual.left + visual.right) / 2, window.innerWidth / 2);
	assert.equal((visual.top + visual.bottom) / 2, window.innerHeight / 2);
});

test('apply stages static anchor overrides before solving responsive stretch', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;
	const node = {
		label: 'ordered-anchor',
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		visible: true,
		scale: { x: 1, y: 1 },
		anchor: { x: 0, y: 0 },
		texture: {},
		getLocalBounds() {
			return { x: -this.anchor.x * 100, y: -this.anchor.y * 50, width: 100, height: 50 };
		},
		getLocalTransform() {
			return { a: this.scale.x, b: 0, c: 0, d: this.scale.y, tx: this.x, ty: this.y };
		},
	};
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: {
			base: {
				'ordered-anchor': {
					anchorX: 0.5,
					responsive: { ref: 'viewport', stretchX: { m0: 0, m1: 0 } },
				},
			},
		},
	});

	responsive.applyLayoutOverrides(node, ['anchor', 'x', 'width']);
	assert.equal(node.anchor.x, 0.5);
	assert.equal(node.width, 1000);
	assert.equal(node.x, 500, 'the staged center anchor should place the visual left edge at zero');
});

test('clearing stretch restores authored dimensions captured before static scale staging', () => {
	window.innerWidth = 1000;
	window.innerHeight = 600;
	const scale = { x: 1, y: 1 };
	const node = {
		label: 'coupled-size',
		x: 0,
		y: 0,
		height: 50,
		visible: true,
		scale,
		anchor: { x: 0, y: 0 },
		texture: {},
		getLocalBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
		getLocalTransform: () => ({ a: scale.x, b: 0, c: 0, d: scale.y, tx: node.x, ty: node.y }),
	};
	Object.defineProperty(node, 'width', {
		get: () => 100 * Math.abs(scale.x),
		set: (value) => { scale.x = (Math.sign(scale.x) || 1) * Number(value) / 100; },
		configurable: true,
	});
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: {
			base: {
				'coupled-size': {
					scaleX: 2,
					responsive: { ref: 'viewport', stretchX: { m0: 0, m1: 0 } },
				},
			},
		},
	});

	responsive.applyLayoutOverrides(node);
	assert.equal(node.width, 1000);
	assert.equal(node.__sleAuthored.width, 100, 'authored width must precede the scale override');
	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.equal(scale.x, 1);
	assert.equal(node.width, 100);
});

test('a spawned texture replacement refreshes authored size without capturing override scale', () => {
	const node = {
		texture: {},
		scale: { x: 3, y: -2 },
		__sleAuthored: { scaleX: 1, scaleY: -1, width: 1, height: 1 },
		getLocalBounds: () => ({ x: 0, y: 0, width: 240, height: 90 }),
	};

	responsive.refreshAuthoredDisplaySize(node);
	assert.deepEqual(node.__sleAuthored, {
		scaleX: 1,
		scaleY: -1,
		width: 240,
		height: 90,
	});
});

test('authored sprites resolve profile and base asset overrides, then restore their texture', (t) => {
	const authoredTexture = { key: 'authored-logo', width: 100, height: 50 };
	const baseTexture = { key: 'base-logo', width: 120, height: 60 };
	const portraitTexture = { key: 'portrait-logo', width: 140, height: 70 };
	const assets = new Map([
		['base-logo', baseTexture],
		['portrait-logo', portraitTexture],
	]);
	let profile = 'portrait';
	responsive.registerLayoutAssetResolver((assetKey) => assets.get(assetKey) ?? null);
	t.after(() => responsive.registerLayoutAssetResolver(null));
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: {
				base: { 'authored-asset-precedence': { assetKey: 'base-logo' } },
				portrait: { 'authored-asset-precedence': { assetKey: 'portrait-logo' } },
			},
		},
		() => profile,
	);
	const node = {
		...makeSprite(),
		label: 'authored-asset-precedence',
		texture: authoredTexture,
	};

	responsive.applyLayoutOverrides(node, ['texture']);
	assert.equal(node.texture, portraitTexture, 'the active profile should override the base asset');

	profile = 'desktop';
	responsive.applyLayoutOverrides(node);
	assert.equal(node.texture, baseTexture, 'profiles without an asset override should inherit Base');

	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.equal(node.texture, authoredTexture, 'clearing all asset overrides should restore the game texture');
});

test('an unavailable asset override falls back to the authored texture', (t) => {
	const authoredTexture = { key: 'authored-safe-fallback', width: 100, height: 50 };
	const availableTexture = { key: 'available-logo', width: 160, height: 80 };
	responsive.registerLayoutAssetResolver((assetKey) =>
		assetKey === 'available-logo' ? availableTexture : null,
	);
	t.after(() => responsive.registerLayoutAssetResolver(null));
	const node = {
		...makeSprite(),
		label: 'authored-missing-asset',
		texture: authoredTexture,
	};
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: { base: { 'authored-missing-asset': { assetKey: 'available-logo' } } },
		},
		() => 'desktop',
	);

	responsive.applyLayoutOverrides(node, ['texture']);
	assert.equal(node.texture, availableTexture);

	responsive.replaceLayoutOverrides({
		base: { 'authored-missing-asset': { assetKey: 'deleted-or-not-loaded' } },
	});
	responsive.applyLayoutOverrides(node);
	assert.equal(
		node.texture,
		authoredTexture,
		'a stale key must not leave the previous replacement applied or blank the sprite',
	);
});

test('asset replacement precedes fixed dimensions and restores authored sprite geometry', (t) => {
	const authoredTexture = { key: 'authored-fixed-size', width: 100, height: 50 };
	const wideTexture = { key: 'wide-logo', width: 240, height: 80 };
	responsive.registerLayoutAssetResolver((assetKey) =>
		assetKey === 'wide-logo' ? wideTexture : null,
	);
	t.after(() => responsive.registerLayoutAssetResolver(null));
	const scale = { x: 1, y: 1 };
	const node = {
		label: 'asset-with-fixed-size',
		x: 0,
		y: 0,
		visible: true,
		scale,
		anchor: { x: 0, y: 0 },
		texture: authoredTexture,
		getLocalBounds() {
			return { x: 0, y: 0, width: this.texture.width, height: this.texture.height };
		},
		getLocalTransform() {
			return { a: scale.x, b: 0, c: 0, d: scale.y, tx: this.x, ty: this.y };
		},
	};
	Object.defineProperties(node, {
		width: {
			get: () => node.texture.width * Math.abs(scale.x),
			set: (value) => { scale.x = (Math.sign(scale.x) || 1) * Number(value) / node.texture.width; },
			configurable: true,
		},
		height: {
			get: () => node.texture.height * Math.abs(scale.y),
			set: (value) => { scale.y = (Math.sign(scale.y) || 1) * Number(value) / node.texture.height; },
			configurable: true,
		},
	});
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: {
				base: {
					'asset-with-fixed-size': { assetKey: 'wide-logo', width: 300, height: 120 },
				},
			},
		},
		() => 'desktop',
	);

	responsive.applyLayoutOverrides(node, ['texture', 'scale']);
	assert.equal(node.texture, wideTexture);
	assert.equal(node.width, 300, 'fixed width should be applied against the replacement texture');
	assert.equal(node.height, 120, 'fixed height should be applied against the replacement texture');
	assert.equal(node.__sleAuthored.width, 240, 'resetting width should use the replacement texture naturally');
	assert.equal(node.__sleAuthored.height, 80, 'resetting height should use the replacement texture naturally');

	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.equal(node.texture, authoredTexture);
	assert.equal(node.width, 100);
	assert.equal(node.height, 50);
	assert.equal(node.__sleAuthored.width, 100);
	assert.equal(node.__sleAuthored.height, 50);
});

test('zIndex overrides enable sibling sorting and restore the authored layer', () => {
	let sorts = 0;
	const parent = {
		sortableChildren: false,
		sortDirty: false,
		sortChildren() { sorts += 1; },
	};
	const node = {
		...makeSprite({ parent }),
		label: 'layered-sprite',
		zIndex: 3,
	};
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: { base: { 'layered-sprite': { zIndex: 9 } } },
		},
		() => 'desktop',
	);

	responsive.applyLayoutOverrides(node, ['zIndex']);
	assert.equal(node.zIndex, 9);
	assert.equal(parent.sortableChildren, true);
	assert.ok(sorts > 0);

	responsive.replaceLayoutOverrides({});
	responsive.applyLayoutOverrides(node);
	assert.equal(node.zIndex, 3);
});

test('registered game frame drives both position and game-relative scale', () => {
	window.innerWidth = 1280;
	window.innerHeight = 720;
	responsive.registerGameLayout(() => ({
		x: 640,
		y: 360,
		width: 1000,
		height: 500,
		scale: 0.5,
		anchor: 0.5,
	}));

	const node = makeSprite({ parent: makeParent() });
	const { ref, out } = responsive.computeResponsive(node, {
		ref: 'game',
		x: { anchor: 1, offset: -10 },
		y: { anchor: 0.5, offset: 5 },
		scaleMode: 'game',
		scaleBase: { x: 2, y: 3 },
	});

	assert.deepEqual(ref, { x: 390, y: 235, width: 500, height: 250 });
	assert.equal(out.x, 785);
	assert.equal(out.y, 325);
	assert.equal(out.scaleX, 1);
	assert.equal(out.scaleY, 1.5);
	assert.equal(out.x + 100 * out.scaleX, 885, 'the visible right edge keeps its design-space margin');
	assert.equal(out.y + 25 * out.scaleY, 362.5, 'the visible center keeps its design-space offset');
});

test('game-frame offsets stay in Stake design space as the viewport scale changes', () => {
	let layout = {
		x: 640,
		y: 360,
		width: 1000,
		height: 500,
		scale: 0.5,
		anchor: 0.5,
	};
	responsive.registerGameLayout(() => layout);
	const node = makeSprite({ parent: makeParent() });
	const cfg = {
		ref: 'game',
		x: { anchor: 0.5, offset: 100 },
		y: { anchor: 0.5, offset: -50 },
		scaleMode: 'game',
		scaleBase: { x: 2, y: 2 },
	};

	let result = responsive.computeResponsive(node, cfg).out;
	assert.deepEqual(result, { x: 640, y: 310, scaleX: 1, scaleY: 1 });

	layout = { ...layout, x: 960, y: 540, scale: 0.75 };
	result = responsive.computeResponsive(node, cfg).out;
	assert.deepEqual(result, { x: 960, y: 465, scaleX: 1.5, scaleY: 1.5 });
});

test('game frame conversion composes current MainContainer transforms before Pixi renders', () => {
	responsive.registerGameLayout(() => ({
		x: 640,
		y: 360,
		width: 1000,
		height: 500,
		scale: 0.5,
		anchor: 0.5,
	}));
	const stage = {
		parent: null,
		getLocalTransform: identityTransform,
		worldTransform: identityTransform(),
		scale: { x: 1, y: 1 },
	};
	const mainContainer = {
		parent: stage,
		// Current Stake layout: scale .5 and pivot (500,250), centred at 640,360.
		getLocalTransform: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, tx: 390, ty: 235 }),
		// Deliberately stale previous render.
		worldTransform: identityTransform(),
		scale: { x: 0.5, y: 0.5 },
	};
	const node = makeSprite({ parent: mainContainer });

	assert.deepEqual(
		responsive.getReferenceRect(node, { ref: 'game' }),
		{ x: 0, y: 0, width: 1000, height: 500 },
	);
	const { out } = responsive.computeResponsive(node, {
		ref: 'game',
		x: { anchor: 0.5, offset: 100 },
		y: { anchor: 0.5, offset: -50 },
	});
	assert.deepEqual(out, { x: 550, y: 175 });
});

test('mainLogo-style nested asset stays on the viewport top-right at every desktop resolution', () => {
	let mainScale = 1;
	let mainTx = 0;
	let mainTy = 0;
	let layout = {
		x: 640,
		y: 360,
		width: 1280,
		height: 720,
		scale: 1,
		anchor: 0.5,
	};
	responsive.registerGameLayout(() => layout);

	const stage = {
		parent: null,
		scale: { x: 1, y: 1 },
		getLocalTransform: identityTransform,
		worldTransform: identityTransform(),
	};
	const mainContainer = {
		parent: stage,
		scale: {
			get x() { return mainScale; },
			get y() { return mainScale; },
		},
		getLocalTransform: () => ({
			a: mainScale,
			b: 0,
			c: 0,
			d: mainScale,
			tx: mainTx,
			ty: mainTy,
		}),
	};
	const logoContainer = {
		parent: mainContainer,
		scale: { x: 1, y: 1 },
		getLocalTransform: identityTransform,
	};
	const mainLogo = makeSprite({
		parent: logoContainer,
		width: 240,
		height: 90,
		anchorX: 0.5,
		anchorY: 0.5,
	});
	const cfg = {
		ref: 'viewport',
		x: { anchor: 1, offset: -24 },
		y: { anchor: 0, offset: 24 },
		scaleMode: 'game',
		scaleBase: { x: 1, y: 1 },
	};

	for (const viewport of [
		{ width: 1280, height: 720, scale: 1, tx: 0, ty: 0 },
		{ width: 1920, height: 1080, scale: 1.5, tx: 0, ty: 0 },
		{ width: 2560, height: 1080, scale: 1.5, tx: 320, ty: 0 },
	]) {
		window.innerWidth = viewport.width;
		window.innerHeight = viewport.height;
		mainScale = viewport.scale;
		mainTx = viewport.tx;
		mainTy = viewport.ty;
		layout = {
			...layout,
			x: viewport.width / 2,
			y: viewport.height / 2,
			scale: viewport.scale,
		};

		const { out } = responsive.computeResponsive(mainLogo, cfg);
		const localHalfW = 120 * Math.abs(out.scaleX);
		const localHalfH = 45 * Math.abs(out.scaleY);
		const visualRight = mainTx + mainScale * (out.x + localHalfW);
		const visualTop = mainTy + mainScale * (out.y - localHalfH);

		assert.equal(visualRight, viewport.width - 24, `${viewport.width}px desktop right margin`);
		assert.equal(visualTop, 24, `${viewport.width}px desktop top margin`);
		assert.ok(visualRight <= viewport.width, `${viewport.width}px desktop must not overflow`);
	}
});

test('Stake UI logo slot owns top-right position while the logo only scales', () => {
	let layout = {
		x: 640,
		y: 360,
		width: 1280,
		height: 720,
		scale: 1,
		anchor: 0.5,
	};
	responsive.registerGameLayout(() => layout);

	const stage = {
		parent: null,
		scale: { x: 1, y: 1 },
		getLocalTransform: identityTransform,
		worldTransform: identityTransform(),
	};
	const logoSlot = {
		parent: stage,
		scale: { x: 1, y: 1 },
		getLocalTransform: identityTransform,
	};
	const logo = makeSprite({
		parent: logoSlot,
		width: 240,
		height: 90,
		anchorX: 1,
		anchorY: 0,
	});

	for (const viewport of [
		{ width: 1280, height: 720, scale: 1 },
		{ width: 1920, height: 1080, scale: 1.5 },
		{ width: 2560, height: 1080, scale: 1.5 },
	]) {
		window.innerWidth = viewport.width;
		window.innerHeight = viewport.height;
		layout = {
			...layout,
			x: viewport.width / 2,
			y: viewport.height / 2,
			scale: viewport.scale,
		};

		const { out } = responsive.computeResponsive(logo, {
			scaleMode: 'game',
			scaleBase: { x: 1, y: 1 },
		});
		const slotX = viewport.width - 20;
		const localX = out.x ?? 0;
		const localY = out.y ?? 0;
		const visualRight = slotX + localX;
		const visualTop = localY;

		assert.equal(visualRight, viewport.width - 20, `${viewport.width}px desktop right margin`);
		assert.equal(visualTop, 0, `${viewport.width}px desktop top edge`);
		assert.equal(out.scaleX, viewport.scale);
		assert.equal(out.scaleY, viewport.scale);
		assert.ok(
			visualRight - logo.width * Math.abs(out.scaleX) >= 0,
			`${viewport.width}px desktop logo remains inside the viewport`,
		);
	}
});

test('legacy captured-viewport rules compact to the Stake game mode', () => {
	assert.deepEqual(
		responsive.compactLayoutOverrideEntry({
			x: 123,
			y: 456,
			width: 300,
			scaleX: 2,
			responsive: {
				ref: 'game',
				x: { anchor: 0.5, offset: 10 },
				y: { anchor: 0.5, offset: 20 },
				positionMode: 'origin',
				scaleMode: 'screen',
				scaleBase: { x: 1, y: 1 },
				scaleRefW: 1280,
				scaleRefH: 720,
			},
		}),
		{
			responsive: {
				ref: 'game',
				x: { anchor: 0.5, offset: 10 },
				y: { anchor: 0.5, offset: 20 },
				positionMode: 'origin',
				scaleMode: 'game',
				scaleBase: { x: 1, y: 1 },
			},
		},
	);

	assert.deepEqual(
		responsive.compactLayoutOverrideEntry({
			responsive: {
				ref: 'game',
				positionMode: 'bounds',
				x: { anchor: 0.5, offset: 0 },
			},
		}),
		{
			responsive: {
				ref: 'game',
				x: { anchor: 0.5, offset: 0 },
			},
		},
	);
});

test('fixed world size cancels inherited parent scale', () => {
	const parent = makeParent({ scaleX: 0.5, scaleY: 0.25 });
	const node = makeSprite({ parent });
	const { out } = responsive.computeResponsive(node, {
		scaleMode: 'fixed',
		scaleBase: { x: 2, y: 3 },
	});

	assert.equal(out.scaleX, 4);
	assert.equal(out.scaleY, 12);
	assert.equal(out.scaleX * parent.scale.x, 2);
	assert.equal(out.scaleY * parent.scale.y, 3);
});

test('responsive scale preserves a negative scaleBase through mirrored ancestors', () => {
	const root = makeParent({ scaleX: -2, scaleY: 0.5 });
	const parent = makeParent({ scaleX: -0.25, scaleY: -0.5, parent: root });
	const node = makeSprite({ parent, scaleX: -1, scaleY: 1 });
	const { out } = responsive.computeResponsive(node, {
		scaleMode: 'fixed',
		scaleBase: { x: -3, y: 2 },
	});

	// Ancestor magnitudes are 0.5x and 0.25x. Their signs must not cancel the
	// child's intentional mirror encoded in scaleBase.x.
	assert.equal(out.scaleX, -6);
	assert.equal(out.scaleY, 8);
	assert.equal(Math.sign(out.scaleX), -1);
	assert.equal(out.scaleX * 0.5, -3);
	assert.equal(out.scaleY * 0.25, 2);
});

test('native parent sizing emits no scale, while game sizing avoids double scaling', () => {
	responsive.registerGameLayout(() => ({
		x: 640,
		y: 360,
		width: 1000,
		height: 500,
		scale: 0.5,
		anchor: 0.5,
	}));
	const parent = makeParent({ scaleX: 0.5, scaleY: 0.5 });
	const node = makeSprite({ parent });

	const nativeResult = responsive.computeResponsive(node, {
		scaleMode: 'parent',
		scaleBase: { x: 2, y: 3 },
	});
	assert.equal(nativeResult.out.scaleX, undefined);
	assert.equal(nativeResult.out.scaleY, undefined);

	const gameResult = responsive.computeResponsive(node, {
		scaleMode: 'game',
		scaleBase: { x: 2, y: 3 },
	});
	assert.equal(gameResult.out.scaleX, 2);
	assert.equal(gameResult.out.scaleY, 3);
	assert.equal(gameResult.out.scaleX * parent.scale.x, 1);
	assert.equal(gameResult.out.scaleY * parent.scale.y, 1.5);
});

test('ordinary parent bounds are captured once instead of feeding back from children', () => {
	let bounds = { x: 4, y: 8, width: 300, height: 200 };
	const stage = makeParent();
	const parent = {
		...makeParent({ parent: stage }),
		getLocalBounds: () => bounds,
	};
	const node = makeSprite({ parent });

	assert.deepEqual(
		responsive.getReferenceRect(node, { ref: 'parent' }),
		{ x: 4, y: 8, width: 300, height: 200 },
	);

	bounds = { x: -100, y: -200, width: 900, height: 700 };
	assert.deepEqual(
		responsive.getReferenceRect(node, { ref: 'parent' }),
		{ x: 4, y: 8, width: 300, height: 200 },
	);
});

test('responsive containers publish a local logical frame for their children', () => {
	const container = {
		parent: makeParent(),
		scale: { x: 2, y: 4 },
		width: 0,
		height: 0,
		getLocalBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }),
	};

	responsive.computeResponsive(container, { logicalW: 400, logicalH: 200 });
	assert.deepEqual(container.__sleRefRect, { x: 0, y: 0, width: 200, height: 50 });

	const child = makeSprite({ parent: container });
	assert.deepEqual(
		responsive.getReferenceRect(child, { ref: 'parent' }),
		{ x: 0, y: 0, width: 200, height: 50 },
	);
});

test('a profile false sentinel disables an inherited base responsive rule', () => {
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: {
				base: {
					logo: {
						responsive: { x: { anchor: 0.5, offset: 0 } },
					},
				},
				portrait: { logo: { responsive: false } },
			},
		},
		() => 'portrait',
	);

	const merged = responsive.getMergedOverride('logo');
	assert.equal(merged.responsive, false);
	assert.equal(responsive.responsiveEnabled(merged.responsive), false);
});

test('a unique Pixi label remains stable regardless of automatic mount order', () => {
	responsive.ensureLayoutId({ scale: { x: 1, y: 1 } });
	const target = { label: 'i18nTest', scale: { x: 1, y: 1 } };

	assert.equal(responsive.ensureLayoutId(target), 'i18nTest');
	responsive.unregisterLayoutNode(target);
});

test('temporary Container overrides are ignored at application while a named child still applies', () => {
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: {
			base: {
				'container#3': { x: 900, y: 800 },
				bonusLogo: { x: 44, y: 28 },
			},
		},
	}, () => 'desktop');

	assert.deepEqual(
		responsive.getMergedOverride('container#3'),
		{ x: 900, y: 800 },
		'raw ids stay intact until type-aware editor persistence identifies the node as a Container',
	);
	assert.deepEqual(responsive.getMergedOverride('bonusLogo'), { x: 44, y: 28 });
	const temporary = { x: 1, y: 2, scale: { x: 1, y: 1 } };
	assert.equal(responsive.isTemporaryLayoutContainerNode(temporary), true);
	responsive.applyLayoutOverrides(temporary);
	assert.deepEqual({ x: temporary.x, y: temporary.y }, { x: 1, y: 2 });
});

test('a temporary runtime id stays blocked and restores owned fields if the object shape changes', () => {
	responsive.loadLayoutOverrides({
		version: 1,
		profiles: { base: { rememberedRuntimeSlot: { x: 91, visible: false } } },
	}, () => 'desktop');
	const node = {
		label: 'rememberedRuntimeSlot',
		x: 7,
		y: 2,
		visible: true,
		zIndex: 0,
		scale: { x: 1, y: 1 },
	};
	const parent = { x: 0, y: 0, scale: { x: 1, y: 1 } };
	node.parent = parent;
	responsive.applyLayoutOverrides(node);
	assert.equal(node.x, 91);
	assert.equal(node.visible, false);
	node.__sleRefRect = { x: 0, y: 0, width: 320, height: 180 };
	node.__sleNeedsPostMountLayoutRefresh = true;

	// The same registered object becomes an anonymous structural Container.
	node.label = '';
	// This authored update arrives in the same component prop sync that removes
	// the label. Releasing editor ownership must preserve the new authored value.
	node.x = 13;
	assert.equal(responsive.isTemporaryLayoutContainerNode(node), true);
	responsive.applyLayoutOverrides(node, ['x', 'label']);
	assert.equal(node.x, 13, 'becoming temporary preserves the latest authored position');
	assert.equal(node.visible, true, 'becoming temporary restores authored visibility');
	assert.equal(node.__sleRefRect, undefined, 'temporary parents publish no editor-owned child frame');
	assert.equal(node.__sleNeedsPostMountLayoutRefresh, undefined);

	// Even if its display shape later resembles a Sprite, the remembered runtime
	// identity remains blocked instead of allowing the old row to retarget it.
	node.texture = {};
	node.anchor = { x: 0, y: 0 };
	assert.equal(responsive.isTemporaryLayoutContainerNode(node), true);
	responsive.applyLayoutOverrides(node);
	assert.equal(node.x, 13);
	assert.equal(node.visible, true);

	// A different object can receive the freed runtime id after a screen switch.
	responsive.unregisterLayoutNode(node);
	const replacement = {
		label: 'rememberedRuntimeSlot',
		x: 11,
		y: 12,
		visible: true,
		zIndex: 0,
		scale: { x: 1, y: 1 },
		texture: {},
		anchor: { x: 0, y: 0 },
	};
	assert.equal(responsive.ensureLayoutId(replacement), 'rememberedRuntimeSlot');
	assert.equal(responsive.isTemporaryLayoutContainerNode(replacement), true);
	responsive.applyLayoutOverrides(replacement);
	assert.equal(replacement.x, 11, 'a replacement object cannot inherit the stale override');
	assert.equal(replacement.visible, true);
});

test('only prematurely solved responsive nodes schedule a coalesced mount refresh', () => {
	const callbacks = [];
	const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
	globalThis.requestAnimationFrame = (callback) => {
		callbacks.push(callback);
		return callbacks.length;
	};

	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: {
				base: {
					lateMountFirst: {
						responsive: { ref: 'viewport', x: { anchor: 0.5, offset: 0 } },
					},
					lateMountSecond: {
						responsive: { ref: 'viewport', y: { anchor: 0.5, offset: 0 } },
					},
				},
			},
		},
		() => 'desktop',
	);

	const transientReelSymbol = { label: 'transientReelSymbol' };
	const first = { ...makeSprite(), label: 'lateMountFirst' };
	const second = { ...makeSprite(), label: 'lateMountSecond' };
	responsive.applyLayoutOverrides(first);
	responsive.applyLayoutOverrides(second);
	first.parent = makeParent();
	second.parent = makeParent();
	const viewportBefore = responsive.getViewportVersion();

	try {
		responsive.registerLayoutNode(transientReelSymbol);
		assert.equal(callbacks.length, 0, 'non-responsive mounts must not refresh the game layout');

		responsive.registerLayoutNode(first);
		responsive.registerLayoutNode(second);

		assert.equal(callbacks.length, 1, 'one mount batch should queue only one refresh');
		assert.equal(responsive.getViewportVersion(), viewportBefore);

		callbacks[0](0);
		assert.equal(responsive.getViewportVersion(), viewportBefore + 1);
	} finally {
		responsive.unregisterLayoutNode(transientReelSymbol);
		responsive.unregisterLayoutNode(first);
		responsive.unregisterLayoutNode(second);
		if (previousRequestAnimationFrame === undefined) {
			delete globalThis.requestAnimationFrame;
		} else {
			globalThis.requestAnimationFrame = previousRequestAnimationFrame;
		}
	}
});

test('a stable labeled removal suppresses the source node in standalone runtime', () => {
	responsive.loadLayoutOverrides(
		{
			version: 1,
			profiles: {
				base: {
					i18nTest: { removed: true },
				},
			},
		},
		() => 'desktop',
	);
	const target = {
		label: 'i18nTest',
		x: 0,
		y: 0,
		visible: true,
		scale: { x: 1, y: 1 },
	};

	responsive.applyLayoutOverrides(target, ['visible']);
	assert.equal(target.visible, false);
});
