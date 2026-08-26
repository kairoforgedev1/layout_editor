const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
	analyzeIntegration,
	installIntegration,
	EXPECTED_BRIDGE_VERSION,
	EXPECTED_BRIDGE_REVISION,
} = require('../src/main/integration');

const makeProject = (loaderSource) => {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-integration-'));
	const appDir = path.join(workspaceRoot, 'apps', 'lines');
	const libDir = path.join(workspaceRoot, 'packages', 'pixi-svelte', 'src', 'lib');
	const gameDir = path.join(appDir, 'src', 'game');
	fs.mkdirSync(libDir, { recursive: true });
	fs.mkdirSync(gameDir, { recursive: true });
	fs.writeFileSync(path.join(libDir, 'index.ts'), '', 'utf8');
	fs.writeFileSync(path.join(gameDir, 'stateLayout.ts'), 'export const stateLayoutDerived = {};\n', 'utf8');
	fs.writeFileSync(path.join(gameDir, 'stateApp.ts'), 'export const stateApp = {};\n', 'utf8');
	fs.writeFileSync(path.join(gameDir, 'context.ts'), "import './layoutOverrides';\n", 'utf8');
	fs.writeFileSync(path.join(gameDir, 'layoutOverrides.data.ts'), 'export const layoutOverridesData = {};\n', 'utf8');
	fs.writeFileSync(path.join(gameDir, 'layoutOverrides.ts'), loaderSource, 'utf8');
	return {
		workspaceRoot,
		appDir,
		libDir,
		gameDir,
		loaderPath: path.join(gameDir, 'layoutOverrides.ts'),
	};
};

const legacyLoader = `import {
	loadLayoutOverrides,
	registerEditorGameHooks,
	registerGameScale,
	wireSpawnedElements,
} from 'pixi-svelte';

import { stateLayoutDerived } from './stateLayout';

registerGameScale(() => stateLayoutDerived.mainLayout().scale);

// Project-owned behavior must survive automatic bridge upgrades.
registerEditorGameHooks({
	gameEvents: { customBonus: () => eventEmitter.broadcast({ type: 'customBonus' }) },
});
`;

test('v11 analyzer and installer safely upgrade the standard v5 game-scale loader', (t) => {
	const original = legacyLoader.replace(/\n/g, '\r\n');
	const project = makeProject(original);
	t.after(() => fs.rmSync(project.workspaceRoot, { recursive: true, force: true }));

	assert.equal(EXPECTED_BRIDGE_VERSION, 11);
	assert.equal(EXPECTED_BRIDGE_REVISION, '2026-08-21-spawned-runtime-hooks-v1');
	const bundledRuntime = fs.readFileSync(
		path.join(__dirname, '..', 'resources', 'bridge', 'layoutOverrides.svelte.ts'),
		'utf8',
	);
	assert.match(
		bundledRuntime,
		new RegExp(`LAYOUT_EDITOR_BRIDGE_REVISION\\s*=\\s*['"]${EXPECTED_BRIDGE_REVISION}['"]`),
	);
	const before = analyzeIntegration(project);
	assert.equal(before.checks.find((check) => check.id === 'game-layout')?.status, 'installable');

	const result = installIntegration(project);
	assert.equal(result.ok, true);
	assert.equal(result.results.find((entry) => entry.id === 'game-layout')?.action, 'patched');
	assert.equal(result.results.find((entry) => entry.id === 'performance')?.action, 'created');
	assert.equal(result.results.find((entry) => entry.id === 'test-book-request')?.action, 'created');
	assert.equal(
		fs.readFileSync(path.join(project.libDir, 'performanceSampler.ts'), 'utf8'),
		fs.readFileSync(
			path.join(__dirname, '..', 'resources', 'bridge', 'performanceSampler.ts'),
			'utf8',
		),
	);
	assert.equal(
		fs.readFileSync(path.join(project.libDir, 'testBookRequest.ts'), 'utf8'),
		fs.readFileSync(
			path.join(__dirname, '..', 'resources', 'bridge', 'testBookRequest.ts'),
			'utf8',
		),
	);
	const installedSpawnedRuntime = fs.readFileSync(
		path.join(project.libDir, 'spawnedElements.svelte.ts'),
		'utf8',
	);
	assert.match(installedSpawnedRuntime, /resolveSpriteAssetKey\?\./);
	assert.match(installedSpawnedRuntime, /resolveSpriteInteraction\?\./);
	assert.match(installedSpawnedRuntime, /options\.resolveRenderable\?\.\(def\)/);
	assert.match(
		installedSpawnedRuntime,
		/if \(renderable !== undefined\) node\.renderable = renderable/,
		'project visibility hooks must survive an integration reinstall',
	);

	const upgraded = fs.readFileSync(project.loaderPath, 'utf8');
	const expected = original
		.replace('\tregisterGameScale,', '\tregisterGameLayout,')
		.replace(
			'registerGameScale(() => stateLayoutDerived.mainLayout().scale);',
			'registerGameLayout(() => stateLayoutDerived.mainLayout());',
		);
	assert.equal(upgraded, expected);
	assert.equal(fs.readFileSync(`${project.loaderPath}.sle-backup`, 'utf8'), original);

	const after = analyzeIntegration(project);
	assert.equal(after.checks.find((check) => check.id === 'game-layout')?.status, 'ok');
	assert.equal(after.checks.find((check) => check.id === 'performance')?.status, 'ok');
});

test('installer leaves a non-standard game-scale registration untouched', (t) => {
	const customLoader = legacyLoader.replace(
		'registerGameScale(() => stateLayoutDerived.mainLayout().scale);',
		'registerGameScale(() => customLayoutScale());',
	);
	const project = makeProject(customLoader);
	t.after(() => fs.rmSync(project.workspaceRoot, { recursive: true, force: true }));

	const before = analyzeIntegration(project);
	assert.equal(before.checks.find((check) => check.id === 'game-layout')?.status, 'manual');

	const result = installIntegration(project);
	assert.equal(result.ok, true);
	assert.equal(result.results.find((entry) => entry.id === 'game-layout')?.action, 'manual');
	assert.equal(fs.readFileSync(project.loaderPath, 'utf8'), customLoader);
	assert.equal(fs.existsSync(`${project.loaderPath}.sle-backup`), false);
});

test('generated app loader registers the full game layout frame', () => {
	const template = fs.readFileSync(
		path.join(__dirname, '..', 'resources', 'bridge', 'app', 'layoutOverrides.ts'),
		'utf8',
	);
	assert.match(template, /\bregisterGameLayout\b/);
	assert.match(template, /registerGameLayout\(\(\) => stateLayoutDerived\.mainLayout\(\)\);/);
	assert.doesNotMatch(template, /\bregisterGameScale\b/);
});

test('analyzer reports stale editor-owned bridge and built runtime files', (t) => {
	const project = makeProject(legacyLoader);
	t.after(() => fs.rmSync(project.workspaceRoot, { recursive: true, force: true }));

	const bridgeTemplate = fs.readFileSync(
		path.join(__dirname, '..', 'resources', 'bridge', 'editorBridge.ts'),
		'utf8',
	);
	fs.writeFileSync(
		path.join(project.libDir, 'editorBridge.ts'),
		`${bridgeTemplate}\n// stale local copy\n`,
		'utf8',
	);
	const runtimeTemplate = fs.readFileSync(
		path.join(__dirname, '..', 'resources', 'bridge', 'layoutOverrides.svelte.ts'),
		'utf8',
	);
	fs.writeFileSync(
		path.join(project.libDir, 'layoutOverrides.svelte.ts'),
		`${runtimeTemplate}\n// stale solver modification with the same v11 protocol\n`,
		'utf8',
	);
	const distDir = path.join(project.workspaceRoot, 'packages', 'pixi-svelte', 'dist');
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(
		path.join(distDir, 'layoutOverrides.svelte.js'),
		`export const LAYOUT_EDITOR_BRIDGE_VERSION = 11;\nexport const LAYOUT_EDITOR_BRIDGE_REVISION = 'previous-v11-build';\n`,
		'utf8',
	);

	const analysis = analyzeIntegration(project);
	assert.equal(analysis.checks.find((check) => check.id === 'runtime')?.status, 'outdated');
	assert.match(analysis.checks.find((check) => check.id === 'runtime')?.note ?? '', /does not match/i);
	assert.equal(analysis.checks.find((check) => check.id === 'bridge')?.status, 'outdated');
	assert.match(analysis.checks.find((check) => check.id === 'bridge')?.note ?? '', /does not match/i);
	assert.equal(analysis.checks.find((check) => check.id === 'dist')?.status, 'outdated');
	assert.match(analysis.checks.find((check) => check.id === 'dist')?.note ?? '', /build/i);
});

test('installer inserts the app side-effect after a multiline import', (t) => {
	const project = makeProject(legacyLoader);
	t.after(() => fs.rmSync(project.workspaceRoot, { recursive: true, force: true }));

	const contextSource = `import {
	stateApp,
	stateLayout,
} from './stateApp';

export const context = { stateApp, stateLayout };
`;
	const contextPath = path.join(project.gameDir, 'context.ts');
	fs.writeFileSync(contextPath, contextSource, 'utf8');

	const result = installIntegration(project);
	assert.equal(result.ok, true);
	assert.equal(result.results.find((entry) => entry.id === 'app-import')?.action, 'patched');

	const installed = fs.readFileSync(contextPath, 'utf8');
	const multilineEnd = installed.indexOf("} from './stateApp';");
	const sideEffect = installed.indexOf("import './layoutOverrides';");
	const moduleBody = installed.indexOf('export const context');
	assert.ok(multilineEnd >= 0 && multilineEnd < sideEffect, 'side-effect import was inserted inside the multiline import');
	assert.ok(sideEffect < moduleBody, 'side-effect import should remain in the import block');
});

test('installer upgrades prop sync to report only actually assigned authored props', (t) => {
	const project = makeProject(legacyLoader);
	t.after(() => fs.rmSync(project.workspaceRoot, { recursive: true, force: true }));
	const utilsPath = path.join(project.libDir, 'utils.svelte.ts');
	fs.writeFileSync(utilsPath, `import { applyLayoutOverrides } from './layoutOverrides.svelte';

export function sync<TProps extends object>(props: TProps, targetInstance: any, ignore?: (keyof TProps)[]) {
	const keys = (Object.keys(props) as (keyof TProps)[]).filter((key) =>
		ignore ? !ignore.includes(key) : true,
	);
	keys.forEach((key) => {
		if (props[key] !== undefined) {
			// @ts-ignore
			targetInstance[key] = props[key];
		}
	});
	// Layout Editor support: re-apply any layout overrides after prop sync so
	// overrides always win. No-op when the project has no overrides loaded.
	applyLayoutOverrides(targetInstance, keys as string[]);
}
`, 'utf8');

	const before = analyzeIntegration(project);
	assert.equal(before.checks.find((check) => check.id === 'utils-hook')?.status, 'installable');
	const result = installIntegration(project);
	assert.equal(result.results.find((entry) => entry.id === 'utils-hook')?.action, 'patched');
	const installed = fs.readFileSync(utilsPath, 'utf8');
	assert.match(installed, /const assignedKeys = keys\.filter\(\(key\) => props\[key\] !== undefined\)/);
	assert.match(installed, /applyLayoutOverrides\(targetInstance, assignedKeys as string\[\]\)/);
	assert.doesNotMatch(installed, /applyLayoutOverrides\(targetInstance, keys as string\[\]\)/);
});
