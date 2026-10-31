// Key images as SVG. Every key: rounded tile, fan name along the top, a picture in the middle, a detail
// line at the bottom. Colour says whether the fan is on (blue), off (slate) or unavailable (grey).
const FONT = "Arial, Helvetica, sans-serif";

export interface Theme {
	bg1: string;
	bg2: string;
	accent: string;
	dim: string;
	track: string;
}

export const THEMES = {
	on: { bg1: "#16384A", bg2: "#0A1820", accent: "#5CC8F2", dim: "#9CC3D3", track: "#24475A" },
	off: { bg1: "#2B3036", bg2: "#121518", accent: "#AEB6BF", dim: "#858E97", track: "#3A4148" },
	na: { bg1: "#2E2A2A", bg2: "#141212", accent: "#9A8F8F", dim: "#8A8080", track: "#403A3A" },
	warn: { bg1: "#4A3416", bg2: "#20170A", accent: "#F2B05C", dim: "#D3B48C", track: "#5A4424" },
} satisfies Record<string, Theme>;

/** "On" colours a fan can be given. Every key for that fan uses the same one. */
export const COLORS: Record<string, Theme & { name: string }> = {
	blue: { name: "Sky blue", ...THEMES.on },
	teal: { name: "Teal", bg1: "#123F3C", bg2: "#081B1A", accent: "#4FD8C4", dim: "#93CCC3", track: "#1F4F4A" },
	green: { name: "Green", bg1: "#1B3D1E", bg2: "#0B190C", accent: "#6FDB6A", dim: "#A2CDA0", track: "#2A4E2C" },
	purple: { name: "Purple", bg1: "#2F2148", bg2: "#140E20", accent: "#B48CFF", dim: "#C2B0E0", track: "#3F2E5E" },
	pink: { name: "Pink", bg1: "#47203A", bg2: "#1E0D18", accent: "#FF7AC8", dim: "#E0A9C9", track: "#5C2C4C" },
	orange: { name: "Orange", bg1: "#4A2A14", bg2: "#20120A", accent: "#FF9A4A", dim: "#DDB08E", track: "#5E3A22" },
	red: { name: "Red", bg1: "#4A1C1C", bg2: "#200C0C", accent: "#FF6B6B", dim: "#E0A3A3", track: "#5E2A2A" },
	gold: { name: "Gold", bg1: "#463A12", bg2: "#1F1A08", accent: "#F5CF4A", dim: "#D9C88E", track: "#5A4B20" },
};
export const colorFor = (key: string | undefined): Theme => COLORS[key ?? ""] ?? COLORS.blue;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shrink the font so long names still fit across the key. */
function fit(text: string, max: number, width = 124): number {
	const est = text.length * 0.6;
	return Math.max(10, Math.min(max, Math.floor(width / Math.max(est, 1))));
}

function frame(t: Theme, label: string, body: string, bottom: string, bottomColor = t.dim): string {
	const top = label
		? `<text x="72" y="30" fill="${t.dim}" font-family="${FONT}" font-weight="700" font-size="${fit(label.toUpperCase(), 17)}" text-anchor="middle" letter-spacing="0.5">${esc(label.toUpperCase())}</text>`
		: "";
	const bot = bottom
		? `<text x="72" y="126" fill="${bottomColor}" font-family="${FONT}" font-weight="800" font-size="${fit(bottom, 19)}" text-anchor="middle">${esc(bottom)}</text>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient></defs>
<rect x="0" y="0" width="144" height="144" rx="22" fill="url(#bg)"/>
${top}${body}${bot}</svg>`;
}

/** Three-blade fan, centred at (cx, cy), radius r. */
export function fanGlyph(cx: number, cy: number, r: number, color: string, ring = true): string {
	const blade = `M 0 0 C ${r * 0.15} ${-r * 0.35}, ${r * 0.55} ${-r * 0.95}, ${r * 0.05} ${-r * 0.92} C ${-r * 0.4} ${-r * 0.9}, ${-r * 0.32} ${-r * 0.35}, 0 0 Z`;
	const blades = [0, 120, 240].map((a) => `<path d="${blade}" transform="rotate(${a})" fill="${color}"/>`).join("");
	const ringSvg = ring ? `<circle r="${r + 5}" fill="none" stroke="${color}" stroke-width="4" opacity="0.55"/>` : "";
	return `<g transform="translate(${cx} ${cy})">${ringSvg}${blades}<circle r="${r * 0.17}" fill="${color}"/></g>`;
}

const arrowPath = (dir: "up" | "down" | "left" | "right") => {
	const rot = { up: 0, right: 90, down: 180, left: 270 }[dir];
	return (cx: number, cy: number, s: number, color: string) =>
		`<path d="M 0 ${-s} L ${s * 0.9} ${s * 0.1} H ${s * 0.38} V ${s} H ${-s * 0.38} V ${s * 0.1} H ${-s * 0.9} Z" transform="translate(${cx} ${cy}) rotate(${rot})" fill="${color}" stroke-linejoin="round"/>`;
};

/** A row of pills, one per speed level, filled up to the current speed. */
function speedBar(t: Theme, speed: number | null, max: number, y: number): string {
	const n = Math.min(max, 12);
	const gap = 3;
	const w = (112 - gap * (n - 1)) / n;
	const filled = speed === null ? 0 : Math.round((speed / max) * n);
	return Array.from({ length: n }, (_, i) => {
		const x = 16 + i * (w + gap);
		return `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="8" rx="3" fill="${i < filled ? t.accent : t.track}"/>`;
	}).join("");
}

export interface View {
	label: string;
	showLabel: boolean;
	/** this fan's "on" colour */
	theme: Theme;
}
const lbl = (v: View) => (v.showLabel ? v.label : "");

/** Not signed in / no fan picked / fan offline. */
export function renderMessage(view: View, line1: string, line2 = "", theme: Theme = THEMES.na): string {
	const body = `${fanGlyph(72, 66, 22, theme.track)}
<text x="72" y="${line2 ? 110 : 120}" fill="${theme.accent}" font-family="${FONT}" font-weight="800" font-size="${fit(line1, 17)}" text-anchor="middle">${esc(line1)}</text>
${line2 ? `<text x="72" y="128" fill="${theme.dim}" font-family="${FONT}" font-weight="700" font-size="${fit(line2, 13)}" text-anchor="middle">${esc(line2)}</text>` : ""}`;
	return frame(theme, lbl(view), body, "");
}

export function renderPower(view: View, on: boolean, speed: number | null, max: number | null, mode: "toggle" | "on" | "off"): string {
	const t = on ? view.theme : THEMES.off;
	const badge = mode === "toggle" ? "" : `<text x="118" y="54" fill="${t.dim}" font-family="${FONT}" font-weight="800" font-size="12" text-anchor="middle">${mode.toUpperCase()}</text>`;
	const bottom = on ? (speed !== null ? `ON · ${speed}${max ? `/${max}` : ""}` : "ON") : "OFF";
	return frame(t, lbl(view), fanGlyph(72, 70, 26, t.accent) + badge, bottom, on ? t.accent : t.dim);
}

export function renderSpeed(view: View, on: boolean, speed: number | null, max: number, mode: "up" | "down" | "set", target: number): string {
	const t = on ? view.theme : THEMES.off;
	let body: string;
	if (mode === "set") {
		const active = on && speed === target;
		body = `<text x="72" y="86" fill="${active ? t.accent : "#FFFFFF"}" font-family="${FONT}" font-weight="900" font-size="46" text-anchor="middle">${target}</text>
<text x="72" y="104" fill="${t.dim}" font-family="${FONT}" font-weight="700" font-size="12" text-anchor="middle">SET SPEED</text>`;
	} else {
		body = `${arrowPath(mode)(40, 70, 20, "#FFFFFF")}
<text x="98" y="84" fill="${t.accent}" font-family="${FONT}" font-weight="900" font-size="40" text-anchor="middle">${on && speed !== null ? speed : "–"}</text>`;
	}
	return frame(t, lbl(view), body + speedBar(t, on ? speed : null, max, 112), "");
}

/** A window onto the fan's aiming range: horizontal across, vertical up. Target is the filled dot,
 *  where the fan points now is the ring. */
export function renderAim(
	view: View,
	opts: {
		on: boolean;
		hRange: [number, number];
		vRange: [number, number];
		target: { h: number; v: number } | null;
		current: { h: number; v: number } | null;
		horizontalOnly: boolean;
		caption: string;
		matched: boolean;
	},
): string {
	const t = opts.matched ? view.theme : THEMES.off;
	const x0 = 20, x1 = 124, y0 = 40, y1 = opts.horizontalOnly ? 92 : 104;
	const px = (h: number) => x0 + ((h - opts.hRange[0]) / (opts.hRange[1] - opts.hRange[0])) * (x1 - x0);
	const py = (v: number) => (opts.horizontalOnly ? (y0 + y1) / 2 : y1 - ((v - opts.vRange[0]) / (opts.vRange[1] - opts.vRange[0])) * (y1 - y0));
	const grid = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="8" fill="${t.track}" opacity="0.55"/>
<line x1="${px(0)}" y1="${y0 + 4}" x2="${px(0)}" y2="${y1 - 4}" stroke="${t.dim}" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.6"/>
${opts.horizontalOnly ? "" : `<line x1="${x0 + 4}" y1="${py(0)}" x2="${x1 - 4}" y2="${py(0)}" stroke="${t.dim}" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.6"/>`}`;
	const cur = opts.current ? `<circle cx="${px(opts.current.h)}" cy="${py(opts.current.v)}" r="9" fill="none" stroke="#FFFFFF" stroke-width="3"/>` : "";
	const tgt = opts.target ? `<circle cx="${px(opts.target.h)}" cy="${py(opts.target.v)}" r="7" fill="${t.accent}"/>` : "";
	return frame(t, lbl(view), grid + tgt + cur, opts.caption, opts.matched ? t.accent : "#FFFFFF");
}

export function renderNudge(view: View, dir: "left" | "right" | "up" | "down", step: number, caption: string, on: boolean): string {
	const t = on ? view.theme : THEMES.off;
	return frame(t, lbl(view), arrowPath(dir)(72, 70, 26, t.accent), caption || `${step}°`, "#FFFFFF");
}

/** Sweep arrows: ↔ for horizontal, ↕ for vertical. Lit when that axis is oscillating. */
export function renderOsc(view: View, axis: "h" | "v" | "both", osc: { h: boolean; v: boolean }, vertical: boolean): string {
	const active = axis === "h" ? osc.h : axis === "v" ? osc.v : osc.h || osc.v;
	const t = active ? view.theme : THEMES.off;
	const sweep = (rot: number, lit: boolean) =>
		`<g transform="translate(72 70) rotate(${rot})" stroke="${lit ? t.accent : t.dim}" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
<path d="M -30 8 Q 0 -18 30 8"/><path d="M -36 -4 L -30 8 L -17 6"/><path d="M 36 -4 L 30 8 L 17 6"/></g>`;
	let body: string;
	if (axis === "h") body = sweep(0, osc.h);
	else if (axis === "v") body = sweep(90, osc.v);
	else body = `<g transform="translate(-4 2) scale(0.92)" transform-origin="72 70">${sweep(0, osc.h)}${vertical ? sweep(90, osc.v) : ""}</g>`;
	const what = axis === "h" ? "SWEEP ↔" : axis === "v" ? "SWEEP ↕" : "SWEEP";
	return frame(t, lbl(view), body, `${what} ${active ? "ON" : "OFF"}`, active ? t.accent : t.dim);
}

export const toDataUrl = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
