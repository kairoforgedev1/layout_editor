/** Clearing the current element selection, in one place. */
import { state, emit } from './state.js';
import { bridgeSend } from './bridge.js';

/**
 * Drop the selection everywhere at once: editor state, the inspector's cached
 * values, and the in-game highlight.
 *
 * The game half is the part that is easy to forget — skipping it leaves the
 * element still outlined in the preview with nothing selected in the editor, so
 * every caller goes through here rather than assigning the fields by hand.
 */
export function clearSelection() {
	state.selection = null;
	state.values = null;
	bridgeSend('select', { id: null });
	emit('selection');
}
