/**
 * Asset recheck: rescan the game project's asset sources and register new ones.
 *
 * How this game (standard web-sdk app) registers assets:
 *  - Files live under `<appDir>/static/assets/{sprites,spines,fonts,audio}/...`
 *    (served by SvelteKit at `/assets/...`).
 *  - `src/game/assets.ts` default-exports one entry per asset with
 *    `src: new URL('../../assets/<...>', import.meta.url).href`. The AssetsLoader
 *    loads EVERY entry at startup; `type: 'sprites'` spritesheets get their frames
 *    spread into `loadedAssets` by frame name, `type: 'sprite'` is a single texture.
 *
 * So "registering" a new atlas, image or Spine skeleton = appending an entry
 * to assets.ts.
 * The scanner only APPENDS anchored entries (never rewrites existing ones), takes a
 * one-time backup, and reports anything it cannot handle as manual work.
 */
const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const SPINE_SKELETON_EXTENSIONS = new Set(['.json', '.skel']);
// categories whose loose files are not sprite material
const EXCLUDED_CATEGORIES = new Set(['audio', 'fonts']);

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const backupOnce = (p) => {
	const backup = `${p}.sle-backup`;
	if (fs.existsSync(p) && !fs.existsSync(backup)) fs.copyFileSync(p, backup);
};

const toPosix = (p) => p.split(path.sep).join('/');

/** Walk a directory tree returning absolute file paths (bounded depth). */
function walkFiles(dir, depth = 0, out = []) {
	if (depth > 6) return out;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, depth + 1, out);
		else out.push(full);
	}
	return out;
}

/** Parse assets.ts: registered URL paths (normalized under assets/) + top-level keys. */
function parseAssetsTs(source) {
	const registeredPaths = new Set();
	for (const match of source.matchAll(/new URL\(\s*(['"])([^'"]+)\1/g)) {
		// '../../assets/sprites/x/y.json' -> 'sprites/x/y.json'
		const normalized = match[2].replace(/^(\.\.\/)+assets\//, '');
		registeredPaths.add(normalized);
	}
	const keys = new Set();
	for (const match of source.matchAll(/^\t([A-Za-z_$][\w$]*)\s*:\s*\{/gm)) keys.add(match[1]);
	return { registeredPaths, keys };
}

const GENERIC_BASENAMES = new Set(['atlas', 'spritesheet', 'sheet', 'texture', 'textures', 'assets', 'index']);
const GENERIC_SPINE_IMPORTS = new Set(['spine', 'skeleton', 'data']);

const suggestKey = (baseName, taken, folderName = '') => {
	// generic exporter filenames (atlas.json …) name assets after their folder
	if (GENERIC_BASENAMES.has(baseName.toLowerCase()) && folderName) baseName = folderName;
	let key = baseName.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
	if (!key || /^\d/.test(key)) key = `asset_${key}`;
	let candidate = key;
	let counter = 2;
	while (taken.has(candidate)) candidate = `${key}${counter++}`;
	taken.add(candidate);
	return candidate;
};

/** Use the most common parser scale already used by this game's Spine entries. */
const inferSpineScale = (source) => {
	const counts = new Map();
	for (const match of source.matchAll(/type\s*:\s*['"]spine['"][\s\S]*?src\s*:\s*\{([\s\S]*?)\}\s*,?/g)) {
		const value = Number(match[1].match(/\bscale\s*:\s*(-?(?:\d+\.?\d*|\.\d+))/)?.[1]);
		if (Number.isFinite(value) && value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	let best = 1;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
};

const parseSpineJson = (file) => {
	try {
		const json = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!json?.skeleton || !Array.isArray(json?.bones)) return null;
		return {
			animations: Object.keys(json.animations ?? {}),
			version: typeof json.skeleton?.spine === 'string' ? json.skeleton.spine : null,
		};
	} catch {
		return null;
	}
};

const spineMajorMinor = (value) => String(value ?? '').match(/(\d+\.\d+)/)?.[1] ?? null;

/** Detect the Spine runtime line used by this Stake project. */
const inferSpineRuntimeVersion = ({ appDir, registeredPaths, spineSkeletons, relOf }) => {
	let cursor = appDir;
	for (let depth = 0; depth < 5; depth++) {
		const packageSource = read(path.join(cursor, 'packages', 'pixi-svelte', 'package.json'));
		if (packageSource) {
			try {
				const packageJson = JSON.parse(packageSource);
				const dependency =
					packageJson.dependencies?.['@esotericsoftware/spine-pixi-v8'] ??
					packageJson.devDependencies?.['@esotericsoftware/spine-pixi-v8'];
				const version = spineMajorMinor(dependency);
				if (version) return version;
			} catch {
				// Fall back to versions in already registered skeletons.
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	const counts = new Map();
	for (const [file, info] of spineSkeletons) {
		if (!registeredPaths.has(relOf(file))) continue;
		const version = spineMajorMinor(info.version);
		if (version) counts.set(version, (counts.get(version) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/**
 * Exporter index files are not executed by this loader, but their import names
 * are useful, conservative hints for intended keys and shared-atlas pairing.
 */
const parseSpineIndexHints = (dir) => {
	const source = read(path.join(dir, 'index.ts')) ?? '';
	const atlasImports = [];
	const skeletonImports = [];
	for (const match of source.matchAll(
		/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/([^'"]+\.atlas)\?raw['"]/gi,
	)) {
		atlasImports.push({ name: match[1], file: path.resolve(dir, ...match[2].split('/')) });
	}
	for (const match of source.matchAll(
		/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/([^'"]+\.(?:json|skel))['"]/gi,
	)) {
		skeletonImports.push({
			name: match[1],
			file: path.resolve(dir, ...match[2].split('/')),
		});
	}
	const keyBySkeleton = new Map();
	const atlasBySkeleton = new Map();
	for (const entry of skeletonImports) {
		if (!GENERIC_SPINE_IMPORTS.has(entry.name.toLowerCase())) {
			keyBySkeleton.set(entry.file.toLowerCase(), entry.name);
		}
		if (atlasImports.length === 1) {
			atlasBySkeleton.set(entry.file.toLowerCase(), atlasImports[0].file);
		}
	}
	return { keyBySkeleton, atlasBySkeleton };
};

/** Page image paths referenced by a Spine text atlas. */
const spineAtlasPages = (atlasFile) => {
	const source = read(atlasFile);
	if (!source) return [];
	const lines = source.split(/\r?\n/);
	const pages = [];
	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index];
		if (!raw || /^\s/.test(raw)) continue;
		const name = raw.trim();
		if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
		let next = '';
		for (let cursor = index + 1; cursor < lines.length && !next; cursor++) {
			next = lines[cursor].trim();
		}
		if (
			index === lines.findIndex((line) => line.trim()) ||
			/^(?:size|format|filter|repeat|pma)\s*:/i.test(next)
		) {
			pages.push(path.resolve(path.dirname(atlasFile), ...name.split('/')));
		}
	}
	return pages;
};

function scanAssets({ appDir, sinceMs }) {
	const scannedAtMs = Date.now();
	const assetsTsPath = path.join(appDir, 'src', 'game', 'assets.ts');
	const assetRoot = path.join(appDir, 'static', 'assets');
	const source = read(assetsTsPath);
	if (!source) {
		return { ok: false, error: `src/game/assets.ts not found — this project registers assets differently; see the manual note.`, manual: true };
	}
	if (!fs.existsSync(assetRoot)) {
		return { ok: false, error: `static/assets not found in the app — unknown asset layout.`, manual: true };
	}
	const anchorOk = source.includes('export default {');
	const { registeredPaths, keys } = parseAssetsTs(source);
	const taken = new Set(keys);

	const files = walkFiles(assetRoot);
	const relOf = (abs) => toPosix(path.relative(assetRoot, abs));
	const category = (rel) => rel.split('/')[0];

	// Spine uses one text atlas plus one or more skeleton JSON/.skel files. A
	// single atlas commonly serves several independently registered skeletons.
	const spineAtlasFiles = files.filter((file) => path.extname(file).toLowerCase() === '.atlas');
	const spineSkeletons = new Map();
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (!SPINE_SKELETON_EXTENSIONS.has(ext)) continue;
		if (ext === '.skel') {
			spineSkeletons.set(file, { animations: [], version: null, binary: true });
			continue;
		}
		const parsed = parseSpineJson(file);
		if (parsed) spineSkeletons.set(file, { ...parsed, binary: false });
	}
	const spineDirs = new Set([
		...spineAtlasFiles.map((file) => path.dirname(file)),
		...[...spineSkeletons.keys()].map((file) => path.dirname(file)),
	]);
	const spinePageImages = new Set(spineAtlasFiles.flatMap(spineAtlasPages));

	// folder-level index.ts exports: produced by some asset pipelines, but not used
	// by this project's loader (registration goes through src/game/assets.ts)
	const indexDirs = new Set(
		files.filter((f) => path.basename(f) === 'index.ts').map((f) => path.dirname(f)),
	);

	// spritesheet atlases: json with frames + meta
	const atlasImages = new Set(); // abs paths of atlas page images
	const atlasDirs = new Set(); // dirs containing spritesheet jsons
	const newAtlases = [];
	for (const file of files) {
		if (path.extname(file).toLowerCase() !== '.json' || spineDirs.has(path.dirname(file))) continue;
		let json;
		try {
			json = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			continue;
		}
		if (!json?.frames || !json?.meta) continue;
		atlasDirs.add(path.dirname(file));
		const frames = Object.keys(json.frames);
		const imageAbs = json.meta.image ? path.join(path.dirname(file), json.meta.image) : null;
		if (imageAbs) atlasImages.add(imageAbs);
		const rel = relOf(file);
		if (registeredPaths.has(rel)) continue;
		newAtlases.push({
			kind: 'atlas',
			key: suggestKey(path.basename(file, '.json'), taken, path.basename(path.dirname(file))),
			rel,
			file: toPosix(file),
			frames: frames.slice(0, 200),
			frameCount: frames.length,
			imageOk: imageAbs ? fs.existsSync(imageAbs) : false,
			imageName: json.meta.image ?? null,
			hasIndexTs: indexDirs.has(path.dirname(file)),
		});
	}

	// Loose images (plain `sprite` entries). Only offered from folders WITHOUT a
	// spritesheet json or an index.ts — folders with either typically hold atlas
	// pages / format variants (.png next to .webp) rather than standalone sprites.
	const newImages = [];
	const seenImageBase = new Map(); // dir+basename -> entry (prefer .webp over .png twins)
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (!IMAGE_EXTENSIONS.has(ext)) continue;
		const dir = path.dirname(file);
		if (
			spineDirs.has(dir) ||
			atlasDirs.has(dir) ||
			indexDirs.has(dir) ||
			atlasImages.has(file) ||
			spinePageImages.has(file)
		) continue;
		const rel = relOf(file);
		if (EXCLUDED_CATEGORIES.has(category(rel))) continue;
		if (registeredPaths.has(rel)) continue;
		const baseId = toPosix(path.join(dir, path.basename(file, ext)));
		const existing = seenImageBase.get(baseId);
		if (existing && !(ext === '.webp' && existing.rel.endsWith('.png'))) continue;
		const entry = {
			kind: 'image',
			key: existing?.key ?? suggestKey(path.basename(file, ext), taken),
			rel,
			file: toPosix(file),
		};
		if (existing) newImages.splice(newImages.indexOf(existing), 1);
		seenImageBase.set(baseId, entry);
		newImages.push(entry);
	}

	// Concrete Spine entries are per skeleton, not per folder/atlas. Registration
	// is keyed by skeleton path so a new skeleton sharing an existing atlas is found.
	const suggestedSpineScale = inferSpineScale(source);
	const expectedSpineVersion = inferSpineRuntimeVersion({
		appDir,
		registeredPaths,
		spineSkeletons,
		relOf,
	});
	const newSpines = [];
	const spineIssues = [];
	for (const dir of spineDirs) {
		const atlasFiles = spineAtlasFiles.filter((file) => path.dirname(file) === dir);
		const skeletonFiles = [...spineSkeletons.keys()].filter((file) => path.dirname(file) === dir);
		const dirRel = toPosix(path.relative(assetRoot, dir));
		if (!atlasFiles.length && skeletonFiles.length) {
			spineIssues.push({
				dir: dirRel,
				reason: 'Spine skeleton data found, but this folder has no .atlas file.',
				files: skeletonFiles.map(relOf),
			});
			continue;
		}
		if (atlasFiles.length && !skeletonFiles.length) {
			spineIssues.push({
				dir: dirRel,
				reason: 'Spine atlas found, but this folder has no valid skeleton .json or .skel file.',
				files: atlasFiles.map(relOf),
			});
			continue;
		}
		const hints = parseSpineIndexHints(dir);
		for (const skeletonFile of skeletonFiles) {
			const skeletonRel = relOf(skeletonFile);
			if (registeredPaths.has(skeletonRel)) continue;
			const skeletonBase = path.basename(skeletonFile, path.extname(skeletonFile)).toLowerCase();
			const exact = atlasFiles.filter(
				(file) => path.basename(file, path.extname(file)).toLowerCase() === skeletonBase,
			);
			const hinted = hints.atlasBySkeleton.get(skeletonFile.toLowerCase());
			const atlasFile =
				atlasFiles.length === 1
					? atlasFiles[0]
					: exact.length === 1
						? exact[0]
						: hinted && atlasFiles.includes(hinted)
							? hinted
							: null;
			if (!atlasFile) {
				spineIssues.push({
					dir: dirRel,
					reason: `Cannot choose an atlas for ${path.basename(skeletonFile)} because this folder contains multiple atlases.`,
					files: [skeletonRel, ...atlasFiles.map(relOf)],
				});
				continue;
			}
			const pages = spineAtlasPages(atlasFile);
			const missingPages = pages.filter((file) => !fs.existsSync(file)).map(relOf);
			const info = spineSkeletons.get(skeletonFile);
			const keyHint = hints.keyBySkeleton.get(skeletonFile.toLowerCase());
			const pageIssue = !pages.length
				? 'Atlas contains no supported page image (.png, .webp, .jpg or .jpeg).'
				: missingPages.length
					? `Missing atlas page image(s): ${missingPages.join(', ')}`
					: null;
			const skeletonVersion = spineMajorMinor(info?.version);
			const versionIssue =
				expectedSpineVersion && skeletonVersion && skeletonVersion !== expectedSpineVersion
					? `Skeleton was exported with Spine ${info.version}; this project uses the ${expectedSpineVersion} runtime. Re-export it with Spine ${expectedSpineVersion}.x.`
					: null;
			const loadIssue = [pageIssue, versionIssue].filter(Boolean).join(' ') || null;
			newSpines.push({
				kind: 'spine',
				key: suggestKey(keyHint ?? path.basename(skeletonFile, path.extname(skeletonFile)), taken, path.basename(dir)),
				atlasRel: relOf(atlasFile),
				skeletonRel,
				scale: suggestedSpineScale,
				animations: info?.animations ?? [],
				spineVersion: info?.version ?? null,
				binary: !!info?.binary,
				imageOk: !pageIssue,
				versionOk: !versionIssue,
				loadOk: !loadIssue,
				pages: pages.map(relOf),
				missingPages,
				loadIssue,
				hasIndexTs: indexDirs.has(dir),
			});
		}
	}

	// Files edited in place since the last recheck. Replacing a page image inside
	// an already-registered atlas adds nothing new to assets.ts, so it is invisible
	// to the "new assets" lists above — but it still needs a cache-busting reload
	// before the new pixels show up. Reported so that change is visible.
	const changedFiles = [];
	if (Number.isFinite(sinceMs) && sinceMs > 0) {
		for (const file of files) {
			let mtimeMs;
			try {
				mtimeMs = fs.statSync(file).mtimeMs;
			} catch {
				continue;
			}
			if (mtimeMs <= sinceMs) continue;
			const rel = relOf(file);
			changedFiles.push({
				rel,
				mtimeMs,
				// an atlas page image, or any file already referenced from assets.ts
				isAtlasPage: atlasImages.has(file) || spinePageImages.has(file),
				isSpinePage: spinePageImages.has(file),
				registered: registeredPaths.has(rel),
			});
		}
		changedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
	}

	return {
		ok: true,
		anchorOk,
		assetsTsPath: toPosix(assetsTsPath),
		assetRoot: toPosix(assetRoot),
		registeredCount: registeredPaths.size,
		newAtlases,
		newImages,
		newSpines,
		spineIssues,
		suggestedSpineScale,
		expectedSpineVersion,
		changedFiles,
		scannedAtMs,
	};
}

/** Append entries (sprite atlases, images and Spine skeletons) to assets.ts. */
function registerAssets({ appDir, entries }) {
	const assetsTsPath = path.join(appDir, 'src', 'game', 'assets.ts');
	let source = read(assetsTsPath);
	if (!source) return { ok: false, error: 'src/game/assets.ts not found' };
	const anchor = 'export default {';
	const anchorIndex = source.indexOf(anchor);
	if (anchorIndex === -1) {
		return { ok: false, error: 'assets.ts has no `export default {` anchor — register the assets by hand' };
	}
	const { keys } = parseAssetsTs(source);
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const added = [];
	const skipped = [];
	let block = '';
	for (const entry of entries) {
		if (keys.has(entry.key)) {
			skipped.push(entry.key);
			continue;
		}
		const comment = `\t// Registered by the Layout Editor (${new Date().toISOString().slice(0, 10)})${eol}`;
		if (entry.kind === 'spine') {
			const scale = Number(entry.scale);
			if (
				!entry.atlasRel ||
				!entry.skeletonRel ||
				!Number.isFinite(scale) ||
				scale <= 0
			) {
				skipped.push(entry.key);
				continue;
			}
			block +=
				comment +
				`\t${entry.key}: {${eol}` +
				`\t\ttype: 'spine',${eol}` +
				`\t\tsrc: {${eol}` +
				`\t\t\tatlas: new URL('../../assets/${entry.atlasRel}', import.meta.url).href,${eol}` +
				`\t\t\tskeleton: new URL('../../assets/${entry.skeletonRel}', import.meta.url).href,${eol}` +
				`\t\t\tscale: ${scale},${eol}` +
				`\t\t},${eol}` +
				`\t},${eol}`;
		} else {
			const type = entry.kind === 'atlas' ? 'sprites' : 'sprite';
			block +=
				comment +
				`\t${entry.key}: {${eol}` +
				`\t\ttype: '${type}',${eol}` +
				`\t\tsrc: new URL('../../assets/${entry.rel}', import.meta.url).href,${eol}` +
				`\t},${eol}`;
		}
		added.push(entry.key);
		keys.add(entry.key);
	}
	if (block) {
		// insert on the line after the anchor (handle CRLF and LF files)
		let afterAnchor = anchorIndex + anchor.length;
		if (source[afterAnchor] === '\r') afterAnchor++;
		if (source[afterAnchor] === '\n') afterAnchor++;
		source = source.slice(0, afterAnchor) + block + source.slice(afterAnchor);
		backupOnce(assetsTsPath);
		fs.writeFileSync(assetsTsPath, source, 'utf8');
	}
	return { ok: true, added, skipped, file: toPosix(assetsTsPath) };
}

module.exports = { scanAssets, registerAssets };
