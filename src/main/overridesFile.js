/**
 * Read/write the game's layout override data file
 * (`src/game/layoutOverrides.data.ts`). The file is a TS module whose exported
 * object literal is strict JSON, so it can be parsed and regenerated safely.
 */
const fs = require('fs');
const path = require('path');

const TEMPORARY_CONTAINER_ID = /^container#\d+$/;

const HEADER = `import type { LayoutOverridesData } from 'pixi-svelte';

/**
 * Layout overrides saved by the Layout Editor desktop tool.
 *
 * GENERATED FILE — edited by the Layout Editor. Hand edits are fine as long as the
 * object stays strict JSON (double-quoted keys, no comments inside), because the
 * editor parses the object literal below when it opens the project.
 *
 * Structure: profiles.base holds shared overrides; profiles.desktop / landscape /
 * portrait / tablet override base for the matching responsive layout type.
 * "elements" lists editor-created sprites, Spine animations, and containers instantiated at runtime.
 */
export const layoutOverridesData: LayoutOverridesData = `;

const EMPTY = { version: 1, profiles: {} };

const removeResponsiveOwnedGeometry = (entry, cfg) => {
	if (cfg.x || cfg.stretchX) delete entry.x;
	if (cfg.y || cfg.stretchY) delete entry.y;
	if (cfg.stretchX) delete entry.width;
	if (cfg.stretchY) delete entry.height;
	if (cfg.aspect || cfg.scaleMode) {
		delete entry.width;
		delete entry.height;
		delete entry.scaleX;
		delete entry.scaleY;
	}
	return entry;
};

const compactEntry = (source) => {
	const entry = structuredClone(source ?? {});
	const cfg = entry.responsive;
	if (!cfg || typeof cfg !== 'object') return entry;
	if (cfg.scaleMode === 'screen') cfg.scaleMode = 'game';
	delete cfg.scaleRefW;
	delete cfg.scaleRefH;
	if (cfg.scaleMode === 'parent') delete cfg.scaleMode;
	if (!cfg.scaleMode) delete cfg.scaleBase;
	if (!cfg.aspect) delete cfg.aspectSign;
	if (cfg.ref !== 'parent') delete cfg.parentRect;
	removeResponsiveOwnedGeometry(entry, cfg);
	return entry;
};

const normalizeData = (source, { temporaryContainerIds = [] } = {}) => {
	const temporaryIds = new Set(
		(Array.isArray(temporaryContainerIds) ? temporaryContainerIds : [])
			.filter((id) => typeof id === 'string' && id),
	);
	const clean = { version: source?.version ?? 1, profiles: {} };
	for (const [profile, entries] of Object.entries(source?.profiles ?? {})) {
		const nextEntries = {};
		for (const [id, entry] of Object.entries(entries ?? {})) {
			if (temporaryIds.has(id)) continue;
			const next = compactEntry(entry);
			if (Object.keys(next).length) nextEntries[id] = next;
		}
		if (Object.keys(nextEntries).length) clean.profiles[profile] = nextEntries;
	}
	const baseEntries = clean.profiles.base ?? {};
	for (const profile of ['desktop', 'landscape', 'portrait', 'tablet']) {
		const entries = clean.profiles[profile];
		for (const [id, entry] of Object.entries(entries ?? {})) {
			if (entry.responsive !== undefined) continue;
			const inherited = baseEntries[id]?.responsive;
			if (inherited && typeof inherited === 'object') {
				removeResponsiveOwnedGeometry(entry, inherited);
				if (Object.keys(entry).length === 0) delete entries[id];
			}
		}
		if (entries && Object.keys(entries).length === 0) delete clean.profiles[profile];
	}
	const spawned = (source?.elements ?? []).filter((element) => element && element.id && element.kind);
	if (spawned.length) clean.elements = structuredClone(spawned);
	return clean;
};

/** Extract the exported object literal (strict JSON) from the TS module source. */
function extractObjectLiteral(source) {
	const marker = source.indexOf('layoutOverridesData');
	if (marker === -1) throw new Error('layoutOverridesData export not found');
	const eq = source.indexOf('=', marker);
	const start = source.indexOf('{', eq);
	if (eq === -1 || start === -1) throw new Error('object literal not found');
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === '\\') escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error('unbalanced braces in object literal');
}

function readOverrides(overridesPath) {
	if (!fs.existsSync(overridesPath)) {
		return { ok: true, exists: false, data: structuredClone(EMPTY) };
	}
	try {
		const source = fs.readFileSync(overridesPath, 'utf8');
		const data = JSON.parse(extractObjectLiteral(source));
		if (!data.profiles || typeof data.profiles !== 'object') {
			throw new Error('missing "profiles" object');
		}
		return { ok: true, exists: true, data: normalizeData(data) };
	} catch (error) {
		return {
			ok: false,
			exists: true,
			data: structuredClone(EMPTY),
			error: `Could not parse ${path.basename(overridesPath)}: ${error.message}. ` +
				'Fix the file by hand (the object must be strict JSON) before saving from the editor.',
		};
	}
}

function writeOverrides(overridesPath, data, options = {}) {
	const temporaryIds = new Set(
		(Array.isArray(options?.temporaryContainerIds) ? options.temporaryContainerIds : [])
			.filter((id) => typeof id === 'string' && id),
	);
	const unsafeDefinitions = (data?.elements ?? [])
		.filter((element) =>
			TEMPORARY_CONTAINER_ID.test(element?.id ?? '') || temporaryIds.has(element?.id))
		.map((element) => element.id);
	if (unsafeDefinitions.length) {
		throw new Error(
			`Editor elements cannot use temporary runtime ids (${unsafeDefinitions.join(', ')}). ` +
			'Rename or permanently delete each legacy element before saving.',
		);
	}
	const unsafeParents = (data?.elements ?? [])
		.filter((element) => {
			const parentId = element?.parentId ?? '';
			return TEMPORARY_CONTAINER_ID.test(parentId) || temporaryIds.has(parentId);
		})
		.map((element) => `${element.id} → ${element.parentId}`);
	if (unsafeParents.length) {
		throw new Error(
			`Temporary runtime parents cannot be saved (${unsafeParents.join(', ')}). ` +
			'Choose the Pixi stage or a named parent for each editor-created element; repair parentId manually if an element cannot mount.',
		);
	}
	const clean = normalizeData(data, options);
	const body = JSON.stringify(clean, null, '\t');
	fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
	fs.writeFileSync(overridesPath, `${HEADER}${body};\n`, 'utf8');
	const verified = readOverrides(overridesPath);
	if (!verified.ok || JSON.stringify(verified.data) !== JSON.stringify(clean)) {
		throw new Error(verified.error ?? 'Saved override verification did not match the requested data.');
	}
	return { ok: true, data: verified.data };
}

module.exports = { readOverrides, writeOverrides, normalizeData };
