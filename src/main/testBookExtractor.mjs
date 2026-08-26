/**
 * Stream one exact book out of a published math JSONL/Zstandard file.
 *
 * This runs in the project's system Node process rather than Electron's embedded
 * Node: current math exports use Zstandard and `createZstdDecompress()` is not
 * available in every Electron-supported Node release. The parent process passes
 * an already-validated events path and a non-negative integer book id.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// The complete wallet request is capped at 5 MiB; reserve space for its envelope.
const MAX_BOOK_LINE_BYTES = 4 * 1024 * 1024;

const [eventsPath, rawBookId] = process.argv.slice(2);
const bookId = Number(rawBookId);

if (!eventsPath || !Number.isSafeInteger(bookId) || bookId < 0) {
	console.error('usage: testBookExtractor.mjs <books.jsonl.zst> <book-id>');
	process.exit(2);
}

if (typeof zlib.createZstdDecompress !== 'function') {
	console.error('This feature needs Node.js with Zstandard support (Node 22.15+ or 24+).');
	process.exit(4);
}

const source = fs.createReadStream(eventsPath);
const decompressor = zlib.createZstdDecompress();
const input = source.pipe(decompressor);

try {
	let lineIndex = -1;
	let lineChunks = [];
	let lineBytes = 0;
	let found = false;
	const appendLineBytes = (chunk) => {
		if (!chunk.length) return;
		lineBytes += chunk.length;
		if (lineBytes > MAX_BOOK_LINE_BYTES) {
			throw new Error(`A published book line exceeds the ${MAX_BOOK_LINE_BYTES}-byte limit.`);
		}
		lineChunks.push(chunk);
	};
	const consumeLine = () => {
		const bytes = lineChunks.length === 1
			? lineChunks[0]
			: Buffer.concat(lineChunks, lineBytes);
		lineChunks = [];
		lineBytes = 0;
		let meaningful = false;
		for (const byte of bytes) {
			if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
				meaningful = true;
				break;
			}
		}
		if (!meaningful) return false;

		lineIndex += 1;
		// Math Checker publish exports guarantee id === zero-based JSONL line
		// ordinal. Count without parsing preceding events arrays, then validate the
		// invariant on only the selected bounded line.
		if (lineIndex < bookId) return false;
		const book = JSON.parse(bytes.toString('utf8').replace(/\r$/, ''));
		if (
			book?.id !== bookId ||
			!Number.isSafeInteger(book?.payoutMultiplier) ||
			book.payoutMultiplier < 0 ||
			book.payoutMultiplier > 100_000_000 ||
			!Array.isArray(book?.events) ||
			book.events.length === 0 ||
			book.events.length > 20_000 ||
			book.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))
		) {
			throw new Error(`Book #${bookId} has an invalid outcome shape.`);
		}
		process.stdout.write(JSON.stringify({
			bookId: book.id,
			payoutMultiplier: book.payoutMultiplier,
			events: book.events,
		}));
		found = true;
		return true;
	};

	outer: for await (const chunk of input) {
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf(0x0a, start);
			if (newline < 0) break;
			appendLineBytes(chunk.subarray(start, newline));
			if (consumeLine()) break outer;
			start = newline + 1;
		}
		appendLineBytes(chunk.subarray(start));
	}
	if (!found && lineBytes > 0) found = consumeLine();

	if (!found) {
		console.error(`Book #${bookId} was not found.`);
		process.exitCode = 3;
	}
} catch (error) {
	console.error(String(error?.message ?? error));
	process.exitCode = 1;
} finally {
	input.destroy();
	decompressor.destroy();
	source.destroy();
}
