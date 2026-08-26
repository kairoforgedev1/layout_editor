/** Device/resolution presets + the same layoutType mapping the game uses. */

export const PRESETS = [
	{ group: 'Phone', name: 'iPhone SE', w: 375, h: 667, portraitFirst: true },
	{ group: 'Phone', name: 'Galaxy S20', w: 360, h: 800, portraitFirst: true },
	{ group: 'Phone', name: 'iPhone 14', w: 390, h: 844, portraitFirst: true },
	{ group: 'Phone', name: 'Pixel 7', w: 412, h: 915, portraitFirst: true },
	{ group: 'Phone', name: 'iPhone 14 Pro Max', w: 430, h: 932, portraitFirst: true },
	{ group: 'Phone', name: 'FHD phone', w: 1080, h: 1920, portraitFirst: true },
	{ group: 'Tablet', name: 'iPad Mini', w: 768, h: 1024, portraitFirst: true },
	{ group: 'Tablet', name: 'iPad Air', w: 820, h: 1180, portraitFirst: true },
	{ group: 'Tablet', name: 'iPad Pro 12.9', w: 1024, h: 1366, portraitFirst: true },
	// Stake's native tablet profile is selected by a near-square aspect ratio;
	// common iPad viewports select portrait/desktop instead.
	{ group: 'Tablet', name: 'Native tablet (near-square)', w: 900, h: 1024, portraitFirst: true },
	{ group: 'Desktop', name: 'HD 720p', w: 1280, h: 720, portraitFirst: false },
	{ group: 'Desktop', name: 'WXGA', w: 1366, h: 768, portraitFirst: false },
	{ group: 'Desktop', name: 'FHD 1080p', w: 1920, h: 1080, portraitFirst: false },
	{ group: 'Desktop', name: 'QHD 1440p', w: 2560, h: 1440, portraitFirst: false },
];

/**
 * Mirrors utils-layout/createLayout so the editor can predict which layout
 * profile the game will activate at a given resolution. The game's own value
 * (bridge `layout` messages) stays authoritative.
 */
export function computeLayoutType(width, height) {
	const ratio = width / (height || 1);
	const ratioType = ratio >= 1.3 ? 'longWidth' : ratio <= 0.8 ? 'longHeight' : 'almostSquare';
	const deviceWidth = Math.min(width, height);
	const sizeType =
		deviceWidth <= 375
			? 'smallMobile'
			: deviceWidth <= 480
				? 'mobile'
				: deviceWidth <= 820
					? 'tablet'
					: deviceWidth <= 1024
						? 'largeTablet'
						: 'desktop';
	if (ratioType === 'almostSquare') return 'tablet';
	if (ratioType === 'longHeight') return 'portrait';
	if (sizeType === 'mobile' || sizeType === 'smallMobile') return 'landscape';
	return 'desktop';
}

export const aspectString = (w, h) => {
	const gcd = (a, b) => (b ? gcd(b, a % b) : a);
	const d = gcd(w, h) || 1;
	const rw = w / d;
	const rh = h / d;
	if (rw > 50 || rh > 50) return (w / h).toFixed(2) + ':1';
	return `${rw}:${rh}`;
};
