// Fake Stream Deck app + fake Dreo cloud (REST + WebSocket): launches the plugin, presses keys, checks the
// commands the fake cloud receives, and renders every key to tools/out/*.png plus a contact sheet.
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SD_PORT = 28125;
const DREO_PORT = 18990;
const EMAIL = "me@example.com";
const md5 = (s) => createHash("md5").update(s).digest("hex");
const HASH = md5("hunter2");
const A = (n) => `com.dez.dreofan.${n}`;

// ---------------------------------------------------------------- fake Dreo cloud
const swing = { fixedAngle: { verAngle: 120, horAngle: 150, verZeroAngle: 30, horZeroAngle: 75 } };
const speedConf = (max) => [{ type: "Speed", items: [{ value: 1 }, { value: max }] }];
const devices = [
	{ sn: "CIRC1", model: "DR-HPF007S", productName: "Air Circulator", deviceName: "Desk Fan", controlsConf: { swingAngle: swing, control: speedConf(10) } },
	{ sn: "TOWER1", model: "DR-HTF007S", productName: "Tower Fan", deviceName: "Bedroom Tower", controlsConf: { control: speedConf(8) } },
	{ sn: "OFF1", model: "DR-HAF004S", productName: "Air Circulator", deviceName: "Garage", controlsConf: {} },
	{ sn: "HEAT1", model: "DR-HSH004S", productName: "Heater", deviceName: "Heater (should be hidden)", controlsConf: {} },
];
const states = {
	CIRC1: { poweron: true, windlevel: 4, oscmode: 1, fixedconf: "0,0", cruiseconf: "50,60,0,0", mode: 1, connected: true },
	TOWER1: { poweron: false, windlevel: 3, shakehorizon: true, windtype: 1, connected: true },
	OFF1: { poweron: false, windlevel: 2, oscmode: 0, fixedconf: "0,0", hoscadj: 5, voscadj: -5, connected: false },
	HEAT1: { poweron: false, connected: true },
};
const controls = [];
let badLogin = 0;

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const reply = (o, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
		const authed = req.headers.authorization === "Bearer TOKEN123";
		if (url.pathname === "/api/oauth/login") {
			const b = JSON.parse(body || "{}");
			if (b.email === EMAIL && b.password === HASH && b.client_id) return reply({ code: 0, data: { access_token: "TOKEN123", region: "NA" } });
			badLogin++;
			return reply({ code: 11005, msg: "Incorrect password" });
		}
		if (!authed) return reply({ code: 401, msg: "unauthorized" }, 401);
		if (url.pathname === "/api/v2/user-device/device/list") return reply({ code: 0, data: { list: devices } });
		if (url.pathname === "/api/user-device/device/state") {
			const s = states[url.searchParams.get("deviceSn")] ?? {};
			return reply({ code: 0, data: { mixed: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { state: v, timestamp: 1 }])) } });
		}
		reply({ code: 404, msg: "nope" }, 404);
	});
});
const dreoWs = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
	if (!req.url.includes("accessToken=TOKEN123")) return sock.destroy();
	dreoWs.handleUpgrade(req, sock, head, (ws) => dreoWs.emit("connection", ws));
});
dreoWs.on("connection", (ws) => {
	ws.on("message", (raw) => {
		const s = String(raw);
		if (s === "2") return ws.send("3");
		const m = JSON.parse(s);
		if (m.method !== "control") return;
		controls.push({ sn: m.devicesn, ...m.params });
		ws.send(JSON.stringify({ devicesn: m.devicesn, method: "control-reply", reported: m.params }));
		// the fan does what it's told a moment later
		setTimeout(() => {
			Object.assign(states[m.devicesn], m.params);
			ws.send(JSON.stringify({ devicesn: m.devicesn, method: "control-report", reported: m.params }));
		}, 60);
	});
});
server.listen(DREO_PORT);

// ---------------------------------------------------------------- scenarios
const scenarios = [
	// [name, action, settings, controller]
	["01-power-on", A("power"), { fan: "CIRC1" }],
	["02-power-off", A("power"), { fan: "TOWER1", mode: "toggle" }],
	["03-speed-up", A("speed"), { fan: "CIRC1", speedMode: "up" }],
	["04-speed-down", A("speed"), { fan: "CIRC1", speedMode: "down", label: "Desk" }],
	["05-speed-set", A("speed"), { fan: "TOWER1", speedMode: "set", speed: 6 }],
	["06-aim-left", A("aim"), { fan: "CIRC1", h: -45, v: 20, presetName: "Left" }],
	["07-aim-center", A("aim"), { fan: "CIRC1", h: 0, v: 0 }],
	["08-nudge-right", A("aim"), { fan: "CIRC1", aimMode: "nudge", direction: "right", nudge: 15 }],
	["09-osc-h", A("oscillate"), { fan: "CIRC1", axis: "h" }],
	["10-osc-v", A("oscillate"), { fan: "CIRC1", axis: "v" }],
	["11-osc-tower", A("oscillate"), { fan: "TOWER1", axis: "h" }],
	["12-aim-tower", A("aim"), { fan: "TOWER1" }],
	["13-offline", A("power"), { fan: "OFF1" }],
	["14-no-fan", A("power"), {}],
	["15-dial", A("dial"), { fan: "CIRC1" }, "Encoder"],
];

// ---------------------------------------------------------------- fake Stream Deck
const wss = new WebSocketServer({ port: SD_PORT });
const images = {};
const feedback = {};
const toPI = [];
const shots = [];
let globals = { email: EMAIL, passwordHash: HASH };
let sock;
const send = (o) => sock.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coords = { column: 0, row: 0 };
const press = (name) => {
	const [, action] = scenarios.find(([n]) => n === name);
	send({ action, event: "keyDown", context: name, device: "dev1", payload: { settings: {}, coordinates: coords, isInMultiAction: false } });
};
const snap = (label, names) => names.forEach((n) => shots.push([`${label}:${n}`, images[n]]));

wss.on("connection", (ws) => {
	sock = ws;
	ws.on("message", (raw) => {
		const m = JSON.parse(raw);
		if (m.event === "registerPlugin") setTimeout(run, 200);
		else if (m.event === "getGlobalSettings") send({ event: "didReceiveGlobalSettings", payload: { settings: globals } });
		else if (m.event === "setGlobalSettings") globals = m.payload;
		else if (m.event === "setImage") images[m.context] = m.payload.image;
		else if (m.event === "setFeedback") feedback[m.context] = { ...(feedback[m.context] ?? {}), ...m.payload };
		else if (m.event === "sendToPropertyInspector") toPI.push(m.payload);
		else if (m.event === "showAlert") console.log("ALERT on", m.context);
	});
});

const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
const last = (sn) => [...controls].reverse().find((c) => c.sn === sn);

async function run() {
	for (const [name, action, settings, controller = "Keypad"] of scenarios)
		send({ action, event: "willAppear", context: name, device: "dev1", payload: { controller, coordinates: coords, isInMultiAction: false, settings } });
	await sleep(1500);
	for (const [n] of scenarios) shots.push([n, images[n]]);

	// Power toggle: CIRC1 is on → off
	press("01-power-on");
	await sleep(300);
	check("power toggle sends poweron:false", last("CIRC1")?.poweron === false, JSON.stringify(last("CIRC1")));
	press("01-power-on");
	await sleep(300);

	// Speed up three times fast: 4 → 7 even before the fan confirms
	const before = controls.length;
	press("03-speed-up"); press("03-speed-up"); press("03-speed-up");
	await sleep(300);
	const sp = controls.slice(before).map((c) => c.windlevel);
	check("rapid speed up builds on pending value", sp.join(",") === "5,6,7", sp.join(","));

	// Set speed on a fan that's off: power-on + windlevel in ONE message
	press("05-speed-set");
	await sleep(300);
	const t = last("TOWER1");
	check("set speed powers on in same message", t?.poweron === true && t?.windlevel === 6, JSON.stringify(t));

	// Aim while oscillating: oscmode 0 first, then fixedconf "v,h"
	const b2 = controls.length;
	press("06-aim-left");
	await sleep(1200);
	const aimCmds = controls.slice(b2).filter((c) => c.sn === "CIRC1");
	check("aim stops oscillation then sets fixedconf", aimCmds[0]?.oscmode === 0 && aimCmds[1]?.fixedconf === "20,-45", JSON.stringify(aimCmds));
	snap("after-aim", ["06-aim-left", "07-aim-center", "09-osc-h"]);

	// Nudge right 15° from -45 → -30
	press("08-nudge-right");
	await sleep(300);
	check("nudge right moves +15", last("CIRC1")?.fixedconf === "20,-30", JSON.stringify(last("CIRC1")));

	// Oscillate vertical toggle on: oscmode 2
	press("10-osc-v");
	await sleep(300);
	check("vertical oscillation on", last("CIRC1")?.oscmode === 2, JSON.stringify(last("CIRC1")));
	press("11-osc-tower");
	await sleep(300);
	check("tower oscillation uses shakehorizon", last("TOWER1")?.shakehorizon === false, JSON.stringify(last("TOWER1")));
	snap("after-osc", ["10-osc-v", "11-osc-tower", "05-speed-set"]);

	// Dial: two clicks right = speed +2 in one command
	const b3 = controls.length;
	send({ action: A("dial"), event: "dialRotate", context: "15-dial", device: "dev1", payload: { controller: "Encoder", coordinates: coords, settings: {}, ticks: 1, pressed: false } });
	send({ action: A("dial"), event: "dialRotate", context: "15-dial", device: "dev1", payload: { controller: "Encoder", coordinates: coords, settings: {}, ticks: 1, pressed: false } });
	await sleep(500);
	const dc = controls.slice(b3);
	check("dial coalesces ticks", dc.length === 1 && dc[0].windlevel === 9, JSON.stringify(dc));

	// Offline fan press should alert, not send
	const b4 = controls.length;
	press("13-offline");
	await sleep(200);
	check("offline fan sends nothing", controls.length === b4);

	// PI state
	send({ action: A("aim"), event: "propertyInspectorDidAppear", context: "06-aim-left", device: "dev1" });
	send({ action: A("aim"), event: "sendToPlugin", context: "06-aim-left", payload: { cmd: "hello" } });
	await sleep(300);
	const pi = toPI.at(-1);
	check("PI gets fans (heater filtered)", pi?.fans?.length === 3 && !pi.fans.some((f) => f.sn === "HEAT1"), pi?.fans?.map((f) => f.sn).join(","));
	check("PI gets live aim", pi?.live?.aim?.h === -30 && pi?.live?.aim?.v === 20, JSON.stringify(pi?.live?.aim));
	check("ranges from controlsConf", JSON.stringify(pi?.live?.caps?.hRange) === "[-75,75]" && JSON.stringify(pi?.live?.caps?.vRange) === "[-30,90]");

	// Wrong password via PI → error state, no retry storm
	send({ action: A("aim"), event: "sendToPlugin", context: "06-aim-left", payload: { cmd: "signin", email: EMAIL, password: "wrong" } });
	await sleep(1500);
	check("bad password reported", toPI.at(-1)?.account?.state === "ERROR" && badLogin === 1, `${toPI.at(-1)?.account?.error} logins=${badLogin}`);
	snap("bad-login", ["01-power-on"]);
	send({ action: A("aim"), event: "sendToPlugin", context: "06-aim-left", payload: { cmd: "signout" } });
	await sleep(300);
	check("sign out clears globals", !globals.email);
	snap("signed-out", ["01-power-on", "15-dial"]);
	send({ action: A("aim"), event: "sendToPlugin", context: "06-aim-left", payload: { cmd: "signin", email: EMAIL, password: "hunter2" } });
	await sleep(1500);
	check("sign in again works, stores hash only", toPI.at(-1)?.account?.state === "READY" && globals.passwordHash === HASH && !JSON.stringify(globals).includes("hunter2"));

	finish();
}

const info = {
	application: { font: "x", language: "en", platform: "windows", platformVersion: "10", version: "6.9.0.0" },
	plugin: { uuid: "com.dez.dreofan", version: "1.0.0.0" },
	devicePixelRatio: 2,
	colors: {},
	devices: [{ id: "dev1", name: "SD", size: { columns: 8, rows: 4 }, type: 7 }],
};
const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(SD_PORT), "-pluginUUID", "u1", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
	cwd: "com.dez.dreofan.sdPlugin",
	stdio: "inherit",
	env: { ...process.env, DREO_API_BASE: `http://127.0.0.1:${DREO_PORT}`, DREO_WS_BASE: `ws://127.0.0.1:${DREO_PORT}` },
});

function finish() {
	fs.mkdirSync("tools/out", { recursive: true });
	const cells = [];
	for (const [name, img] of shots) {
		if (!img) continue;
		const svg = decodeURIComponent(img.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
		const file = name.replace(/[^a-z0-9-]/gi, "_");
		fs.writeFileSync(`tools/out/${file}.png`, new Resvg(svg, { fitTo: { mode: "width", value: 144 }, font: { loadSystemFonts: true } }).render().asPng());
		cells.push([name, svg.replace(/id="bg"/g, `id="bg${cells.length}"`).replace(/url\(#bg\)/g, `url(#bg${cells.length})`)]);
	}
	const cols = 6;
	const rows = Math.ceil(cells.length / cols);
	const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * 160}" height="${rows * 172}"><rect width="100%" height="100%" fill="#222"/>${cells
		.map(([name, svg], i) => {
			const x = (i % cols) * 160 + 8;
			const y = Math.floor(i / cols) * 172 + 4;
			return `<svg x="${x}" y="${y}" width="144" height="144" viewBox="0 0 144 144">${svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg><text x="${x + 72}" y="${y + 160}" fill="#bbb" font-family="Arial" font-size="11" text-anchor="middle">${name}</text>`;
		})
		.join("")}</svg>`;
	fs.writeFileSync("tools/out/sheet.png", new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng());
	console.log("missing:", scenarios.map(([n]) => n).filter((n) => !images[n] && !feedback[n]).join(", ") || "none");
	console.log("dial feedback:", JSON.stringify(feedback["15-dial"]));
	console.log(results.join("\n"));
	child.kill();
	wss.close();
	server.close();
	process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
}
