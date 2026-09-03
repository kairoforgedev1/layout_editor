/** Preview audio mute. The host mutes the window; only the game makes sound. */
import { state, toast, log } from './state.js';

const HOST_STALE =
	'Could not change the preview audio. If the editor was updated while running, ' +
	'fully quit and reopen it — a reload keeps the old main process.';

const $ = (id) => document.getElementById(id);

export function renderMuteButton() {
	const button = $('btn-mute');
	if (!button) return;
	button.textContent = state.muted ? '\u{1F507}' : '\u{1F50A}';
	button.classList.toggle('active', state.muted);
	button.setAttribute('aria-pressed', String(state.muted));
	button.title = state.muted
		? 'Unmute the game preview (Ctrl+M)'
		: 'Mute the game preview (Ctrl+M)';
}

/**
 * The main process owns the real flag, so adopt the value it reports back rather
 * than the one requested. A rejected or ignored toggle must not leave the button
 * claiming a state the window is not actually in.
 */
export async function setMuted(muted) {
	const next = !!muted;
	if (typeof window.editorHost?.setAudioMuted !== 'function') {
		log('editor', '[audio] this editor host exposes no audio muting');
		toast(HOST_STALE, 'error', 8000);
		renderMuteButton();
		return state.muted;
	}
	try {
		const result = await window.editorHost.setAudioMuted(next);
		state.muted = typeof result?.muted === 'boolean' ? result.muted : next;
	} catch (error) {
		// Never flip the icon on a failed call. Showing a mute that never happened
		// is precisely the "button does nothing" symptom, and it hides the cause.
		log('editor', `[audio] mute failed: ${String(error?.message ?? error)}`);
		toast(HOST_STALE, 'error', 8000);
	}
	renderMuteButton();
	return state.muted;
}

export const toggleMute = () => setMuted(!state.muted);

/** Adopt the window's own flag, which survives an editor reload and restarts. */
export async function syncMuteFromHost() {
	try {
		const result = await window.editorHost.getAudioMuted();
		state.muted = !!result?.muted;
	} catch {
		state.muted = false;
	}
	renderMuteButton();
	return state.muted;
}

export function initAudio() {
	$('btn-mute')?.addEventListener('click', () => toggleMute());
	renderMuteButton();
	return syncMuteFromHost();
}
