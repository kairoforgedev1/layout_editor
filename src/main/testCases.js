/**
 * Read-only discovery of Math Checker testcase book manifests.
 *
 * Testcase files are project input, not trusted application configuration. Keep
 * all filesystem access rooted in `<appDir>/testcases`, parse bounded files, and
 * return freshly-normalized data rather than forwarding arbitrary JSON objects
 * into the renderer.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEST_CASE_MANIFEST_KIND = 'math-checker-test-book-manifest';
const TEST_CASE_FORMAT_VERSION = 1;
const MAX_MANIFEST_FILES = 100;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_BOOKS_PER_MANIFEST = 10_000;
const MAX_SCENARIO_ARRAY_ITEMS = 200;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000_000_000;

class TestCaseManifestError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TestCaseManifestError';
	}
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Deterministic across host locales and insensitive to filename case first. */
const compareFileNames = (left, right) => {
	const leftFolded = left.toLowerCase();
	const rightFolded = right.toLowerCase();
	if (leftFolded < rightFolded) return -1;
	if (leftFolded > rightFolded) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
};

/** Whether candidate is root itself or a descendant, without prefix matching. */
function isPathWithin(root, candidate) {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const requiredString = (value, field, maxLength = 256) => {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TestCaseManifestError(`${field} must be a non-empty string`);
	}
	if (value.length > maxLength) {
		throw new TestCaseManifestError(`${field} exceeds ${maxLength} characters`);
	}
	return value.trim();
};

const requireDirectJsonFileName = (value) => {
	const fileName = requiredString(value, 'fileName', 512);
	if (
		fileName !== value ||
		fileName === '.' ||
		fileName === '..' ||
		fileName.includes('/') ||
		fileName.includes('\\') ||
		fileName.includes('\0') ||
		path.extname(fileName).toLowerCase() !== '.json'
	) {
		throw new TestCaseManifestError('fileName must be a direct JSON filename');
	}
	return fileName;
};

const optionalString = (value, maxLength) => {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') return null;
	return value.trim().slice(0, maxLength);
};

const optionalFiniteNumber = (value, { integer = false, min = 0, max = MAX_ABSOLUTE_NUMBER } = {}) => {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (integer && !Number.isSafeInteger(value)) return null;
	if (value < min || value > max) return null;
	return value;
};

const requiredBookId = (value, index) => {
	const normalized = optionalFiniteNumber(value, { integer: true });
	if (normalized === null) {
		throw new TestCaseManifestError(`books[${index}].bookId must be a non-negative safe integer`);
	}
	return normalized;
};

const normalizeNumberArray = (value, options = {}) => {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, MAX_SCENARIO_ARRAY_ITEMS)
		.map((entry) => optionalFiniteNumber(entry, options))
		.filter((entry) => entry !== null);
};

const normalizeStringArray = (value, itemLength = 64) => {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, MAX_SCENARIO_ARRAY_ITEMS)
		.map((entry) => optionalString(entry, itemLength))
		.filter((entry) => entry !== null && entry !== '');
};

/** Keep only known, bounded fields useful for listing and filtering scenarios. */
function normalizeScenario(value) {
	if (!isObject(value)) return null;
	const normalized = {
		maxWin: typeof value.maxWin === 'boolean' ? value.maxWin : null,
		maxWinSource: optionalString(value.maxWinSource, 160),
		preBonusWinCents: optionalFiniteNumber(value.preBonusWinCents),
		paylineIds: normalizeNumberArray(value.paylineIds, { integer: true }),
		symbols: normalizeStringArray(value.symbols),
		ckCount: optionalFiniteNumber(value.ckCount, { integer: true }),
		ewReels: normalizeNumberArray(value.ewReels, { integer: true }),
		ewMultipliers: normalizeNumberArray(value.ewMultipliers),
		retrigger: typeof value.retrigger === 'boolean' ? value.retrigger : null,
	};
	const hasValue = Object.values(normalized).some((entry) =>
		Array.isArray(entry) ? entry.length > 0 : entry !== null,
	);
	return hasValue ? normalized : null;
}

function normalizeBook(value, index, { fileName, sourceToken }) {
	if (!isObject(value)) {
		throw new TestCaseManifestError(`books[${index}] must be an object`);
	}
	const mode = requiredString(value.mode, `books[${index}].mode`, 128);
	const bookId = requiredBookId(value.bookId, index);
	return {
		key: `book_${sha256(
			`book\0${fileName}\0${sourceToken}\0${index}\0${mode}\0${bookId}`,
		).slice(0, 32)}`,
		// The runner must use this explicit index after re-reading and hashing the
		// file; opaque keys are identifiers, not an encoding to parse.
		sourceIndex: index,
		index,
		mode,
		bookId,
		criteria: optionalString(value.criteria, 256),
		payoutMultiplierCents: optionalFiniteNumber(value.payoutMultiplierCents),
		payoutX: optionalFiniteNumber(value.payoutX),
		cost: optionalFiniteNumber(value.cost),
		returnX: optionalFiniteNumber(value.returnX),
		bonusType: optionalString(value.bonusType, 128),
		scatterCount: optionalFiniteNumber(value.scatterCount, { integer: true }),
		reason: optionalString(value.reason, 1_000),
		scenario: normalizeScenario(value.scenario),
	};
}

/** Parse one already-bounded manifest and return a safe renderer DTO. */
function parseTestCaseManifest(source, { fileName = 'test-books.json' } = {}) {
	const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
	if (buffer.length > MAX_MANIFEST_BYTES) {
		throw new TestCaseManifestError(`file exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
	}
	// Always derive this from the bytes being parsed. Accepting an outside token
	// would let a caller accidentally bless stale or substituted file contents.
	const token = `sha256:${sha256(buffer)}`;
	let parsed;
	try {
		const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
		parsed = JSON.parse(text);
	} catch (error) {
		throw new TestCaseManifestError(`invalid JSON: ${error.message}`);
	}
	if (!isObject(parsed)) throw new TestCaseManifestError('manifest root must be an object');
	if (parsed.formatVersion !== TEST_CASE_FORMAT_VERSION) {
		throw new TestCaseManifestError(`unsupported formatVersion ${String(parsed.formatVersion)}`);
	}
	if (parsed.kind !== TEST_CASE_MANIFEST_KIND) {
		throw new TestCaseManifestError(`unsupported manifest kind ${String(parsed.kind)}`);
	}
	const variant = requiredString(parsed.variant, 'variant', 256);
	if (!Array.isArray(parsed.books)) throw new TestCaseManifestError('books must be an array');
	if (parsed.books.length > MAX_BOOKS_PER_MANIFEST) {
		throw new TestCaseManifestError(`books exceeds the ${MAX_BOOKS_PER_MANIFEST}-entry limit`);
	}
	const normalizedFileName = requireDirectJsonFileName(fileName);
	const id = `manifest_${sha256(`manifest\0${normalizedFileName}`).slice(0, 24)}`;
	return {
		id,
		// Backward-friendly descriptive alias for renderer code written while this
		// feature was being developed. New callers should prefer `id`.
		manifestId: id,
		fileName: normalizedFileName,
		sourceToken: token,
		formatVersion: TEST_CASE_FORMAT_VERSION,
		kind: TEST_CASE_MANIFEST_KIND,
		variant,
		publishId:
			typeof parsed.publishId === 'number' && Number.isSafeInteger(parsed.publishId)
				? String(parsed.publishId)
				: optionalString(parsed.publishId, 256),
		generatedAt: optionalString(parsed.generatedAt, 128),
		books: parsed.books.map((book, index) =>
			normalizeBook(book, index, { fileName: normalizedFileName, sourceToken: token }),
		),
	};
}

const scanFailure = (error, extra = {}) => ({
	ok: false,
	error: String(error?.message ?? error),
	...extra,
});

/** Read at most the configured cap even if a file grows after its first stat. */
function readBoundedManifest(filePath) {
	const descriptor = fs.openSync(filePath, 'r');
	try {
		const openedStat = fs.fstatSync(descriptor);
		if (!openedStat.isFile()) throw new TestCaseManifestError('entry is not a regular file');
		if (openedStat.size > MAX_MANIFEST_BYTES) {
			throw new TestCaseManifestError(`file exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
		}
		// One additional byte plus a final fstat detects length changes without ever
		// allocating from an unbounded, raced file size.
		const capacity = Math.min(openedStat.size + 1, MAX_MANIFEST_BYTES + 1);
		const buffer = Buffer.allocUnsafe(Math.max(1, capacity));
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(
				descriptor,
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				bytesRead,
			);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > MAX_MANIFEST_BYTES) {
			throw new TestCaseManifestError(`file exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
		}
		const finalStat = fs.fstatSync(descriptor);
		if (finalStat.size > MAX_MANIFEST_BYTES) {
			throw new TestCaseManifestError(`file exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
		}
		if (finalStat.size !== bytesRead) {
			throw new TestCaseManifestError('file changed while it was being scanned; recheck it');
		}
		return buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(descriptor);
	}
}

/**
 * Scan direct JSON children of `<appDir>/testcases`.
 *
 * A malformed file is reported in `fileErrors`; it does not prevent other valid
 * manifests from being returned. Missing testcase directories are normal.
 */
function scanTestCases({ appDir } = {}) {
	const scannedAtMs = Date.now();
	if (typeof appDir !== 'string' || !appDir.trim()) {
		return scanFailure('appDir must be a non-empty string', { scannedAtMs });
	}

	let appRoot;
	try {
		appRoot = fs.realpathSync(path.resolve(appDir));
		if (!fs.statSync(appRoot).isDirectory()) {
			return scanFailure('appDir is not a directory', { scannedAtMs });
		}
	} catch (error) {
		return scanFailure(`cannot access appDir: ${error.message}`, { scannedAtMs });
	}

	const testcaseCandidate = path.join(appRoot, 'testcases');
	let testcaseStat;
	try {
		testcaseStat = fs.lstatSync(testcaseCandidate);
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return {
				ok: true,
				directory: testcaseCandidate,
				directoryPresent: false,
				scannedAtMs,
				manifests: [],
				fileErrors: [],
			};
		}
		return scanFailure(`cannot access testcases directory: ${error.message}`, {
			directory: testcaseCandidate,
			directoryPresent: false,
			scannedAtMs,
		});
	}
	if (testcaseStat.isSymbolicLink() || !testcaseStat.isDirectory()) {
		return scanFailure('testcases must be a real directory, not a symlink or file', {
			directory: testcaseCandidate,
			directoryPresent: true,
			scannedAtMs,
		});
	}

	let testcaseRoot;
	try {
		testcaseRoot = fs.realpathSync(testcaseCandidate);
	} catch (error) {
		return scanFailure(`cannot resolve testcases directory: ${error.message}`, {
			directory: testcaseCandidate,
			directoryPresent: true,
			scannedAtMs,
		});
	}
	if (!isPathWithin(appRoot, testcaseRoot) || testcaseRoot === appRoot) {
		return scanFailure('testcases directory resolves outside the selected app', {
			directory: testcaseCandidate,
			directoryPresent: true,
			scannedAtMs,
		});
	}

	let entries;
	try {
		entries = fs.readdirSync(testcaseRoot, { withFileTypes: true });
	} catch (error) {
		return scanFailure(`cannot read testcases directory: ${error.message}`, {
			directory: testcaseRoot,
			directoryPresent: true,
			scannedAtMs,
		});
	}
	const jsonEntries = entries
		.filter((entry) => path.extname(entry.name).toLowerCase() === '.json')
		.sort((left, right) => compareFileNames(left.name, right.name));
	if (jsonEntries.length > MAX_MANIFEST_FILES) {
		return scanFailure(`testcases contains ${jsonEntries.length} JSON entries; the limit is ${MAX_MANIFEST_FILES}`, {
			directory: testcaseRoot,
			directoryPresent: true,
			scannedAtMs,
		});
	}

	const manifests = [];
	const fileErrors = [];
	for (const entry of jsonEntries) {
		const fileName = entry.name;
		const filePath = path.join(testcaseRoot, fileName);
		try {
			if (!entry.isFile() || entry.isSymbolicLink()) {
				throw new TestCaseManifestError('entry is not a direct regular file');
			}
			const stat = fs.lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new TestCaseManifestError('entry is not a direct regular file');
			}
			if (stat.size > MAX_MANIFEST_BYTES) {
				throw new TestCaseManifestError(`file exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
			}
			const realFile = fs.realpathSync(filePath);
			if (!isPathWithin(testcaseRoot, realFile) || realFile === testcaseRoot) {
				throw new TestCaseManifestError('entry resolves outside the testcases directory');
			}
			const buffer = readBoundedManifest(realFile);
			const finalStat = fs.lstatSync(filePath);
			const finalRealFile = fs.realpathSync(filePath);
			if (
				finalStat.isSymbolicLink() ||
				!finalStat.isFile() ||
				finalRealFile !== realFile ||
				!isPathWithin(testcaseRoot, finalRealFile)
			) {
				throw new TestCaseManifestError('entry changed or escaped the testcases directory while scanning');
			}
			manifests.push(parseTestCaseManifest(buffer, { fileName }));
		} catch (error) {
			fileErrors.push({ fileName, error: String(error?.message ?? error) });
		}
	}

	return {
		ok: true,
		directory: testcaseRoot,
		directoryPresent: true,
		scannedAtMs,
		manifests,
		fileErrors,
	};
}

module.exports = {
	MAX_BOOKS_PER_MANIFEST,
	MAX_MANIFEST_BYTES,
	MAX_MANIFEST_FILES,
	TEST_CASE_FORMAT_VERSION,
	TEST_CASE_MANIFEST_KIND,
	TestCaseManifestError,
	isPathWithin,
	parseTestCaseManifest,
	requireDirectJsonFileName,
	scanTestCases,
};
