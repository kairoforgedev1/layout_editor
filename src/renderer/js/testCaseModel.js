/** Pure display/filter helpers for Math Checker test-book manifests. */

const MODE_LABELS = {
	base: 'Base',
	feature_spins: 'Feature Spins',
	bonus_hunt: 'Extra Chance',
	bonus: 'Bonus Buy',
	super_bonus: 'Super Bonus',
	mystery_bonus: 'Mystery Bonus',
};

const SPECIAL_WORDS = {
	basegame: 'Base game',
	freegame: 'Free game',
	maxwin: 'Max win',
};

export const humanizeTestCaseToken = (value) => {
	const source = String(value ?? '').trim();
	if (!source) return '';
	const exact = SPECIAL_WORDS[source.toLowerCase()];
	if (exact) return exact;
	const words = source.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export const testCaseModeLabel = (mode) =>
	(MODE_LABELS[String(mode ?? '').toLowerCase()] ?? humanizeTestCaseToken(mode)) || 'Unknown mode';

export function testCaseBookTitle(book) {
	const reason = String(book?.reason ?? '').trim();
	if (reason) return reason;
	const criteria = humanizeTestCaseToken(book?.criteria);
	if (criteria) return criteria;
	return `${testCaseModeLabel(book?.mode)} book #${book?.bookId ?? '?'}`;
}

const payoutLabel = (value) => {
	const payout = Number(value);
	if (!Number.isFinite(payout)) return null;
	return `${Number.isInteger(payout) ? payout : Number(payout.toFixed(3))}x`;
};

export function testCaseBookMeta(book) {
	return [
		testCaseModeLabel(book?.mode),
		`book #${book?.bookId ?? '?'}`,
		payoutLabel(book?.payoutX),
		book?.bonusType ? humanizeTestCaseToken(book.bonusType) : null,
	].filter(Boolean).join(' · ');
}

const searchableBookText = (book) => {
	let scenario = '';
	try {
		scenario = JSON.stringify(book?.scenario ?? {});
	} catch {
		// The main-process scanner returns plain JSON, but keep filtering defensive.
	}
	return [
		book?.key,
		book?.mode,
		testCaseModeLabel(book?.mode),
		book?.bookId,
		book?.criteria,
		book?.reason,
		book?.bonusType,
		book?.scatterCount,
		book?.payoutX,
		book?.returnX,
		scenario,
	].filter((value) => value !== null && value !== undefined).join(' ').toLowerCase();
};

export function filterTestCaseBooks(manifest, query) {
	const books = Array.isArray(manifest?.books) ? manifest.books : [];
	const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return books;
	return books.filter((book) => {
		const haystack = searchableBookText(book);
		return tokens.every((token) => haystack.includes(token));
	});
}

export function testCaseManifestLabel(manifest) {
	const name = manifest?.fileName?.replace(/\.json$/i, '') || manifest?.variant || 'Test books';
	const count = Array.isArray(manifest?.books) ? manifest.books.length : 0;
	return `${name} (${count})`;
}

export const testCaseManifestId = (manifest) => manifest?.id ?? manifest?.manifestId ?? null;

export const findTestCaseManifest = (testCases) =>
	(testCases?.manifests ?? []).find(
		(manifest) => testCaseManifestId(manifest) === testCases.selectedManifestId,
	) ?? null;

export const findSelectedTestCaseBook = (testCases, manifest = findTestCaseManifest(testCases)) =>
	(manifest?.books ?? []).find((book) => book.key === testCases?.selectedBookKey) ?? null;
