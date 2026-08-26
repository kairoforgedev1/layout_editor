const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
	MAX_BOOKS_PER_MANIFEST,
	MAX_MANIFEST_BYTES,
	MAX_MANIFEST_FILES,
	parseTestCaseManifest,
	requireDirectJsonFileName,
	scanTestCases,
} = require('../src/main/testCases');

const makeApp = (t, { withDirectory = true } = {}) => {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sle-test-cases-'));
	t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
	if (withDirectory) fs.mkdirSync(path.join(appDir, 'testcases'));
	return appDir;
};

const manifest = (overrides = {}) => ({
	formatVersion: 1,
	kind: 'math-checker-test-book-manifest',
	variant: '0_0_lines_delta_test',
	publishId: '20260820_141853',
	generatedAt: '2026-08-20T16:35:17.717Z',
	// Deliberately outside the app. The scanner must never use this path.
	gameFolder: 'Z:\\must-not-be-read\\published-math',
	books: [
		{
			mode: 'base',
			bookId: 0,
			criteria: 'basegame',
			payoutMultiplierCents: 0,
			payoutX: 0,
			cost: 1,
			returnX: 0,
			bonusType: null,
			scatterCount: null,
			reason: 'Zero payout',
			scenario: {
				maxWin: false,
				paylineIds: [1, 2],
				symbols: ['H1', 'L1'],
				ignoredObject: { payload: 'not forwarded' },
			},
		},
	],
	...overrides,
});

const writeManifest = (appDir, fileName, value) => {
	const target = path.join(appDir, 'testcases', fileName);
	fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
	return target;
};

test('a missing testcase folder is a successful empty scan', (t) => {
	const appDir = makeApp(t, { withDirectory: false });
	const result = scanTestCases({ appDir });

	assert.equal(result.ok, true);
	assert.equal(result.directoryPresent, false);
	assert.deepEqual(result.manifests, []);
	assert.deepEqual(result.fileErrors, []);
});

test('scanner returns normalized metadata, a source token, and opaque per-entry keys', (t) => {
	const appDir = makeApp(t);
	writeManifest(appDir, 'books.json', manifest({
		books: [
			manifest().books[0],
			{ ...manifest().books[0], mode: 'bonus', bookId: 0, reason: 'Another zero id' },
		],
	}));

	const result = scanTestCases({ appDir });
	assert.equal(result.ok, true);
	assert.equal(result.directoryPresent, true);
	assert.equal(result.fileErrors.length, 0);
	assert.equal(result.manifests.length, 1);
	const found = result.manifests[0];
	assert.match(found.id, /^manifest_[0-9a-f]{24}$/);
	assert.match(found.manifestId, /^manifest_[0-9a-f]{24}$/);
	assert.equal(found.id, found.manifestId);
	assert.match(found.sourceToken, /^sha256:[0-9a-f]{64}$/);
	assert.equal(found.fileName, 'books.json');
	assert.equal(found.books[0].bookId, 0, 'zero is a valid book id');
	assert.equal(found.books[0].sourceIndex, 0);
	assert.equal(found.books[1].sourceIndex, 1);
	assert.match(found.books[0].key, /^book_[0-9a-f]{32}$/);
	assert.notEqual(found.books[0].key, found.books[1].key, 'array entries cannot collide on bookId');
	assert.equal(found.books[0].scenario.ignoredObject, undefined);
	assert.equal(found.gameFolder, undefined, 'absolute source paths are never forwarded');

	const again = scanTestCases({ appDir });
	assert.equal(again.manifests[0].sourceToken, found.sourceToken);
	assert.equal(again.manifests[0].books[0].key, found.books[0].key);

	writeManifest(appDir, 'books.json', manifest({ books: [{ mode: 'base', bookId: 1 }] }));
	const changed = scanTestCases({ appDir }).manifests[0];
	assert.notEqual(changed.sourceToken, found.sourceToken);
	assert.notEqual(changed.books[0].key, found.books[0].key);
});

test('direct JSON files are deterministic and malformed files are isolated', (t) => {
	const appDir = makeApp(t);
	writeManifest(appDir, 'z-last.json', manifest({ variant: 'z' }));
	writeManifest(appDir, 'A-first.JSON', manifest({ variant: 'a' }));
	writeManifest(appDir, 'broken.json', '{ definitely not json');
	fs.writeFileSync(path.join(appDir, 'testcases', 'ignored.txt'), '{}');

	const result = scanTestCases({ appDir });
	assert.equal(result.ok, true);
	assert.deepEqual(result.manifests.map((entry) => entry.fileName), ['A-first.JSON', 'z-last.json']);
	assert.deepEqual(result.fileErrors.map((entry) => entry.fileName), ['broken.json']);
	assert.match(result.fileErrors[0].error, /invalid JSON/i);
});

test('unsupported envelopes and invalid book identities become per-file errors', (t) => {
	const appDir = makeApp(t);
	writeManifest(appDir, 'wrong-version.json', manifest({ formatVersion: 2 }));
	writeManifest(appDir, 'wrong-kind.json', manifest({ kind: 'some-other-json' }));
	writeManifest(appDir, 'invalid-book.json', manifest({ books: [{ mode: 'base', bookId: -1 }] }));
	writeManifest(appDir, 'valid.json', manifest());

	const result = scanTestCases({ appDir });
	assert.equal(result.ok, true);
	assert.deepEqual(result.manifests.map((entry) => entry.fileName), ['valid.json']);
	assert.deepEqual(result.fileErrors.map((entry) => entry.fileName), [
		'invalid-book.json',
		'wrong-kind.json',
		'wrong-version.json',
	]);
});

test('directories and symlinks with JSON names are never parsed', (t) => {
	const appDir = makeApp(t);
	const testcaseDir = path.join(appDir, 'testcases');
	fs.mkdirSync(path.join(testcaseDir, 'folder.json'));
	writeManifest(appDir, 'valid.json', manifest());

	const outside = path.join(appDir, 'outside.json');
	fs.writeFileSync(outside, JSON.stringify(manifest({ variant: 'outside' })));
	let symlinkCreated = true;
	try {
		fs.symlinkSync(outside, path.join(testcaseDir, 'linked.json'), 'file');
	} catch (error) {
		if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) symlinkCreated = false;
		else throw error;
	}

	const result = scanTestCases({ appDir });
	assert.deepEqual(result.manifests.map((entry) => entry.fileName), ['valid.json']);
	assert.ok(result.fileErrors.some((entry) => entry.fileName === 'folder.json'));
	if (symlinkCreated) {
		assert.ok(result.fileErrors.some((entry) => entry.fileName === 'linked.json'));
	}
});

test('manifest byte, file-count, and book-count caps reject oversized input', (t) => {
	const appDir = makeApp(t);
	fs.writeFileSync(path.join(appDir, 'testcases', 'oversized.json'), Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
	let result = scanTestCases({ appDir });
	assert.equal(result.ok, true);
	assert.equal(result.manifests.length, 0);
	assert.match(result.fileErrors[0].error, /exceeds/i);

	fs.rmSync(path.join(appDir, 'testcases', 'oversized.json'));
	const tooManyBooks = manifest({
		books: Array.from({ length: MAX_BOOKS_PER_MANIFEST + 1 }, () => ({ mode: 'base', bookId: 1 })),
	});
	assert.throws(
		() => parseTestCaseManifest(JSON.stringify(tooManyBooks), { fileName: 'many.json' }),
		/books exceeds/i,
	);

	for (let index = 0; index < MAX_MANIFEST_FILES + 1; index++) {
		fs.writeFileSync(path.join(appDir, 'testcases', `${String(index).padStart(3, '0')}.json`), '{}');
	}
	result = scanTestCases({ appDir });
	assert.equal(result.ok, false);
	assert.match(result.error, /limit is/i);
});

test('parser accepts a UTF-8 BOM and caps renderer-facing scenario arrays and strings', () => {
	const longReason = 'x'.repeat(1_200);
	const source = `\uFEFF${JSON.stringify(manifest({
		books: [{
			mode: 'base',
			bookId: 5,
			reason: longReason,
			scenario: {
				symbols: Array.from({ length: 250 }, (_, index) => `symbol-${index}`),
				privatePayload: { shouldNotLeak: true },
			},
		}],
	}))}`;
	const parsed = parseTestCaseManifest(source, { fileName: 'bom.json' });

	assert.equal(parsed.books[0].reason.length, 1_000);
	assert.equal(parsed.books[0].scenario.symbols.length, 200);
	assert.equal(parsed.books[0].scenario.privatePayload, undefined);
});

test('direct manifest filename validation rejects traversal and nested paths', () => {
	assert.equal(requireDirectJsonFileName('books.JSON'), 'books.JSON');
	for (const unsafe of ['../books.json', '..\\books.json', 'nested/books.json', 'C:\\books.json', 'books.txt']) {
		assert.throws(() => requireDirectJsonFileName(unsafe), /direct JSON filename/i);
	}
});
