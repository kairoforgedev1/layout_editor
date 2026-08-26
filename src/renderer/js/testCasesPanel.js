/** Docked test-book browser and exact-round launcher. */
import { state, emit, on, toast, log } from './state.js';
import { bridgeRequest } from './bridge.js';
import { applyViewport } from './viewport.js';
import { setMode } from './toolbar.js';
import { ensureRgs } from './project.js';
import { setPerformanceMonitorOpen } from './performanceMonitor.js';
import {
	filterTestCaseBooks,
	findSelectedTestCaseBook,
	findTestCaseManifest,
	testCaseBookMeta,
	testCaseBookTitle,
	testCaseManifestId,
	testCaseManifestLabel,
} from './testCaseModel.js';

const host = window.editorHost;
const $ = (id) => document.getElementById(id);
let scanGeneration = 0;
let runGeneration = 0;

const bookCount = (manifests = state.testCases.manifests) =>
	manifests.reduce((total, manifest) => total + (manifest.books?.length ?? 0), 0);

const errorMessage = (error) => String(error?.message ?? error ?? 'Unknown error');

const renderManifestSelect = () => {
	const select = $('tc-manifest');
	const fragment = document.createDocumentFragment();
	for (const manifest of state.testCases.manifests) {
		const option = document.createElement('option');
		option.value = testCaseManifestId(manifest);
		option.textContent = testCaseManifestLabel(manifest);
		option.title = manifest.fileName ?? option.textContent;
		fragment.appendChild(option);
	}
	select.replaceChildren(fragment);
	select.disabled = state.testCases.scanStatus === 'loading' ||
		state.testCases.running ||
		!state.testCases.manifests.length;
	if (state.testCases.selectedManifestId) select.value = state.testCases.selectedManifestId;
};

const emptyListMessage = (manifest, filteredBooks) => {
	if (!state.project) return 'Open a project to find test-book manifests.';
	if (state.testCases.scanStatus === 'loading') return 'Scanning the testcases folder...';
	if (state.testCases.scanStatus === 'error') return state.testCases.scanError || 'Test-case scan failed.';
	if (!state.testCases.directoryPresent) return 'No testcases folder was found in this game app.';
	if (!state.testCases.manifests.length) return 'No valid test-book JSON manifests were found.';
	if (!manifest) return 'Choose a test-case file.';
	if (!filteredBooks.length && state.testCases.filter.trim()) return 'No books match this filter.';
	return 'This manifest contains no books.';
};

const selectBook = (bookKey) => {
	state.testCases.selectedBookKey = bookKey;
	state.testCases.lastResult = null;
	render();
	emit('testCasesSelection', bookKey);
};

const renderBookList = () => {
	const manifest = findTestCaseManifest(state.testCases);
	const books = filterTestCaseBooks(manifest, state.testCases.filter);
	const list = $('tc-list');
	const fragment = document.createDocumentFragment();

	for (const book of books) {
		const row = document.createElement('label');
		row.className = 'tc-row';
		if (book.key === state.testCases.selectedBookKey) row.classList.add('selected');
		row.title = testCaseBookMeta(book);

		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = 'test-case-book';
		radio.value = book.key;
		radio.checked = book.key === state.testCases.selectedBookKey;
		radio.disabled = state.testCases.running;
		radio.addEventListener('change', () => selectBook(book.key));

		const copy = document.createElement('span');
		copy.className = 'tc-row-copy';
		const title = document.createElement('span');
		title.className = 'tc-row-title';
		title.textContent = testCaseBookTitle(book);
		const meta = document.createElement('span');
		meta.className = 'tc-row-meta';
		meta.textContent = testCaseBookMeta(book);
		copy.append(title, meta);
		row.append(radio, copy);
		fragment.appendChild(row);
	}

	if (!books.length) {
		const empty = document.createElement('div');
		empty.className = 'tc-empty';
		empty.textContent = emptyListMessage(manifest, books);
		fragment.appendChild(empty);
	}
	list.replaceChildren(fragment);

	const total = manifest?.books?.length ?? 0;
	$('tc-list-count').textContent = state.testCases.filter.trim()
		? `${books.length} of ${total} books`
		: `${total} ${total === 1 ? 'book' : 'books'}`;
};

const scanStatusText = () => {
	if (!state.project) return 'Open a project to scan for test books.';
	if (state.testCases.scanStatus === 'loading') return 'Scanning testcases...';
	if (state.testCases.scanStatus === 'error') return 'Could not scan testcases.';
	if (!state.testCases.directoryPresent) return 'No testcases folder found.';
	const files = state.testCases.manifests.length;
	const books = bookCount();
	return `${files} ${files === 1 ? 'file' : 'files'} · ${books} ${books === 1 ? 'book' : 'books'}`;
};

const runStatus = (selectedBook) => {
	if (state.testCases.running) {
		const meta = testCaseBookMeta(selectedBook);
		return state.testCases.runPhase === 'starting'
			? { text: `Book prepared. Waiting for the game to start ${meta}…`, kind: 'loading' }
			: { text: `Loading and starting ${meta}…`, kind: 'loading' };
	}
	if (!state.project) return { text: 'Open a project first.', kind: '' };
	if (state.testCases.scanStatus === 'loading') return { text: 'Scanning for test books...', kind: '' };
	if (state.testCases.scanStatus === 'error') {
		return { text: state.testCases.scanError || 'Test-case scan failed.', kind: 'error' };
	}
	if (!state.testCases.directoryPresent) {
		return { text: 'Add a testcases folder with a test-book JSON manifest.', kind: '' };
	}
	if (!state.testCases.manifests.length) return { text: 'Add a test-book JSON manifest to the testcases folder.', kind: '' };
	if (!selectedBook) return { text: 'Select a book to start a forced round.', kind: '' };
	if (!state.preview.connected) return { text: 'Start Preview before running the selected book.', kind: '' };
	if (!state.testCases.runnerAvailable) {
		return { text: 'Update the project bridge to enable forced test books.', kind: '' };
	}
	if (state.testCases.lastResult) return state.testCases.lastResult;
	return { text: `${testCaseBookMeta(selectedBook)} is ready.`, kind: '' };
};

const render = () => {
	const testCases = state.testCases;
	const panel = $('testcases-panel');
	const button = $('btn-testcases');
	panel.classList.toggle('hidden', !testCases.open);
	button.classList.toggle('active', testCases.open);
	button.setAttribute('aria-expanded', String(testCases.open));
	$('tc-scan-status').textContent = scanStatusText();
	$('tc-filter').value = testCases.filter;
	$('tc-filter').disabled = testCases.running;
	$('btn-testcases-refresh').disabled = !state.project || testCases.scanStatus === 'loading' || testCases.running;
	renderManifestSelect();
	renderBookList();

	const warning = $('tc-file-warning');
	const errorCount = testCases.fileErrors.length;
	warning.classList.toggle('hidden', !errorCount);
	warning.textContent = errorCount ? `${errorCount} skipped` : '';
	warning.title = testCases.fileErrors.map(({ fileName, error }) => `${fileName}: ${error}`).join('\n');

	const selectedBook = findSelectedTestCaseBook(testCases);
	const startButton = $('btn-testcases-start');
	startButton.disabled = !(
		state.project &&
		selectedBook &&
		state.preview.connected &&
		testCases.runnerAvailable &&
		!testCases.running
	);
	startButton.classList.toggle('loading', testCases.running);
	startButton.setAttribute('aria-busy', String(testCases.running));
	$('tc-start-label').textContent = testCases.running ? 'Starting…' : 'Start Round';
	const status = runStatus(selectedBook);
	const statusNode = $('tc-run-status');
	statusNode.classList.toggle('loading', status.kind === 'loading');
	statusNode.classList.toggle('success', status.kind === 'success');
	statusNode.classList.toggle('error', status.kind === 'error');
	statusNode.textContent = status.text;
};

export async function scanProjectTestCases() {
	const project = state.project;
	if (!project) return false;
	const generation = ++scanGeneration;
	const previousManifestId = state.testCases.selectedManifestId;
	const previousBookKey = state.testCases.selectedBookKey;
	state.testCases.scanStatus = 'loading';
	state.testCases.scanError = null;
	state.testCases.fileErrors = [];
	emit('testCases');

	try {
		if (typeof host.scanTestCases !== 'function') {
			throw new Error('This editor build does not expose the test-case scanner.');
		}
		const result = await host.scanTestCases(project.appDir);
		if (generation !== scanGeneration || state.project !== project) return false;
		if (!result?.ok) throw new Error(result?.error || 'Test-case scan failed.');

		state.testCases.directory = result.directory ?? null;
		state.testCases.directoryPresent = !!result.directoryPresent;
		state.testCases.manifests = Array.isArray(result.manifests) ? result.manifests : [];
		state.testCases.fileErrors = Array.isArray(result.fileErrors) ? result.fileErrors : [];
		state.testCases.scanStatus = 'ready';

		const retainedManifest = state.testCases.manifests.find(
			(manifest) => testCaseManifestId(manifest) === previousManifestId,
		);
		const selectedManifest = retainedManifest ?? state.testCases.manifests[0] ?? null;
		state.testCases.selectedManifestId = testCaseManifestId(selectedManifest);
		state.testCases.selectedBookKey = selectedManifest?.books?.some(
			(book) => book.key === previousBookKey,
		) ? previousBookKey : null;
		state.testCases.lastResult = null;
		log(
			'editor',
			`[test cases] found ${bookCount()} book(s) in ${state.testCases.manifests.length} manifest(s)`,
		);
		emit('testCases');
		return true;
	} catch (error) {
		if (generation !== scanGeneration || state.project !== project) return false;
		state.testCases.scanStatus = 'error';
		state.testCases.scanError = errorMessage(error);
		state.testCases.directoryPresent = false;
		state.testCases.manifests = [];
		state.testCases.selectedManifestId = null;
		state.testCases.selectedBookKey = null;
		log('editor', `[test cases] scan failed: ${state.testCases.scanError}`);
		emit('testCases');
		return false;
	}
}

export async function startSelectedTestBook() {
	const project = state.project;
	const manifest = findTestCaseManifest(state.testCases);
	const book = findSelectedTestCaseBook(state.testCases, manifest);
	if (
		!project ||
		!manifest ||
		!book ||
		!state.preview.connected ||
		!state.testCases.runnerAvailable ||
		state.testCases.running
	) return false;

	const generation = ++runGeneration;
	state.testCases.running = true;
	state.testCases.runPhase = 'preparing';
	state.testCases.lastResult = null;
	render();
	setMode('preview');

	try {
		if (!(await ensureRgs())) {
			throw new Error('The local mock RGS is not available.');
		}
		if (generation !== runGeneration || state.project !== project) return false;
		if (typeof host.runTestCase !== 'function') {
			throw new Error('This editor build does not expose test-book forcing.');
		}
		const prepared = await host.runTestCase({
			appDir: project.appDir,
			manifestId: testCaseManifestId(manifest),
			sourceToken: manifest.sourceToken,
			bookKey: book.key,
			sourceIndex: book.sourceIndex ?? book.index,
			rgsUrl: project.env.rgsUrl,
			sessionID: project.env.sessionID,
		});
		if (!prepared?.ok) throw new Error(prepared?.error || 'The mock RGS could not prepare this book.');
		if (generation !== runGeneration || state.project !== project) return false;
		state.testCases.runPhase = 'starting';
		render();

		const started = await bridgeRequest('startTestBook', {
			mode: prepared.mode ?? book.mode,
			bookId: prepared.bookId ?? book.bookId,
			outcome: prepared.outcome,
		}, 15000);
		if (!started?.ok) throw new Error(started?.error || 'The game did not start the selected round.');
		if (generation !== runGeneration || state.project !== project) return false;

		const meta = testCaseBookMeta(book);
		state.testCases.lastResult = { text: `Started ${meta}.`, kind: 'success' };
		state.gameState = `test book ${book.mode}:${book.bookId}`;
		log('editor', `[test cases] started ${book.mode}:${book.bookId}`);
		emit('preview');
		return true;
	} catch (error) {
		if (generation !== runGeneration || state.project !== project) return false;
		const message = errorMessage(error);
		state.testCases.lastResult = { text: `Could not start round: ${message}`, kind: 'error' };
		log('editor', `[test cases] start failed: ${message}`);
		toast(`Could not start test book: ${message}`, 'error', 7000);
		return false;
	} finally {
		if (generation === runGeneration && state.project === project) {
			state.testCases.running = false;
			state.testCases.runPhase = null;
			render();
		}
	}
}

export function setTestCasesPanelOpen(open, { restoreFocus = true } = {}) {
	const next = !!open;
	if (next) setPerformanceMonitorOpen(false, { restoreFocus: false });
	if (state.testCases.open === next) return;
	state.testCases.open = next;
	render();
	emit('testCasesOpen', next);
	requestAnimationFrame(() => {
		if (state.zoom.fit) applyViewport();
		if (!next && restoreFocus) $('btn-testcases').focus();
	});
}

export const toggleTestCasesPanel = () => setTestCasesPanelOpen(!state.testCases.open);

export function initTestCasesPanel() {
	$('btn-testcases').addEventListener('click', toggleTestCasesPanel);
	$('btn-testcases-close').addEventListener('click', () => setTestCasesPanelOpen(false));
	$('btn-testcases-refresh').addEventListener('click', () => void scanProjectTestCases());
	$('btn-testcases-start').addEventListener('click', () => void startSelectedTestBook());
	$('tc-manifest').addEventListener('change', (event) => {
		state.testCases.selectedManifestId = event.currentTarget.value || null;
		state.testCases.selectedBookKey = null;
		state.testCases.lastResult = null;
		render();
	});
	$('tc-filter').addEventListener('input', (event) => {
		state.testCases.filter = event.currentTarget.value;
		renderBookList();
	});
	$('tc-filter').addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !$('btn-testcases-start').disabled) {
			event.preventDefault();
			void startSelectedTestBook();
		}
	});

	on('testCases', render);
	on('preview', render);
	on('project', () => {
		scanGeneration += 1;
		runGeneration += 1;
		render();
		if (state.project) void scanProjectTestCases();
	});
	on('performanceOpen', (open) => {
		if (open && state.testCases.open) {
			setTestCasesPanelOpen(false, { restoreFocus: false });
		}
	});
	window.addEventListener('resize', () => state.testCases.open && render());
	render();
}
