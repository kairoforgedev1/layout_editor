/**
 * Answer one question: is the dev server on this port serving the project the
 * editor has open?
 *
 * Game apps hardcode the same `--port` in their dev script, so a leftover server
 * from another project happily accepts the connection. Attaching to it silently
 * is worse than not attaching at all: the preview renders a different game while
 * the editor saves layout into the opened one.
 *
 * The check compares bytes. SvelteKit/Vite serve `<appDir>/static/x/y` verbatim
 * at `/x/y`, so a handful of static files fetched from the server and read from
 * disk must agree. Sprite atlas manifests are preferred because they are small
 * and are exactly what differs between two games.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Manifests are small, so a broad sweep of them stays fast on localhost.
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_PROBES = 64;
const WALK_DEPTH = 6;
const REQUEST_TIMEOUT_MS = 4000;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const toPosix = (value) => value.split(path.sep).join('/');

/** Walk for regular files only; a symlinked tree is not evidence of identity. */
function walkStatic(dir, depth, out) {
	if (depth > WALK_DEPTH || out.length > 5000) return out;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkStatic(full, depth + 1, out);
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/**
 * Rank candidates by how much they distinguish one game from another. Two games
 * often share fonts and boilerplate, so a match on those proves little; the asset
 * manifests are the files that actually diverge.
 */
const probeRank = (rel) => {
	const lower = rel.toLowerCase();
	if (lower.startsWith('assets/') && lower.endsWith('.json')) return 0;
	if (lower.startsWith('assets/')) return 1;
	return 2;
};

/**
 * Sample evenly across the list instead of taking the first `max`.
 *
 * One game forked from another shares its early files verbatim — the copies here
 * differ in exactly one atlas, and it sorts fourth. Truncating alphabetically
 * compares only identical files and reports a confident false match, which is
 * worse than not checking at all.
 */
function spread(items, max) {
	if (items.length <= max) return items;
	const picked = [];
	const seen = new Set();
	for (let i = 0; i < max; i += 1) {
		const index = Math.round((i * (items.length - 1)) / (max - 1));
		if (seen.has(index)) continue;
		seen.add(index);
		picked.push(items[index]);
	}
	return picked;
}

/** Deterministic, bounded set of static files to compare, best discriminator first. */
function collectProbeFiles(appDir, { max = MAX_PROBES } = {}) {
	const staticRoot = path.join(appDir, 'static');
	let stat;
	try {
		stat = fs.statSync(staticRoot);
	} catch {
		return [];
	}
	if (!stat.isDirectory()) return [];

	const candidates = [];
	for (const full of walkStatic(staticRoot, 0, [])) {
		let fileStat;
		try {
			fileStat = fs.statSync(full);
		} catch {
			continue;
		}
		if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > MAX_PROBE_BYTES) continue;
		const rel = toPosix(path.relative(staticRoot, full));
		if (!rel || rel.startsWith('..')) continue;
		candidates.push({ rel, full, size: fileStat.size, rank: probeRank(rel) });
	}
	candidates.sort((a, b) => a.rank - b.rank || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	// Keep the manifest tier whole when it fits; only sample once it overflows.
	const manifests = candidates.filter((entry) => entry.rank === 0);
	if (manifests.length >= max) return spread(manifests, max);
	const rest = candidates.filter((entry) => entry.rank !== 0);
	return [...manifests, ...spread(rest, max - manifests.length)];
}

function requestBytes(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		const request = http.request(
			url,
			{ method: 'GET', timeout: timeoutMs },
			(response) => {
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					response.resume();
					resolve({ ok: false, status });
					return;
				}
				const chunks = [];
				let bytes = 0;
				response.on('data', (chunk) => {
					bytes += chunk.length;
					if (bytes > MAX_PROBE_BYTES) {
						request.destroy();
						resolve({ ok: false, status, tooLarge: true });
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => resolve({ ok: true, status, body: Buffer.concat(chunks) }));
				response.on('error', () => resolve({ ok: false, status }));
			},
		);
		request.on('timeout', () => {
			request.destroy();
			resolve({ ok: false, timedOut: true });
		});
		request.on('error', (error) => resolve({ ok: false, error: String(error.message ?? error) }));
		request.end();
	});
}

/**
 * Compare served bytes with disk.
 *
 * `verified: false` means the question could not be answered (no static files to
 * compare, server unreachable). Callers must treat that as "unknown", never as a
 * match — but it is also not proof of a mismatch, so it should not hard-block.
 */
async function verifyDevServer({ appDir, port, fetchBytes = requestBytes } = {}) {
	if (typeof appDir !== 'string' || !appDir.trim()) {
		return { ok: false, verified: false, error: 'appDir must be a non-empty string' };
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, verified: false, error: 'port must be a valid TCP port' };
	}
	const probes = collectProbeFiles(appDir);
	if (!probes.length) {
		return { ok: true, verified: false, reason: 'this project has no static files to compare' };
	}

	let compared = 0;
	for (const probe of probes) {
		let expected;
		try {
			expected = fs.readFileSync(probe.full);
		} catch {
			continue;
		}
		const served = await fetchBytes(`http://127.0.0.1:${port}/${probe.rel}`);
		if (served?.timedOut || served?.error) {
			return {
				ok: true,
				verified: false,
				reason: `the server on port ${port} did not answer`,
			};
		}
		if (!served?.ok) {
			return {
				ok: true,
				verified: true,
				matches: false,
				probe: probe.rel,
				reason: `the server on port ${port} does not serve ${probe.rel} (HTTP ${served?.status ?? '?'})`,
			};
		}
		if (sha256(served.body) !== sha256(expected)) {
			return {
				ok: true,
				verified: true,
				matches: false,
				probe: probe.rel,
				reason: `the server on port ${port} serves a different ${probe.rel}`,
			};
		}
		compared += 1;
	}

	if (!compared) {
		return { ok: true, verified: false, reason: 'no static file could be read for comparison' };
	}
	return { ok: true, verified: true, matches: true, compared };
}

module.exports = {
	MAX_PROBES,
	MAX_PROBE_BYTES,
	collectProbeFiles,
	verifyDevServer,
};
