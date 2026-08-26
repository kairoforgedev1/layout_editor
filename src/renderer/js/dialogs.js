/** Modal + dropdown-menu helpers, change summary dialog. */
import { state } from './state.js';
import { diffOverrides } from './overrides.js';

const menuRoot = () => document.getElementById('menu-root');
const modalRoot = () => document.getElementById('modal-root');

let openMenu = null;

export function closeMenu() {
	openMenu?.remove();
	openMenu = null;
}

/**
 * Show a dropdown menu under `anchorEl`. Items:
 *  { label, onClick, danger? } | { sep: true } | { header } | { custom: HTMLElement }
 */
export function showMenu(anchorEl, items) {
	if (openMenu) {
		closeMenu();
	}
	const menu = document.createElement('div');
	menu.className = 'menu';
	for (const item of items) {
		if (item.sep) {
			const sep = document.createElement('div');
			sep.className = 'sep';
			menu.appendChild(sep);
		} else if (item.header) {
			const header = document.createElement('div');
			header.className = 'mlabel';
			header.textContent = item.header;
			menu.appendChild(header);
		} else if (item.custom) {
			menu.appendChild(item.custom);
		} else {
			const btn = document.createElement('button');
			btn.className = 'mi' + (item.danger ? ' danger' : '');
			btn.textContent = item.label;
			if (item.title) btn.title = item.title;
			if (item.disabled) btn.disabled = true;
			btn.addEventListener('click', () => {
				closeMenu();
				item.onClick?.();
			});
			menu.appendChild(btn);
		}
	}
	menuRoot().appendChild(menu);
	const rect = anchorEl.getBoundingClientRect();
	menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
	menu.style.top = `${rect.bottom + 4}px`;
	openMenu = menu;
	setTimeout(() => {
		const close = (event) => {
			if (!menu.contains(event.target)) {
				closeMenu();
				window.removeEventListener('mousedown', close, true);
			}
		};
		window.addEventListener('mousedown', close, true);
	});
	return menu;
}

export function showModal({ title, body, buttons }) {
	return new Promise((resolve) => {
		const backdrop = document.createElement('div');
		backdrop.className = 'modal-backdrop';
		const modal = document.createElement('div');
		modal.className = 'modal';
		const h = document.createElement('h3');
		h.textContent = title;
		modal.appendChild(h);
		const bodyEl = document.createElement('div');
		bodyEl.className = 'modal-body';
		if (typeof body === 'string') {
			bodyEl.textContent = body;
			bodyEl.style.whiteSpace = 'pre-wrap';
		} else {
			bodyEl.appendChild(body);
		}
		modal.appendChild(bodyEl);
		const foot = document.createElement('div');
		foot.className = 'modal-foot';
		for (const button of buttons) {
			const btn = document.createElement('button');
			btn.textContent = button.label;
			if (button.primary) btn.className = 'primary';
			btn.addEventListener('click', () => {
				backdrop.remove();
				resolve(button.value);
			});
			foot.appendChild(btn);
		}
		modal.appendChild(foot);
		backdrop.appendChild(modal);
		backdrop.addEventListener('mousedown', (event) => {
			if (event.target === backdrop) {
				backdrop.remove();
				resolve(null);
			}
		});
		modalRoot().appendChild(backdrop);
	});
}

export const confirmDialog = (title, message) =>
	showModal({
		title,
		body: message,
		buttons: [
			{ label: 'Cancel', value: false },
			{ label: 'Continue', value: true, primary: true },
		],
	}).then((v) => !!v);

const formatValue = (value) =>
	value === undefined ? '—' : typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);

/** Change summary before saving. Resolves true when the user confirms. */
export async function showSaveSummary() {
	const rows = diffOverrides(state.overrides.saved, state.overrides.working);
	if (!rows.length) {
		return showModal({
			title: 'Save layout changes',
			body: 'No unsaved changes.',
			buttons: [{ label: 'OK', value: false, primary: true }],
		}).then(() => false);
	}
	const table = document.createElement('table');
	table.className = 'diff-table';
	table.innerHTML = '<tr><th>Profile</th><th>Element</th><th>Change</th></tr>';
	for (const row of rows) {
		const tr = document.createElement('tr');
		const change =
			row.kind === 'added'
				? `<span class="diff-add">new override</span>`
				: row.kind === 'removed'
					? `<span class="diff-del">override removed</span>`
					: '';
		const props = row.props
			.map((p) => {
				if (p.key === 'removed') {
					const label = p.to === true ? 'element removed' : p.to === false ? 'element restored (this profile)' : 'element restored';
					return `<span class="diff-del">${label}</span>`;
				}
				if (p.key === 'responsive') {
					const label = !p.to ? 'responsive off' : !p.from ? 'made responsive' : 'responsive updated';
					return `<span class="diff-chg">${label}</span>`;
				}
				return `<span class="diff-chg">${p.key}</span>: ${formatValue(p.from)} → ${formatValue(p.to)}`;
			})
			.join(', ');
		tr.innerHTML = `<td>${row.profile}</td><td></td><td>${change}${change && props ? ' · ' : ''}${props}</td>`;
		tr.children[1].textContent = row.id;
		table.appendChild(tr);
	}
	const wrap = document.createElement('div');
	const intro = document.createElement('p');
	intro.style.marginTop = '0';
	intro.textContent = `${rows.length} element layout(s) will be written to ${state.project?.overridesPath ?? ''}:`;
	wrap.appendChild(intro);
	const unstableIds = [...new Set(rows
		.filter((row) => row.profile !== 'element')
		.map((row) => row.id)
		.filter((id) => state.tree.find((node) => node.id === id)?.identityStable === false))];
	if (unstableIds.length) {
		const warning = document.createElement('div');
		warning.className = 'resp-notice';
		warning.textContent =
			`Warning: ${unstableIds.join(', ')} use automatic or duplicate ids. Add unique Pixi labels or these rules may target a different element after a remount.`;
		wrap.appendChild(warning);
	}
	wrap.appendChild(table);
	const result = await showModal({
		title: 'Save layout changes',
		body: wrap,
		buttons: [
			{ label: 'Cancel', value: false },
			{ label: 'Save to project', value: true, primary: true },
		],
	});
	return !!result;
}
