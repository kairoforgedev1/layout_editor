/**
 * Child process management for the game dev server and the mock RGS server.
 * Streams log lines to the renderer and tracks readiness by probing ports and
 * parsing dev-server output for the actual port Vite picked.
 */
const { spawn, execSync } = require('child_process');
const http = require('http');

const procs = new Map(); // kind -> { child, port, status, launch }

function probePort(port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: timeoutMs },
			(res) => {
				res.resume();
				resolve(true);
			},
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

function killTree(pid) {
	try {
		if (process.platform === 'win32') {
			execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGTERM');
		}
	} catch {
		// already gone
	}
}

function stopProc(kind) {
	const entry = procs.get(kind);
	if (entry?.child?.pid) killTree(entry.child.pid);
	procs.delete(kind);
}

function stopAll() {
	for (const kind of [...procs.keys()]) stopProc(kind);
}

/**
 * Start a managed process. Emits events through `send(event)` where event is
 * { kind, event: 'starting'|'ready'|'log'|'exit', port?, line?, code? }.
 */
async function startProc({ kind, command, args, cwd, expectedPort, send }) {
	stopProc(kind);
	send({ kind, event: 'starting' });

	const child = spawn(command, args, {
		cwd,
		shell: true,
		windowsHide: true,
		env: { ...process.env, FORCE_COLOR: '0' },
	});
	const entry = {
		child,
		port: expectedPort,
		status: 'starting',
		// Keep the exact launch recipe in the main process. The renderer is torn
		// down during Ctrl/Cmd+Shift+R, but managed services need to survive that
		// boundary well enough to be restarted with the same configuration.
		launch: { command, args: [...args], cwd, expectedPort, send },
	};
	procs.set(kind, entry);

	let buffered = '';
	const onChunk = (chunk) => {
		buffered += chunk.toString();
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			send({ kind, event: 'log', line: line.slice(0, 500) });
			// Vite prints the actual port it bound (it walks up when busy).
			const match = line.match(/localhost:(\d{2,5})\//);
			if (match && kind === 'dev') {
				const port = Number(match[1]);
				if (port !== entry.port) {
					entry.port = port;
					send({ kind, event: 'log', line: `[editor] dev server picked port ${port}` });
				}
			}
		}
	};
	child.stdout?.on('data', onChunk);
	child.stderr?.on('data', onChunk);
	child.on('exit', (code) => {
		if (procs.get(kind)?.child === child) {
			procs.delete(kind);
			send({ kind, event: 'exit', code });
		}
	});

	// poll until the port responds (up to ~90s: turbo may build packages first)
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (!procs.has(kind) || procs.get(kind)?.child !== child) return { ok: false, error: 'stopped' };
		if (await probePort(entry.port)) {
			entry.status = 'ready';
			send({ kind, event: 'ready', port: entry.port });
			return { ok: true, port: entry.port };
		}
		await new Promise((resolve) => setTimeout(resolve, 700));
	}
	send({ kind, event: 'log', line: `[editor] timed out waiting for ${kind} on port ${entry.port}` });
	return { ok: false, error: `timed out waiting for port ${entry.port}` };
}

/** Restart a process that was spawned by this editor. Attached/external
 * processes are intentionally absent from `procs` and are never touched. */
function restartProc(kind, send) {
	const launch = procs.get(kind)?.launch;
	if (!launch) return null;
	stopProc(kind);
	return (async () => {
		// taskkill/process.kill is synchronous from our point of view, but the old
		// listening socket can remain observable briefly. Do not let the readiness
		// probe mistake that old socket for the replacement process.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && (await probePort(launch.expectedPort, 250))) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return startProc({ ...launch, kind, send: send ?? launch.send });
	})();
}

module.exports = { startProc, restartProc, stopProc, stopAll, probePort };
