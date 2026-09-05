/** Editor bootstrap: wires panels, bridge, keyboard and startup flow. */
import { state, emit, toast, log } from './state.js';
import { initBridge, setCommitHandler, setHotkeyHandler, bridgeSend, bridgeRequest } from './bridge.js';
import {
	handleBridgeCommit,
	undo,
	redo,
	setProp,
	activeScopeProfile,
	addSpawnedElement,
	updateSpawnedDef,
	renameSpawnedElement,
	duplicateSpawnedElement,
	deleteSpawnedElement,
} from './overrides.js';
import { initViewport, setResolution } from './viewport.js';
import { initHierarchy } from './hierarchy.js';
import { initInspector } from './inspector.js';
import { initToolbar, setMode, doSave } from './toolbar.js';
import { initStatusbar } from './statusbar.js';
import { initPerformanceMonitor } from './performanceMonitor.js';
import { initAudio, toggleMute } from './audio.js';
import { initPanels } from './panels.js';
import { clearSelection } from './selection.js';
import { initTestCasesPanel } from './testCasesPanel.js';
import {
	initProcEvents,
	reloadLastProject,
	openProject,
	startPreview,
	restartPreview,
	hardReloadGame,
} from './project.js';
import { showRemoveDialog } from './removal.js';
import { unsavedCount } from './overrides.js';
import { confirmDialog } from './dialogs.js';

/**
 * Ctrl+Shift+R throws away the editor's in-memory state, so make unsaved layout
 * work an explicit decision rather than a silent loss.
 */
async function reloadEditorWindow() {
	const unsaved = unsavedCount();
	if (unsaved) {
		const ok = await confirmDialog(
			'Reload editor',
			`You have ${unsaved} unsaved layout change(s). Reloading the editor discards them. Continue?`,
		);
		if (!ok) return;
	}
	await window.editorHost.reloadEditor();
}

function initKeyboard() {
	window.addEventListener('keydown', (event) => {
		const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
		const ctrl = event.ctrlKey || event.metaKey;

		if (ctrl && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			event.shiftKey ? redo() : undo();
			return;
		}
		if (ctrl && event.key.toLowerCase() === 'y') {
			event.preventDefault();
			redo();
			return;
		}
		if (ctrl && event.key.toLowerCase() === 's') {
			event.preventDefault();
			doSave();
			return;
		}
		// Ctrl+R reloads the game, Ctrl+Shift+R reloads the editor itself.
		// Also handled in the main process so these work from inside the game iframe.
		if (ctrl && event.key.toLowerCase() === 'r') {
			event.preventDefault();
			event.shiftKey ? reloadEditorWindow() : hardReloadGame();
			return;
		}
		if (inInput) return;

		if (event.key === 'Escape') {
			clearSelection();
			return;
		}
		if (event.key === 'Delete' && state.selection) {
			event.preventDefault();
			showRemoveDialog(
				state.selection,
				state.values?.id === state.selection ? state.values : null,
			);
			return;
		}
		// arrow nudges for the selected element
		const arrows = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		if (arrows[event.key] && state.selection && state.values) {
			event.preventDefault();
			const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
			const [dx, dy] = arrows[event.key];
			const eff = state.values.effective;
			const profile = activeScopeProfile();
			if (dx) setProp(profile, state.selection, 'x', Math.round((eff.x + dx * step) * 100) / 100);
			if (dy) setProp(profile, state.selection, 'y', Math.round((eff.y + dy * step) * 100) / 100);
		}
	});
}

async function boot() {
	initProcEvents();
	initBridge(document.getElementById('game-frame'));
	setCommitHandler(handleBridgeCommit);
	setHotkeyHandler(({ key, shift }) => {
		if (key === 'z') (shift ? redo() : undo());
		else if (key === 'y') redo();
		else if (key === 's') doSave();
		else if (key === 'delete' && state.selection) {
			showRemoveDialog(
				state.selection,
				state.values?.id === state.selection ? state.values : null,
			);
		}
	});

	// Reload accelerators arrive from the main process (they fire even when the
	// game iframe has focus).
	window.editorHost.onEditorHotkey(({ action }) => {
		if (action === 'reloadEditor') reloadEditorWindow();
		else if (action === 'reloadGame') hardReloadGame();
		else if (action === 'toggleMute') toggleMute();
	});

	initViewport();
	initToolbar();
	initHierarchy();
	initInspector();
	initStatusbar();
	initPerformanceMonitor();
	initTestCasesPanel();
	initAudio();
	initPanels();
	initKeyboard();

	setResolution(1280, 720, 10);
	setMode('preview');

	// Console / automation handle (also handy for power users via devtools).
	window.sle = {
		state,
		openProject,
		startPreview,
		restartPreview,
		hardReloadGame,
		reloadEditorWindow,
		setResolution,
		setMode,
		toggleMute,
		doSave,
		bridgeSend,
		bridgeRequest,
		undo,
		redo,
		setProp,
		addSpawnedElement,
		updateSpawnedDef,
		renameSpawnedElement,
		duplicateSpawnedElement,
		deleteSpawnedElement,
	};
	import('./addElement.js').then((mod) => {
		window.sle.recheckAssets = mod.recheckAssets;
		window.sle.fetchAssets = mod.fetchAssets;
	});
	import('./overrides.js').then((mod) => {
		window.sle.removeElement = mod.removeElement;
		window.sle.restoreElement = mod.restoreElement;
		window.sle.removedIn = mod.removedIn;
		window.sle.getEntry = mod.getEntry;
	});
	import('./responsive.js').then((mod) => {
		window.sle.responsive = mod;
	});
	window.sle.showRemoveDialog = showRemoveDialog;

	log('editor', '[editor] ready');
	const opened = await reloadLastProject();
	if (!opened) toast('Open a Stake Engine game project to begin.', 'info', 5000);
}

boot();
