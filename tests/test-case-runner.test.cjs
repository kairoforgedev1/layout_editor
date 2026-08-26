const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { scanTestCases } = require('../src/main/testCases');
const {
	extractTestBook,
	MAX_EXTRACTED_BOOK_BYTES,
	resolveMathEventsFile,
	resolveTestCaseSelection,
	runTestCase,
	testBookExtractorPath,
} = require('../src/main/testCaseRunner');

const makeFixture = (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-test-runner-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const appDir = path.join(root, 'app');
	const testcases = path.join(appDir, 'testcases');
	const mathDir = path.join(root, 'published-math');
	fs.mkdirSync(testcases, { recursive: true });
	fs.mkdirSync(mathDir, { recursive: true });
	fs.writeFileSync(path.join(mathDir, 'index.json'), JSON.stringify({
		modes: [{ name: 'base', cost: 1, events: 'books_base.jsonl.zst' }],
	}));
	const books = [
		{ id: 0, payoutMultiplier: 0, events: [{ index: 0, type: 'reveal' }] },
		{ id: 1, payoutMultiplier: 250, events: [{ index: 0, type: 'reveal' }, { index: 1, type: 'finalWin', amount: 250 }] },
	];
	fs.writeFileSync(
		path.join(mathDir, 'books_base.jsonl.zst'),
		zlib.zstdCompressSync(Buffer.from(books.map((book) => JSON.stringify(book)).join('\n'))),
	);
	const manifestPath = path.join(testcases, 'books.json');
	fs.writeFileSync(manifestPath, JSON.stringify({
		formatVersion: 1,
		kind: 'math-checker-test-book-manifest',
		variant: 'runner-test',
		publishId: 'one',
		gameFolder: mathDir,
		books: [{
			mode: 'base',
			bookId: 1,
			criteria: 'single_win',
			payoutMultiplierCents: 250,
			payoutX: 2.5,
		}],
	}));
	const found = scanTestCases({ appDir }).manifests[0];
	return { appDir, manifestPath, mathDir, manifest: found, book: found.books[0] };
};

const listenHealth = async (t, capabilities) => {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ status: 'ok', capabilities }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	return `http://127.0.0.1:${server.address().port}`;
};

test('packaged builds launch the unpacked system-Node extractor', () => {
	assert.equal(
		testBookExtractorPath(path.join('C:', 'Layout Editor', 'resources', 'app.asar', 'src', 'main')),
		path.join('C:', 'Layout Editor', 'resources', 'app.asar.unpacked', 'src', 'main', 'testBookExtractor.mjs'),
	);
	assert.equal(
		testBookExtractorPath(path.join('C:', 'layout-editor', 'src', 'main')),
		path.join('C:', 'layout-editor', 'src', 'main', 'testBookExtractor.mjs'),
	);
});

test('runner revalidates opaque manifest selection and rejects stale scan data', (t) => {
	const fixture = makeFixture(t);
	const selection = resolveTestCaseSelection({
		appDir: fixture.appDir,
		manifestId: fixture.manifest.id,
		sourceToken: fixture.manifest.sourceToken,
		bookKey: fixture.book.key,
	});
	assert.equal(selection.book.bookId, 1);
	assert.equal(selection.gameFolder, fixture.mathDir);

	const changed = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
	changed.books[0].criteria = 'changed';
	fs.writeFileSync(fixture.manifestPath, JSON.stringify(changed));
	assert.throws(() => resolveTestCaseSelection({
		appDir: fixture.appDir,
		manifestId: fixture.manifest.id,
		sourceToken: fixture.manifest.sourceToken,
		bookKey: fixture.book.key,
	}), /changed.*refresh/i);
});

test('math events are resolved inside gameFolder and traversal is rejected', (t) => {
	const fixture = makeFixture(t);
	const resolved = resolveMathEventsFile(fixture.mathDir, 'BASE');
	assert.equal(resolved.mode, 'base');
	assert.equal(path.basename(resolved.eventsPath), 'books_base.jsonl.zst');

	const outside = path.join(path.dirname(fixture.mathDir), 'outside.jsonl.zst');
	fs.writeFileSync(outside, Buffer.from('not zstd'));
	fs.writeFileSync(path.join(fixture.mathDir, 'index.json'), JSON.stringify({
		modes: [{ name: 'base', events: '../outside.jsonl.zst' }],
	}));
	assert.throws(() => resolveMathEventsFile(fixture.mathDir, 'base'), /outside gameFolder/i);
});

test('runTestCase verifies RGS capability and extracts the exact published book', async (t) => {
	const fixture = makeFixture(t);
	const rgsUrl = await listenHealth(t, { forcedTestBooks: true });
	const result = await runTestCase({
		appDir: fixture.appDir,
		manifestId: fixture.manifest.id,
		sourceToken: fixture.manifest.sourceToken,
		bookKey: fixture.book.key,
		rgsUrl,
		sessionID: 'test-session',
	});
	assert.equal(result.ok, true);
	assert.equal(result.mode, 'base');
	assert.equal(result.bookId, 1);
	assert.equal(result.outcome.bookId, 1);
	assert.equal(result.outcome.payoutMultiplier, 250);
	assert.deepEqual(result.outcome.events.map((event) => event.type), ['reveal', 'finalWin']);
});

test('runTestCase refuses an RGS that could silently ignore the forced outcome', async (t) => {
	const fixture = makeFixture(t);
	const rgsUrl = await listenHealth(t, {});
	await assert.rejects(() => runTestCase({
		appDir: fixture.appDir,
		manifestId: fixture.manifest.id,
		sourceToken: fixture.manifest.sourceToken,
		bookKey: fixture.book.key,
		rgsUrl,
		sessionID: 'test-session',
	}), /does not support forced testcase books/i);
});

test('runner rejects a published book whose payout no longer matches the manifest', async (t) => {
	const fixture = makeFixture(t);
	const changedBooks = [
		{ id: 0, payoutMultiplier: 0, events: [{ index: 0, type: 'reveal' }] },
		{ id: 1, payoutMultiplier: 251, events: [{ index: 0, type: 'reveal' }] },
	];
	fs.writeFileSync(
		path.join(fixture.mathDir, 'books_base.jsonl.zst'),
		zlib.zstdCompressSync(Buffer.from(changedBooks.map((book) => JSON.stringify(book)).join('\n'))),
	);
	const rgsUrl = await listenHealth(t, { forcedTestBooks: true });
	await assert.rejects(() => runTestCase({
		appDir: fixture.appDir,
		manifestId: fixture.manifest.id,
		sourceToken: fixture.manifest.sourceToken,
		bookKey: fixture.book.key,
		rgsUrl,
		sessionID: 'test-session',
	}), /does not match the payout recorded/i);
});

test('extractor rejects an oversized decompressed book line before parsing it', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-test-runner-large-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const eventsPath = path.join(root, 'books_base.jsonl.zst');
	const oversized = JSON.stringify({
		id: 0,
		payoutMultiplier: 0,
		events: [{ type: 'oversized', value: 'x'.repeat(MAX_EXTRACTED_BOOK_BYTES) }],
	});
	fs.writeFileSync(eventsPath, zlib.zstdCompressSync(Buffer.from(oversized)));
	await assert.rejects(() => extractTestBook({
		eventsPath,
		bookId: 0,
		cacheKey: `oversized:${eventsPath}`,
		timeoutMs: 20_000,
	}), /line exceeds.*limit/i);
});
