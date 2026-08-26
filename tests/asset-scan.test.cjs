const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAssets, scanAssets } = require('../src/main/assetScan');

const makeApp = (t, assetsSource = 'export default {\n};\n') => {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-assets-'));
	t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(appDir, 'src', 'game'), { recursive: true });
	fs.mkdirSync(path.join(appDir, 'static', 'assets'), { recursive: true });
	fs.writeFileSync(path.join(appDir, 'src', 'game', 'assets.ts'), assetsSource, 'utf8');
	return appDir;
};

const write = (root, rel, content = '') => {
	const file = path.join(root, 'static', 'assets', ...rel.split('/'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
};

const atlas = (page = 'shared.webp') =>
	`${page}\nsize: 256,256\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nroot\nbounds: 0,0,10,10\n`;

const skeleton = (animations = ['idle'], spineVersion = '4.2.36') =>
	JSON.stringify({
		skeleton: { hash: 'test', spine: spineVersion },
		bones: [{ name: 'root' }],
		slots: [],
		animations: Object.fromEntries(animations.map((name) => [name, {}])),
	});

test('scan discovers each new Spine skeleton even when its shared atlas is already registered', (t) => {
	const appDir = makeApp(
		t,
		`export default {
	existing: {
		type: 'spine',
		src: {
			atlas: new URL('../../assets/spines/meter/shared.atlas', import.meta.url).href,
			skeleton: new URL('../../assets/spines/meter/existing.json', import.meta.url).href,
			scale: 2,
		},
	},
};
`,
	);
	write(appDir, 'spines/meter/shared.atlas', atlas());
	write(appDir, 'spines/meter/shared.webp');
	write(appDir, 'spines/meter/existing.json', skeleton(['old']));
	write(appDir, 'spines/meter/mobile.json', skeleton(['intro', 'idle']));
	write(
		appDir,
		'spines/meter/index.ts',
		`import rawAtlas from './shared.atlas?raw';
import EXISTING from './existing.json';
import METER_MOBILE from './mobile.json';
export default { rawAtlas, EXISTING, METER_MOBILE };
`,
	);

	const result = scanAssets({ appDir, sinceMs: 0 });
	assert.equal(result.ok, true);
	assert.equal(result.suggestedSpineScale, 2);
	assert.equal(result.newSpines.length, 1);
	assert.deepEqual(
		{
			key: result.newSpines[0].key,
			atlasRel: result.newSpines[0].atlasRel,
			skeletonRel: result.newSpines[0].skeletonRel,
			scale: result.newSpines[0].scale,
			animations: result.newSpines[0].animations,
			imageOk: result.newSpines[0].imageOk,
		},
		{
			key: 'METER_MOBILE',
			atlasRel: 'spines/meter/shared.atlas',
			skeletonRel: 'spines/meter/mobile.json',
			scale: 2,
			animations: ['intro', 'idle'],
			imageOk: true,
		},
	);
	assert.deepEqual(result.spineIssues, []);
});

test('scan blocks JSON skeletons exported for a different Spine runtime line', (t) => {
	const appDir = makeApp(
		t,
		`export default {
	runtimeReference: {
		type: 'spine',
		src: {
			atlas: new URL('../../assets/spines/runtime/runtime.atlas', import.meta.url).href,
			skeleton: new URL('../../assets/spines/runtime/runtime.json', import.meta.url).href,
			scale: 1,
		},
	},
};
`,
	);
	write(appDir, 'spines/runtime/runtime.atlas', atlas('runtime.png'));
	write(appDir, 'spines/runtime/runtime.png');
	write(appDir, 'spines/runtime/runtime.json', skeleton([], '4.2.36'));
	write(appDir, 'spines/legacy/legacy.atlas', atlas('legacy.png'));
	write(appDir, 'spines/legacy/legacy.png');
	write(appDir, 'spines/legacy/legacy.json', skeleton(['idle'], '4.1.24'));

	const result = scanAssets({ appDir, sinceMs: 0 });
	const legacy = result.newSpines.find(({ key }) => key === 'legacy');
	assert.equal(result.expectedSpineVersion, '4.2');
	assert.equal(legacy?.imageOk, true);
	assert.equal(legacy?.versionOk, false);
	assert.equal(legacy?.loadOk, false);
	assert.match(legacy?.loadIssue ?? '', /re-export.*Spine 4\.2/i);
});

test('scan accepts binary skeletons and reports ambiguous multi-atlas pairings without guessing', (t) => {
	const appDir = makeApp(t);
	write(appDir, 'spines/binary/hero.atlas', atlas('hero.png'));
	write(appDir, 'spines/binary/hero.png');
	write(appDir, 'spines/binary/hero.skel', Buffer.from([1, 2, 3]));

	write(appDir, 'spines/ambiguous/a.atlas', atlas('a.png'));
	write(appDir, 'spines/ambiguous/a.png');
	write(appDir, 'spines/ambiguous/b.atlas', atlas('b.png'));
	write(appDir, 'spines/ambiguous/b.png');
	write(appDir, 'spines/ambiguous/orphan.json', skeleton());

	const result = scanAssets({ appDir, sinceMs: 0 });
	const binary = result.newSpines.find(({ skeletonRel }) => skeletonRel.endsWith('hero.skel'));
	assert.ok(binary);
	assert.equal(binary.binary, true);
	assert.deepEqual(binary.animations, []);
	assert.equal(result.newSpines.some(({ skeletonRel }) => skeletonRel.endsWith('orphan.json')), false);
	assert.match(
		result.spineIssues.find(({ dir }) => dir === 'spines/ambiguous')?.reason ?? '',
		/multiple atlases/i,
	);
});

test('scan validates Spine atlas pages and marks changed pages for cache-busting reloads', (t) => {
	const appDir = makeApp(t);
	write(appDir, 'spines/complete/fx.atlas', atlas('fx.webp'));
	const page = write(appDir, 'spines/complete/fx.webp');
	write(appDir, 'spines/complete/fx.json', skeleton(['burst']));
	write(appDir, 'spines/missing/broken.atlas', atlas('missing.png'));
	write(appDir, 'spines/missing/broken.json', skeleton());
	write(appDir, 'spines/malformed/empty.atlas', 'size: 256,256\n');
	write(appDir, 'spines/malformed/empty.json', skeleton());

	const sinceMs = fs.statSync(page).mtimeMs - 1;
	const result = scanAssets({ appDir, sinceMs });
	assert.equal(
		result.newSpines.find(({ key }) => key === 'fx')?.imageOk,
		true,
	);
	const broken = result.newSpines.find(({ key }) => key === 'broken');
	assert.equal(broken?.imageOk, false);
	assert.deepEqual(broken?.missingPages, ['spines/missing/missing.png']);
	const malformed = result.newSpines.find(({ key }) => key === 'empty');
	assert.equal(malformed?.imageOk, false);
	assert.match(malformed?.loadIssue ?? '', /no supported page image/i);
	const changedPage = result.changedFiles.find(({ rel }) => rel === 'spines/complete/fx.webp');
	assert.equal(changedPage?.isAtlasPage, true);
	assert.equal(changedPage?.isSpinePage, true);
});

test('register writes the canonical Stake Spine asset shape and is idempotent', (t) => {
	const appDir = makeApp(t, 'export default {\r\n};\r\n');
	const entry = {
		kind: 'spine',
		key: 'METER_MOBILE',
		atlasRel: 'spines/meter/shared.atlas',
		skeletonRel: 'spines/meter/mobile.json',
		scale: 2,
	};

	const first = registerAssets({ appDir, entries: [entry] });
	assert.deepEqual(first.added, ['METER_MOBILE']);
	const assetsPath = path.join(appDir, 'src', 'game', 'assets.ts');
	const source = fs.readFileSync(assetsPath, 'utf8');
	assert.match(source, /METER_MOBILE:\s*\{/);
	assert.match(source, /type: 'spine'/);
	assert.match(
		source,
		/atlas: new URL\('\.\.\/\.\.\/assets\/spines\/meter\/shared\.atlas', import\.meta\.url\)\.href/,
	);
	assert.match(
		source,
		/skeleton: new URL\('\.\.\/\.\.\/assets\/spines\/meter\/mobile\.json', import\.meta\.url\)\.href/,
	);
	assert.match(source, /scale: 2/);
	assert.equal(fs.existsSync(`${assetsPath}.sle-backup`), true);

	const second = registerAssets({ appDir, entries: [entry] });
	assert.deepEqual(second.added, []);
	assert.deepEqual(second.skipped, ['METER_MOBILE']);
});
