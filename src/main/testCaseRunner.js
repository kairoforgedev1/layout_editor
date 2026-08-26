/** Resolve an exact Math Checker test-book reference and arm the local mock RGS. */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const { isPathWithin, scanTestCases } = require('./testCases');

const MAX_INDEX_BYTES = 1024 * 1024;
// Keep one MiB of headroom for the wallet/play envelope under the RGS 5 MiB cap.
const MAX_EXTRACTED_BOOK_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_EXTRACTIONS = 2;
const EXTRACT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

const outcomeCache = new Map();
const inFlightExtractions = new Map();
const activeExtractors = new Map();
let outcomeCacheBytes = 0;

const sourceToken = (buffer) =>
	`sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;

/** System Node cannot read files through Electron's app.asar virtual path. */
function testBookExtractorPath(baseDir = __dirname) {
	const bundledPath = path.join(baseDir, 'testBookExtractor.mjs');
	const asarSegment = `${path.sep}app.asar${path.sep}`;
	if (!bundledPath.includes(asarSegment)) return bundledPath;
	return bundledPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
}

const boundedFile = (filePath, maxBytes, description) => {
	const pathStat = fs.lstatSync(filePath);
	if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
		throw new Error(`${description} must be a regular file.`);
	}
	if (pathStat.size > maxBytes) {
		throw new Error(`${description} exceeds the ${maxBytes}-byte limit.`);
	}
	const descriptor = fs.openSync(filePath, 'r');
	try {
		const openedStat = fs.fstatSync(descriptor);
		if (!openedStat.isFile()) throw new Error(`${description} must be a regular file.`);
		if (openedStat.size > maxBytes) {
			throw new Error(`${description} exceeds the ${maxBytes}-byte limit.`);
		}
		const capacity = Math.min(openedStat.size + 1, maxBytes + 1);
		const buffer = Buffer.allocUnsafe(Math.max(1, capacity));
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		const finalStat = fs.fstatSync(descriptor);
		if (bytesRead > maxBytes || finalStat.size > maxBytes) {
			throw new Error(`${description} exceeds the ${maxBytes}-byte limit.`);
		}
		if (finalStat.size !== bytesRead) {
			throw new Error(`${description} changed while it was being read.`);
		}
		return buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(descriptor);
	}
};

/** Re-scan and re-hash the selected manifest so stale renderer data cannot run. */
function resolveTestCaseSelection({ appDir, manifestId, sourceToken: expectedToken, bookKey }) {
	const scan = scanTestCases({ appDir });
	if (!scan.ok) throw new Error(scan.error || 'Could not scan testcase manifests.');
	const manifest = scan.manifests.find((entry) =>
		entry.id === manifestId || entry.manifestId === manifestId,
	);
	if (!manifest) throw new Error('The selected testcase manifest no longer exists. Refresh Simulator.');
	if (manifest.sourceToken !== expectedToken) {
		throw new Error('The selected testcase manifest changed. Refresh Simulator and select the book again.');
	}
	const book = manifest.books.find((entry) => entry.key === bookKey);
	if (!book) throw new Error('The selected testcase no longer exists. Refresh Simulator.');

	const testcaseRoot = fs.realpathSync(path.join(fs.realpathSync(path.resolve(appDir)), 'testcases'));
	const candidate = path.join(testcaseRoot, manifest.fileName);
	const stat = fs.lstatSync(candidate);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The selected manifest is not a regular file.');
	const realManifest = fs.realpathSync(candidate);
	if (!isPathWithin(testcaseRoot, realManifest) || realManifest === testcaseRoot) {
		throw new Error('The selected manifest resolves outside the project testcase folder.');
	}
	const buffer = boundedFile(realManifest, 5 * 1024 * 1024, 'Testcase manifest');
	if (sourceToken(buffer) !== expectedToken) {
		throw new Error('The selected testcase manifest changed. Refresh Simulator and select the book again.');
	}
	let raw;
	try {
		raw = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
	} catch (error) {
		throw new Error(`The selected testcase manifest is no longer valid JSON: ${error.message}`);
	}
	const rawBook = raw?.books?.[book.sourceIndex];
	if (
		!rawBook ||
		String(rawBook.mode) !== book.mode ||
		Number(rawBook.bookId) !== book.bookId
	) {
		throw new Error('The selected testcase changed. Refresh Simulator and select it again.');
	}
	if (typeof raw.gameFolder !== 'string' || !raw.gameFolder.trim()) {
		throw new Error('This manifest does not name the published math folder containing its books.');
	}

	return {
		manifest,
		book,
		gameFolder: raw.gameFolder.trim(),
	};
}

/** Resolve the mode's compressed book file without trusting paths in index.json. */
function resolveMathEventsFile(gameFolder, mode) {
	if (!MODE_PATTERN.test(mode)) throw new Error(`Invalid testcase mode "${String(mode)}".`);
	if (!path.isAbsolute(gameFolder)) {
		throw new Error('The manifest gameFolder must be an absolute published-math directory.');
	}
	const mathRoot = fs.realpathSync(path.resolve(gameFolder));
	if (!fs.statSync(mathRoot).isDirectory()) throw new Error('The manifest gameFolder is not a directory.');
	const indexCandidate = path.join(mathRoot, 'index.json');
	if (fs.lstatSync(indexCandidate).isSymbolicLink()) {
		throw new Error('Published math index.json must not be a symlink.');
	}
	const indexPath = fs.realpathSync(indexCandidate);
	if (!isPathWithin(mathRoot, indexPath) || indexPath === mathRoot) {
		throw new Error('Published math index.json resolves outside gameFolder.');
	}
	const indexBuffer = boundedFile(indexPath, MAX_INDEX_BYTES, 'Published math index.json');
	let index;
	try {
		index = JSON.parse(indexBuffer.toString('utf8').replace(/^\uFEFF/, ''));
	} catch (error) {
		throw new Error(`Published math index.json is invalid: ${error.message}`);
	}
	const normalizedMode = mode.toLowerCase();
	const modeEntry = Array.isArray(index?.modes)
		? index.modes.find((entry) => String(entry?.name).toLowerCase() === normalizedMode)
		: null;
	if (!modeEntry || typeof modeEntry.events !== 'string' || !modeEntry.events.trim()) {
		throw new Error(`Published math does not contain mode "${mode}".`);
	}
	if (path.isAbsolute(modeEntry.events)) {
		throw new Error(`Mode "${mode}" uses an unsafe absolute events path.`);
	}
	const eventsCandidate = path.resolve(mathRoot, modeEntry.events);
	if (fs.lstatSync(eventsCandidate).isSymbolicLink()) {
		throw new Error(`Mode "${mode}" events must not be a symlink.`);
	}
	const eventsPath = fs.realpathSync(eventsCandidate);
	if (!isPathWithin(mathRoot, eventsPath) || eventsPath === mathRoot) {
		throw new Error(`Mode "${mode}" events resolve outside gameFolder.`);
	}
	const stat = fs.lstatSync(eventsPath);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Mode "${mode}" events are not a regular file.`);
	}
	if (!eventsPath.toLowerCase().endsWith('.jsonl.zst')) {
		throw new Error(`Mode "${mode}" events are not a .jsonl.zst book export.`);
	}
	return {
		mathRoot,
		eventsPath,
		mode: normalizedMode,
		fileSignature: `${stat.size}:${stat.mtimeMs}`,
	};
}

const touchCache = (key, entry) => {
	if (outcomeCache.has(key)) outcomeCache.delete(key);
	outcomeCache.set(key, entry);
};

const cacheOutcome = (key, outcome, bytes) => {
	if (bytes > MAX_CACHE_BYTES) return;
	while (outcomeCacheBytes + bytes > MAX_CACHE_BYTES && outcomeCache.size) {
		const oldestKey = outcomeCache.keys().next().value;
		const oldest = outcomeCache.get(oldestKey);
		outcomeCache.delete(oldestKey);
		outcomeCacheBytes -= oldest.bytes;
	}
	outcomeCache.set(key, { outcome, bytes });
	outcomeCacheBytes += bytes;
};

function extractTestBook({ eventsPath, bookId, cacheKey, timeoutMs = EXTRACT_TIMEOUT_MS }) {
	const cached = outcomeCache.get(cacheKey);
	if (cached) {
		touchCache(cacheKey, cached);
		return Promise.resolve(cached.outcome);
	}
	if (inFlightExtractions.has(cacheKey)) return inFlightExtractions.get(cacheKey);
	if (activeExtractors.size >= MAX_CONCURRENT_EXTRACTIONS) {
		return Promise.reject(new Error('Too many testcase books are already loading. Wait for one to finish.'));
	}
	const helper = testBookExtractorPath();
	const task = new Promise((resolve, reject) => {
		const child = spawn('node', [helper, eventsPath, String(bookId)], {
			windowsHide: true,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let terminationError = null;
		let timer = null;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			activeExtractors.delete(child);
			if (error) reject(error);
			else resolve(value);
		};
		const terminate = (reason) => {
			if (settled || terminationError) return;
			terminationError = reason instanceof Error ? reason : new Error(String(reason));
			try {
				if (!child.kill()) finish(terminationError);
			} catch {
				finish(terminationError);
			}
		};
		activeExtractors.set(child, terminate);
		timer = setTimeout(
			() => terminate(new Error(`Timed out loading book #${bookId} from the published math export.`)),
			timeoutMs,
		);
		child.stdout.on('data', (chunk) => {
			if (terminationError) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_EXTRACTED_BOOK_BYTES) {
				terminate(new Error(`Book #${bookId} exceeds the ${MAX_EXTRACTED_BOOK_BYTES}-byte limit.`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk) => {
			if (stderrBytes >= 32 * 1024) return;
			const remaining = 32 * 1024 - stderrBytes;
			const boundedChunk = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			stderr.push(boundedChunk);
			stderrBytes += boundedChunk.length;
		});
		child.on('error', (error) => {
			if (terminationError) {
				finish(terminationError);
				return;
			}
			const hint = error?.code === 'ENOENT'
				? 'Node.js was not found. Install Node 22.15+ or add it to PATH.'
				: String(error.message ?? error);
			finish(new Error(`Could not start the testcase book loader: ${hint}`));
		});
		child.on('close', (code) => {
			if (settled) return;
			if (terminationError) {
				finish(terminationError);
				return;
			}
			if (code !== 0) {
				const detail = Buffer.concat(stderr).toString('utf8').trim();
				finish(new Error(detail || `Book loader exited with code ${code}.`));
				return;
			}
			const output = Buffer.concat(stdout);
			let outcome;
			try {
				outcome = JSON.parse(output.toString('utf8'));
			} catch (error) {
				finish(new Error(`Book loader returned invalid JSON: ${error.message}`));
				return;
			}
			if (
				outcome?.bookId !== bookId ||
				!Number.isSafeInteger(outcome?.payoutMultiplier) ||
				outcome.payoutMultiplier < 0 ||
				outcome.payoutMultiplier > 100_000_000 ||
				!Array.isArray(outcome?.events) ||
				!outcome.events.length ||
				outcome.events.length > 20_000 ||
				outcome.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))
			) {
				finish(new Error(`Book loader returned an invalid outcome for #${bookId}.`));
				return;
			}
			cacheOutcome(cacheKey, outcome, output.length);
			finish(null, outcome);
		});
	});
	inFlightExtractions.set(cacheKey, task);
	void task.then(
		() => inFlightExtractions.delete(cacheKey),
		() => inFlightExtractions.delete(cacheKey),
	);
	return task;
}

function stopTestCaseExtractions(reason = 'The Layout Editor is closing.') {
	for (const terminate of [...activeExtractors.values()]) terminate(new Error(reason));
}

function localRgsEndpoint(rawUrl, route) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('The project mock-RGS URL is invalid.');
	}
	const host = url.hostname.toLowerCase();
	if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
		throw new Error('Forced testcase books are only available with a local mock RGS.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('The project mock-RGS URL is not supported for testcase execution.');
	}
	return new URL(route, `${url.protocol}//${url.host}`);
}

function requestJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const transport = url.protocol === 'https:' ? https : http;
		const request = transport.request(url, {
			method: 'GET',
			headers: {
				'x-stake-layout-editor': 'test-case-runner-v1',
			},
			timeout: timeoutMs,
		}, (response) => {
			const chunks = [];
			let bytes = 0;
			response.on('data', (chunk) => {
				bytes += chunk.length;
				if (bytes > MAX_RESPONSE_BYTES) {
					request.destroy(new Error('Mock RGS response was too large.'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				let result = {};
				try {
					const text = Buffer.concat(chunks).toString('utf8');
					result = text ? JSON.parse(text) : {};
				} catch {
					result = { error: `Mock RGS returned HTTP ${response.statusCode} with invalid JSON.` };
				}
				if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || result?.ok === false) {
					reject(new Error(result?.error || `Mock RGS returned HTTP ${response.statusCode}.`));
				} else resolve(result);
			});
		});
		request.on('timeout', () => request.destroy(new Error('Timed out contacting the mock RGS.')));
		request.on('error', reject);
		request.end();
	});
}

async function runTestCase(options) {
	const { appDir, manifestId, sourceToken: token, bookKey, rgsUrl, sessionID } = options ?? {};
	if (typeof sessionID !== 'string' || !sessionID || sessionID.length > 512) {
		throw new Error('The project session ID is invalid.');
	}
	const health = await requestJson(localRgsEndpoint(rgsUrl, '/health'));
	if (health?.capabilities?.forcedTestBooks !== true) {
		throw new Error('The running mock RGS does not support forced testcase books. Update and restart the project mock RGS.');
	}
	const selection = resolveTestCaseSelection({
		appDir,
		manifestId,
		sourceToken: token,
		bookKey,
	});
	const source = resolveMathEventsFile(selection.gameFolder, selection.book.mode);
	const cacheKey = `${source.eventsPath}\0${source.fileSignature}\0${selection.book.bookId}`;
	const outcome = await extractTestBook({
		eventsPath: source.eventsPath,
		bookId: selection.book.bookId,
		cacheKey,
	});
	if (
		Number.isFinite(selection.book.payoutMultiplierCents) &&
		selection.book.payoutMultiplierCents !== outcome.payoutMultiplier
	) {
		throw new Error(
			`Published book #${selection.book.bookId} does not match the payout recorded in the testcase manifest.`,
		);
	}
	return {
		ok: true,
		mode: source.mode,
		bookId: selection.book.bookId,
		criteria: selection.book.criteria,
		payoutX: selection.book.payoutX,
		outcome,
	};
}

module.exports = {
	EXTRACT_TIMEOUT_MS,
	MAX_EXTRACTED_BOOK_BYTES,
	extractTestBook,
	localRgsEndpoint,
	requestJson,
	resolveMathEventsFile,
	resolveTestCaseSelection,
	runTestCase,
	stopTestCaseExtractions,
	testBookExtractorPath,
};
