import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const source = await readFile(
	new URL('../src/renderer/js/testCaseModel.js', import.meta.url),
	'utf8',
);
const {
	filterTestCaseBooks,
	findSelectedTestCaseBook,
	findTestCaseManifest,
	testCaseBookMeta,
	testCaseBookTitle,
	testCaseManifestLabel,
} = await import(moduleUrl(source));

const books = [
	{
		key: 'opaque-base-4',
		mode: 'base',
		bookId: 4,
		criteria: 'freegame_normal',
		payoutX: 40,
		bonusType: 'normal',
		reason: 'Winning payline 1',
		scenario: { symbols: ['H1', 'L2'], paylineIds: [1] },
	},
	{
		key: 'opaque-hidden-50',
		mode: 'mystery_bonus',
		bookId: 50,
		criteria: 'hidden',
		payoutX: 9.954,
		bonusType: 'hidden',
		reason: null,
		scenario: { symbols: ['EW'], retrigger: true },
	},
];

const manifest = {
	id: 'canonical-manifest-id',
	manifestId: 'legacy-alias',
	fileName: 'qa_books.json',
	variant: '0_0_lines_delta_test',
	publishId: '20260820_141853',
	books,
};

test('test-case labels remain compact and human-readable', () => {
	assert.equal(testCaseBookTitle(books[0]), 'Winning payline 1');
	assert.equal(testCaseBookTitle(books[1]), 'Hidden');
	assert.equal(testCaseBookMeta(books[0]), 'Base · book #4 · 40x · Normal');
	assert.equal(testCaseBookMeta(books[1]), 'Mystery Bonus · book #50 · 9.954x · Hidden');
	assert.equal(
		testCaseManifestLabel(manifest),
		'qa_books (2)',
	);
});

test('filter matches all tokens across metadata and normalized scenario summaries', () => {
	assert.deepEqual(filterTestCaseBooks(manifest, 'base payline 4'), [books[0]]);
	assert.deepEqual(filterTestCaseBooks(manifest, 'mystery EW retrigger'), [books[1]]);
	assert.deepEqual(filterTestCaseBooks(manifest, 'normal 50'), []);
	assert.deepEqual(filterTestCaseBooks(manifest, '   '), books);
});

test('selection uses canonical manifest ids and opaque book keys', () => {
	const state = {
		manifests: [manifest],
		selectedManifestId: 'canonical-manifest-id',
		selectedBookKey: 'opaque-hidden-50',
	};
	assert.equal(findTestCaseManifest(state), manifest);
	assert.equal(findSelectedTestCaseBook(state), books[1]);
	state.selectedBookKey = null;
	assert.equal(findSelectedTestCaseBook(state), null, 'a manifest never auto-selects a book');
});
