/** One-shot, bounded injection of an exact test outcome into /wallet/play. */

export type TestBookOutcome = {
	bookId: number;
	payoutMultiplier: number;
	events: unknown[];
};

export type TestBookRequest = {
	mode: string;
	bookId: number;
	outcome: TestBookOutcome;
	encoded: string;
};

export type TestBookFetchTarget = {
	fetch: typeof fetch;
	location?: { href?: string };
};

export const TEST_BOOK_TIMEOUT_MS = 10_000;
// The complete wallet request is capped at 5 MiB; reserve space for its envelope.
export const TEST_BOOK_MAX_BYTES = 4 * 1024 * 1024;

export function validateTestBookRequest(payload: any): TestBookRequest {
	const mode = typeof payload?.mode === 'string' ? payload.mode.trim().toLowerCase() : '';
	const bookId = Number(payload?.bookId);
	const outcome = payload?.outcome;
	if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(mode)) throw new Error('Invalid testcase mode.');
	if (!Number.isSafeInteger(bookId) || bookId < 0) throw new Error('Invalid testcase book id.');
	if (
		!outcome ||
		Number(outcome.bookId) !== bookId ||
		!Number.isSafeInteger(outcome.payoutMultiplier) ||
		outcome.payoutMultiplier < 0 ||
		outcome.payoutMultiplier > 100_000_000 ||
		!Array.isArray(outcome.events) ||
		outcome.events.length === 0 ||
		outcome.events.length > 20_000 ||
		outcome.events.some((event: unknown) => !event || typeof event !== 'object' || Array.isArray(event))
	) throw new Error('Invalid testcase outcome.');
	const encoded = JSON.stringify({
		mode,
		bookId,
		payoutMultiplier: outcome.payoutMultiplier,
		events: outcome.events,
	});
	if (new TextEncoder().encode(encoded).byteLength > TEST_BOOK_MAX_BYTES) {
		throw new Error('The selected testcase book is too large to run in the preview.');
	}
	return { mode, bookId, outcome, encoded };
}

export function armTestBookRequest(
	testBook: TestBookRequest,
	options: {
		target?: TestBookFetchTarget;
		timeoutMs?: number;
		onRestore?: () => void;
	} = {},
) {
	const target = options.target ?? window;
	const previousFetch = target.fetch;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveConsumed: (() => void) | undefined;
	let rejectConsumed: ((error: Error) => void) | undefined;
	const consumed = new Promise<void>((resolve, reject) => {
		resolveConsumed = resolve;
		rejectConsumed = reject;
	});
	// The game hook can fail before its caller awaits `consumed`. Attach a noop
	// observer now so cancelling the arm never surfaces as an unhandled rejection.
	void consumed.catch(() => undefined);
	const restore = () => {
		if (target.fetch === wrappedFetch) target.fetch = previousFetch;
		if (timer) clearTimeout(timer);
		options.onRestore?.();
	};
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		restore();
		if (error) rejectConsumed?.(error);
		else resolveConsumed?.();
	};
	const cancel = (reason = 'Testcase start was cancelled.') => finish(new Error(reason));
	const wrappedFetch: typeof fetch = async (input, init) => {
		let requestUrl = '';
		let matchedPlayRequest = false;
		try {
			requestUrl = String(input instanceof Request ? input.url : input);
			const parsedUrl = new URL(requestUrl, target.location?.href ?? 'http://localhost/');
			const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
			if (method !== 'POST' || !/\/wallet\/play\/?$/.test(parsedUrl.pathname)) {
				return previousFetch.call(target, input, init);
			}
			matchedPlayRequest = true;

			let rawBody: string | null = null;
			if (typeof init?.body === 'string') rawBody = init.body;
			else if (input instanceof Request) rawBody = await input.clone().text();
			if (!rawBody) throw new Error('The matching bet request has no readable JSON body.');
			const body = JSON.parse(rawBody);
			if (String(body?.mode ?? '').toLowerCase() !== testBook.mode) {
				throw new Error(
					`The game requested mode "${String(body?.mode ?? '')}" instead of "${testBook.mode}".`,
				);
			}
			body.__layoutEditorTestBook = JSON.parse(testBook.encoded);
			const patchedBody = JSON.stringify(body);
			let patchedInput: RequestInfo | URL = input;
			let patchedInit: RequestInit | undefined = init;
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			headers.set('x-stake-layout-editor', 'test-case-runner-v1');
			if (input instanceof Request) {
				patchedInput = new Request(input, { ...init, headers, body: patchedBody });
				patchedInit = undefined;
			} else {
				patchedInit = { ...init, headers, body: patchedBody };
			}
			const response = await previousFetch.call(target, patchedInput, patchedInit);
			if (!response.ok) {
				throw new Error(`Mock RGS rejected the forced testcase request (HTTP ${response.status}).`);
			}
			finish();
			return response;
		} catch (error) {
			const failure = new Error(
				`Could not inject testcase book into ${requestUrl || 'the bet request'}: ${error}`,
			);
			finish(failure);
			if (matchedPlayRequest) throw failure;
			return previousFetch.call(target, input, init);
		}
	};
	target.fetch = wrappedFetch;
	timer = setTimeout(
		() => cancel('The game did not send a matching bet request in time.'),
		options.timeoutMs ?? TEST_BOOK_TIMEOUT_MS,
	);
	return { consumed, cancel };
}
