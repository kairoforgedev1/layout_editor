const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
	MAX_PROBES,
	collectProbeFiles,
	verifyDevServer,
} = require('../src/main/devServerIdentity');

/** A game app laid out the way the editor expects: static/ served from the root. */
const makeApp = (t, { atlasFrames = ['base_reel.png'], extra = {} } = {}) => {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-identity-'));
	t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
	const write = (rel, body) => {
		const full = path.join(appDir, 'static', rel.split('/').join(path.sep));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body);
	};
	write('assets/sprites/reelsFrame/reels_frame.json', JSON.stringify({
		frames: Object.fromEntries(
			atlasFrames.map((name) => [name, { frame: { x: 0, y: 0, w: 4, h: 4 } }]),
		),
	}));
	write('assets/fonts/shared.woff2', 'identical-in-both-games');
	write('favicon.png', 'icon');
	for (const [rel, body] of Object.entries(extra)) write(rel, body);
	return appDir;
};

/** Files a forked game keeps byte-identical from the project it was copied from. */
const sharedManifests = (count) => {
	const files = {};
	for (let i = 0; i < count; i += 1) {
		files[`assets/sprites/a${String(i).padStart(3, '0')}/atlas.json`] = `shared-${i}`;
	}
	return files;
};

/** Serve one app's static/ directory, the way the real dev server does. */
const serveApp = async (t, appDir) => {
	const root = path.join(appDir, 'static');
	const server = http.createServer((request, response) => {
		const rel = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
		const full = path.join(root, rel.split('/').join(path.sep));
		if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
			response.writeHead(404);
			response.end('not found');
			return;
		}
		response.writeHead(200);
		response.end(fs.readFileSync(full));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	return server.address().port;
};

test('the most discriminating static files are probed first', (t) => {
	const appDir = makeApp(t);
	const probes = collectProbeFiles(appDir);

	assert.ok(probes.length > 0);
	assert.equal(
		probes[0].rel,
		'assets/sprites/reelsFrame/reels_frame.json',
		'a sprite atlas separates two games; a shared font does not',
	);
	assert.ok(probes.length <= MAX_PROBES, 'the probe set stays bounded');
});

test('every asset manifest is probed while the tier fits in the budget', (t) => {
	const appDir = makeApp(t, { extra: sharedManifests(40) });
	const probes = collectProbeFiles(appDir).map((entry) => entry.rel);

	assert.ok(
		probes.includes('assets/sprites/reelsFrame/reels_frame.json'),
		'a manifest must not be dropped just for sorting late',
	);
	assert.equal(probes.filter((rel) => rel.endsWith('.json')).length, 41);
});

test('an oversized manifest tier is sampled across its whole range', (t) => {
	const appDir = makeApp(t, { extra: sharedManifests(400) });
	const probes = collectProbeFiles(appDir).map((entry) => entry.rel);

	assert.equal(probes.length, MAX_PROBES, 'the sweep stays bounded');
	assert.equal(probes[0], 'assets/sprites/a000/atlas.json', 'the range starts at the first file');
	assert.equal(
		probes.at(-1),
		'assets/sprites/reelsFrame/reels_frame.json',
		'and always reaches the last, where a fork most often diverges',
	);
});

test('a near-identical fork differing in one late file is still caught', async (t) => {
	// The real pair on this machine shares 63 of 64 probed files and differs only
	// in reels_frame.json, which sorts last. Truncating the list missed it entirely.
	const shared = sharedManifests(40);
	const opened = makeApp(t, { atlasFrames: ['base_reel.png'], extra: shared });
	const running = makeApp(t, { atlasFrames: ['frame_edge.png', 'frame_bg.png'], extra: shared });
	const port = await serveApp(t, running);

	const result = await verifyDevServer({ appDir: opened, port });
	assert.equal(result.verified, true);
	assert.equal(result.matches, false, 'a single differing manifest must fail the check');
	assert.equal(result.probe, 'assets/sprites/reelsFrame/reels_frame.json');
});

test('a server serving the opened project verifies as a match', async (t) => {
	const appDir = makeApp(t);
	const port = await serveApp(t, appDir);

	const result = await verifyDevServer({ appDir, port });
	assert.equal(result.ok, true);
	assert.equal(result.verified, true);
	assert.equal(result.matches, true);
	assert.ok(result.compared > 0);
});

test('another game on the same port is detected through its atlas', async (t) => {
	// The real failure: two projects hardcode --port 3001 and differ only in content.
	const opened = makeApp(t, { atlasFrames: ['base_reel.png'] });
	const running = makeApp(t, { atlasFrames: ['frame_edge.png', 'frame_bg.png'] });
	const port = await serveApp(t, running);

	const result = await verifyDevServer({ appDir: opened, port });
	assert.equal(result.verified, true);
	assert.equal(result.matches, false);
	assert.equal(result.probe, 'assets/sprites/reelsFrame/reels_frame.json');
	assert.match(result.reason, /serves a different/i);
});

test('a server that does not serve the file at all is a mismatch', async (t) => {
	const opened = makeApp(t);
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-identity-bare-'));
	t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
	fs.mkdirSync(path.join(bare, 'static'));
	const port = await serveApp(t, bare);

	const result = await verifyDevServer({ appDir: opened, port });
	assert.equal(result.verified, true);
	assert.equal(result.matches, false);
	assert.match(result.reason, /does not serve/i);
});

test('an unreachable server is unknown, never a false mismatch', async (t) => {
	const appDir = makeApp(t);
	const result = await verifyDevServer({
		appDir,
		port: 3001,
		fetchBytes: async () => ({ ok: false, timedOut: true }),
	});

	assert.equal(result.verified, false, 'silence is not evidence of a different project');
	assert.equal(result.matches, undefined);
	assert.match(result.reason, /did not answer/i);
});

test('a project with no static files reports unknown instead of guessing', async (t) => {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-identity-empty-'));
	t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

	const result = await verifyDevServer({ appDir, port: 3001 });
	assert.equal(result.ok, true);
	assert.equal(result.verified, false);
	assert.match(result.reason, /no static files/i);
});

test('bad input is rejected rather than probed', async () => {
	assert.equal((await verifyDevServer({ appDir: '', port: 3001 })).ok, false);
	assert.equal((await verifyDevServer({ appDir: 'x', port: 0 })).ok, false);
	assert.equal((await verifyDevServer({ appDir: 'x', port: 99999 })).ok, false);
});
