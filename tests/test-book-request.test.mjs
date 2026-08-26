import assert from 'node:assert/strict';
import test from 'node:test';

import {
	armTestBookRequest,
	validateTestBookRequest,
} from '../resources/bridge/testBookRequest.ts';

const book = () => validateTestBookRequest({
	mode: 'BASE',
	bookId: 4,
	outcome: {
		bookId: 4,
		payoutMultiplier: 4000,
		events: [{ index: 0, type: 'reveal' }, { index: 1, type: 'finalWin', amount: 4000 }],
	},
});

const fetchTarget = (response = new Response('{}', { status: 200 })) => {
	const calls = [];
	const original = async (input, init) => {
		calls.push({ input, init });
		return response;
	};
	return {
		target: { fetch: original, location: { href: 'http://localhost:3001/' } },
		original,
		calls,
	};
};

test('one matching play request receives the exact outcome and restores fetch', async () => {
	const { target, original, calls } = fetchTarget();
	const armed = armTestBookRequest(book(), { target, timeoutMs: 1_000 });
	const response = await target.fetch('http://localhost:3002/wallet/play', {
		method: 'POST',
		headers: { 'content-type': 'application/json', existing: 'kept' },
		body: JSON.stringify({ sessionID: 's', amount: 100, mode: 'BASE' }),
	});
	await armed.consumed;

	assert.equal(response.status, 200);
	assert.equal(target.fetch, original);
	assert.equal(calls.length, 1);
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.sessionID, 's');
	assert.deepEqual(sent.__layoutEditorTestBook, {
		mode: 'base',
		bookId: 4,
		payoutMultiplier: 4000,
		events: [{ index: 0, type: 'reveal' }, { index: 1, type: 'finalWin', amount: 4000 }],
	});
	const headers = new Headers(calls[0].init.headers);
	assert.equal(headers.get('existing'), 'kept');
	assert.equal(headers.get('x-stake-layout-editor'), 'test-case-runner-v1');
});

test('non-play traffic passes through while a mismatched play is blocked', async () => {
	const { target, original, calls } = fetchTarget();
	const armed = armTestBookRequest(book(), { target, timeoutMs: 1_000 });
	await target.fetch('http://localhost:3002/wallet/balance', { method: 'POST', body: '{}' });
	assert.equal(calls.length, 1);
	assert.equal(target.fetch === original, false, 'non-play traffic does not consume the arm');

	await assert.rejects(
		() => target.fetch('http://localhost:3002/wallet/play', {
			method: 'POST',
			body: JSON.stringify({ amount: 100, mode: 'BONUS' }),
		}),
		/instead of "base"/i,
	);
	await assert.rejects(armed.consumed, /instead of "base"/i);
	assert.equal(calls.length, 1, 'a mismatched play is never forwarded as a random round');
	assert.equal(target.fetch, original);
});

test('malformed matching bodies and RGS rejection fail without a random fallback', async () => {
	{
		const { target, calls } = fetchTarget();
		const armed = armTestBookRequest(book(), { target, timeoutMs: 1_000 });
		await assert.rejects(
			() => target.fetch('http://localhost:3002/wallet/play', { method: 'POST', body: '{bad' }),
			/Could not inject testcase book/i,
		);
		await assert.rejects(armed.consumed);
		assert.equal(calls.length, 0);
	}
	{
		const { target, calls } = fetchTarget(new Response('{}', { status: 400 }));
		const armed = armTestBookRequest(book(), { target, timeoutMs: 1_000 });
		await assert.rejects(
			() => target.fetch('http://localhost:3002/wallet/play', {
				method: 'POST',
				body: JSON.stringify({ amount: 100, mode: 'BASE' }),
			}),
			/HTTP 400/i,
		);
		await assert.rejects(armed.consumed, /HTTP 400/i);
		assert.equal(calls.length, 1, 'the rejected forced request is sent exactly once');
	}
});

test('validation rejects mismatched or empty outcomes before fetch is patched', () => {
	assert.throws(() => validateTestBookRequest({
		mode: 'base',
		bookId: 2,
		outcome: { bookId: 3, payoutMultiplier: 0, events: [{}] },
	}), /invalid testcase outcome/i);
	assert.throws(() => validateTestBookRequest({
		mode: 'base',
		bookId: 2,
		outcome: { bookId: 2, payoutMultiplier: 0, events: [] },
	}), /invalid testcase outcome/i);
});
