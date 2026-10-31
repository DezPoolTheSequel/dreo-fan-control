// Generates the plugin/category/action icons and default key images. Key images come from the same
// renderer the plugin uses, so the action list matches the live keys.
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const out = "com.dez.dreofan.sdPlugin/imgs";
fs.mkdirSync("tools/out", { recursive: true });
await build({ entryPoints: ["src/render.ts"], outfile: "tools/out/render.mjs", bundle: true, format: "esm", platform: "node", logLevel: "warning" });
const R = await import(pathToFileURL("tools/out/render.mjs").href);

const png = (svg, w, file) => {
	fs.mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
	fs.writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: w }, font: { loadSystemFonts: true } }).render().asPng());
};
const both = (svg, w, base) => (png(svg, w, `${base}.png`), png(svg, w * 2, `${base}@2x.png`));

// Monochrome glyphs (category + action list icons), 40×40
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${inner}</svg>`;
const W = "#FFFFFF";
const glyphs = {
	category: wrap(R.fanGlyph(20, 20, 12, W)),
	power: wrap(`<g fill="none" stroke="${W}" stroke-width="3.4" stroke-linecap="round"><path d="M 12.5 11.5 A 11 11 0 1 0 27.5 11.5"/><path d="M 20 6 V 19"/></g>`),
	speed: wrap(`${R.fanGlyph(15, 22, 9, W, false)}<path d="M 31 6 L 37 14 H 33.5 V 22 H 28.5 V 14 H 25 Z" fill="${W}"/><path d="M 31 36 L 37 28 H 25 Z" fill="${W}" opacity="0.6"/>`),
	aim: wrap(`<g fill="none" stroke="${W}" stroke-width="3" stroke-linecap="round"><circle cx="20" cy="20" r="11"/><path d="M 20 3 V 10 M 20 30 V 37 M 3 20 H 10 M 30 20 H 37"/></g><circle cx="20" cy="20" r="3.5" fill="${W}"/>`),
	oscillate: wrap(`<g fill="none" stroke="${W}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 24 Q 20 8 34 24"/><path d="M 4 17 L 6 24 L 13 23"/><path d="M 36 17 L 34 24 L 27 23"/></g>`),
	dial: wrap(`<circle cx="20" cy="20" r="14" fill="none" stroke="${W}" stroke-width="3"/>${R.fanGlyph(20, 20, 8, W, false)}`),
};
png(glyphs.category, 28, `${out}/plugin/category-icon.png`);
png(glyphs.category, 56, `${out}/plugin/category-icon@2x.png`);
for (const a of ["power", "speed", "aim", "oscillate", "dial"]) both(glyphs[a], 20, `${out}/actions/${a}/icon`);

// Default key images (what a key shows before it's set up / in the action list preview)
const view = { label: "Dreo", showLabel: true, theme: R.THEMES.on };
const keys = {
	power: R.renderPower(view, true, 5, 9, "toggle"),
	speed: R.renderSpeed(view, true, 5, 9, "up", 5),
	aim: R.renderAim(view, { on: true, hRange: [-60, 60], vRange: [-30, 90], target: { h: -30, v: 15 }, current: { h: -30, v: 15 }, horizontalOnly: false, caption: "LEFT", matched: true }),
	oscillate: R.renderOsc(view, "h", { h: true, v: false }, true),
	dial: R.renderPower(view, true, 5, 9, "toggle"),
};
for (const [a, svg] of Object.entries(keys)) both(svg, 72, `${out}/actions/${a}/key`);

// Marketplace / plugin icon
both(R.renderPower({ label: "", showLabel: false, theme: R.THEMES.on }, true, null, null, "toggle"), 288, `${out}/plugin/marketplace`);
console.log("icons ok");
