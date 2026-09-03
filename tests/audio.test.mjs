import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = (source) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

class FakeClassList {
	constructor(owner) {
		this.owner = owner;
	}

	#values() {
		return new Set(String(this.owner.className ?? '').split(/\s+/).filter(Boolean));
	}

	toggle(name, force) {
		const values = this.#values();
		const present = force === undefined ? !values.has(name) : !!force;
		if (present) values.add(name);
		else values.delete(name);
		this.owner.className = [...values].join(' ');
		return present;
	}

	contains(name) {
		return this.#values().has(name);
	}
}

class FakeButton {
	constructor(id) {
		this.id = id;
		this.className = '';
		this.classList = new FakeClassList(this);
		this.attributes = new Map();
		this.textContent = '';
		this.title = '';
		this.listeners = new Map();
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	addEventListener(type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type).add(handler);
	}

	click() {
		return [...(this.listeners.get('click') ?? [])].map((handler) => handler());
	}
}

const stateUrl = moduleUrl(`
	export const state = { muted: false };
	export const toasts = [];
	export const logs = [];
	export const toast = (...args) => toasts.push(args);
	export const log = (...args) => logs.push(args);
`);

const audioSource = (await readFile(
	new URL('../src/renderer/js/audio.js', import.meta.url),
	'utf8',
)).replace("'./state.js'", `'${stateUrl}'`);

const [{ state, toasts, logs }, audio] = await Promise.all([
	import(stateUrl),
	import(moduleUrl(audioSource)),
]);

/** Rebuild the button and host stub each test; the module reads them lazily. */
const setup = ({ hostMuted = false, host } = {}) => {
	const button = new FakeButton('btn-mute');
	globalThis.document = { getElementById: (id) => (id === 'btn-mute' ? button : null) };
	const calls = [];
	globalThis.window = {
		editorHost: host ?? {
			getAudioMuted: async () => ({ muted: hostMuted }),
			setAudioMuted: async (muted) => {
				calls.push(muted);
				return { ok: true, muted };
			},
		},
	};
	state.muted = false;
	toasts.length = 0;
	logs.length = 0;
	return { button, calls };
};

test('the button starts unmuted and adopts the window flag on init', async () => {
	const { button } = setup({ hostMuted: false });
	await audio.initAudio();

	assert.equal(state.muted, false);
	assert.equal(button.textContent, '\u{1F50A}');
	assert.equal(button.getAttribute('aria-pressed'), 'false');
	assert.equal(button.classList.contains('active'), false);
	assert.match(button.title, /^Mute the game preview/);
});

test('a window that is already muted is reflected without a round trip', async () => {
	const { button, calls } = setup({ hostMuted: true });
	await audio.initAudio();

	assert.equal(state.muted, true, 'a persisted mute survives an editor reload');
	assert.equal(button.textContent, '\u{1F507}');
	assert.equal(button.getAttribute('aria-pressed'), 'true');
	assert.equal(button.classList.contains('active'), true);
	assert.match(button.title, /^Unmute the game preview/);
	assert.deepEqual(calls, [], 'syncing must not write the flag back');
});

test('clicking toggles the host flag and repaints the button both ways', async () => {
	const { button, calls } = setup();
	await audio.initAudio();

	await Promise.all(button.click());
	assert.deepEqual(calls, [true]);
	assert.equal(state.muted, true);
	assert.equal(button.textContent, '\u{1F507}');
	assert.equal(button.classList.contains('active'), true);

	await Promise.all(button.click());
	assert.deepEqual(calls, [true, false]);
	assert.equal(state.muted, false);
	assert.equal(button.textContent, '\u{1F50A}');
	assert.equal(button.classList.contains('active'), false);
});

test('the host decides the final state, not the requested one', async () => {
	// A window that refuses to unmute must leave the button showing "muted".
	const { button } = setup({
		host: {
			getAudioMuted: async () => ({ muted: true }),
			setAudioMuted: async () => ({ ok: true, muted: true }),
		},
	});
	await audio.initAudio();
	assert.equal(state.muted, true);

	await audio.setMuted(false);
	assert.equal(state.muted, true, 'the reported flag wins over the request');
	assert.equal(button.textContent, '\u{1F507}');
	assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('a failed toggle reports the problem and never fakes a mute', async () => {
	const { button } = setup({
		host: {
			getAudioMuted: async () => ({ muted: false }),
			setAudioMuted: async () => {
				throw new Error('No handler registered for audio:setMuted');
			},
		},
	});
	await audio.initAudio();

	assert.equal(await audio.toggleMute(), false, 'the icon must not claim a mute');
	assert.equal(button.textContent, '\u{1F50A}');
	assert.equal(button.classList.contains('active'), false);
	assert.equal(toasts.length, 1, 'the failure is surfaced, not swallowed');
	assert.match(toasts[0][0], /fully quit and reopen/i);
	assert.match(logs.at(-1)[1], /mute failed/i);
});

test('a host with no muting at all is reported instead of failing silently', async () => {
	// An editor updated while running: the renderer reloaded, the main process did not.
	const { button } = setup({ host: { getAudioMuted: async () => ({ muted: false }) } });
	await audio.initAudio();

	assert.equal(await audio.toggleMute(), false);
	assert.equal(button.textContent, '\u{1F50A}');
	assert.equal(toasts.length, 1);
	assert.match(toasts[0][0], /fully quit and reopen/i);
});

test('an unreachable host syncs to unmuted rather than failing the boot', async () => {
	const { button } = setup({
		host: {
			getAudioMuted: async () => {
				throw new Error('no ipc');
			},
			setAudioMuted: async (muted) => ({ ok: true, muted }),
		},
	});
	state.muted = true;

	assert.equal(await audio.initAudio(), false);
	assert.equal(button.textContent, '\u{1F50A}');
	assert.equal(button.getAttribute('aria-pressed'), 'false');
});
