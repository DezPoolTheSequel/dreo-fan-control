// Dreo cloud client. Dreo fans have no local API: the phone app (and this plugin) log in to Dreo's cloud,
// read the device list + state over REST, and send commands / receive live reports over one WebSocket.
// Protocol details follow the hass-dreo Home Assistant integration (github.com/JeffSteinbok/hass-dreo).
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const CLIENT_ID = "7de37c362ee54dcf9c4561812309347a";
const CLIENT_SECRET = "32dfa0764f25451d99f94e1693498791";
const HIMEI = "faede31549d649f58864093158787ec9";
const PING_MS = 15_000;

/** The harness points these at a fake server. */
const API_OVERRIDE = process.env.DREO_API_BASE;
const WS_OVERRIDE = process.env.DREO_WS_BASE;

export const hashPassword = (pw: string) => createHash("md5").update(pw).digest("hex");

export type Kind = "circulator" | "tower" | "ceiling" | "other";
export type Range = [number, number];

/** What a fan can do, worked out from its model and the keys its state reports. */
export interface Caps {
	powerKey: string;
	speed: Range | null;
	/** "oscmode" = bit flags (1 horizontal, 2 vertical); "hvosc" = hoscon/voscon; "single" = one on/off key */
	osc: { type: "oscmode" | "hvosc" | "single"; key?: string; vertical: boolean } | null;
	/** "fixedconf" = absolute vertical+horizontal; "hangleadj" = absolute horizontal only */
	aim: "fixedconf" | "hangleadj" | null;
	/** relative ±5° steps (hoscadj / voscadj) */
	nudge: { h: boolean; v: boolean };
	hRange: Range;
	vRange: Range;
}

export interface Fan {
	sn: string;
	name: string;
	model: string;
	kind: Kind;
	online: boolean;
	state: Record<string, unknown>;
	caps: Caps;
	/** raw controlsConf from the device list, used for ranges */
	conf: Record<string, unknown>;
}

export interface FanSummary {
	sn: string;
	name: string;
	model: string;
	kind: Kind;
	online: boolean;
	caps: Caps;
}

export type AccountState = "SIGNED_OUT" | "SIGNING_IN" | "READY" | "ERROR";

// Speed / angle ranges hass-dreo knows per model (used when the cloud's controlsConf doesn't say).
const MODEL_SPEED: [string, number][] = [
	["DR-HTF017S", 4], ["DR-HTF021", 12], ["DR-HTF007S", 8], ["DR-HTF", 9],
	["DR-HAF004S", 9], ["DR-HAF008S", 9], ["DR-HAF", 4],
	["DR-HPF015S", 12], ["DR-HPF017S", 12], ["DR-HPF007S", 10], ["DR-HPF005S", 10], ["DR-HPF", 9],
	["DR-HCF", 12],
];
const MODEL_H: [string, Range][] = [
	["DR-HPF015S", [-75, 75]], ["DR-HPF017S", [-75, 75]], ["DR-HPF007S", [-75, 75]], ["DR-HPF004S", [-75, 75]],
	["DR-HPF", [-60, 60]], ["DR-HAF", [-60, 60]],
];
const MODEL_V: [string, Range][] = [["DR-HPF015S", [0, 90]], ["DR-HPF", [-30, 90]], ["DR-HAF", [-30, 90]]];
const byModel = <T>(table: [string, T][], model: string): T | undefined => table.find(([p]) => model.startsWith(p))?.[1];

function kindOf(model: string, productName: string): Kind {
	if (model.startsWith("DR-HTF")) return "tower";
	if (model.startsWith("DR-HAF") || model.startsWith("DR-HPF")) return "circulator";
	if (model.startsWith("DR-HCF")) return "ceiling";
	const p = productName.toLowerCase();
	if (p.includes("tower")) return "tower";
	if (p.includes("circulator")) return "circulator";
	if (p.includes("ceiling")) return "ceiling";
	return "other";
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function speedFromConf(conf: Record<string, unknown>): Range | null {
	const nodes: unknown[] = [];
	for (const ex of (conf.extraConfigs as unknown[]) ?? []) if (obj(ex).key === "control") nodes.push(...((obj(ex).value as unknown[]) ?? []));
	nodes.push(...((conf.control as unknown[]) ?? []));
	for (const n of nodes) {
		const item = obj(n);
		const items = item.items as unknown[] | undefined;
		if (item.type === "Speed" && Array.isArray(items) && items.length >= 2) {
			const lo = Number(obj(items[0]).value);
			const hi = Number(obj(items[1]).value);
			if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
		}
	}
	return null;
}

function angleFromConf(conf: Record<string, unknown>, dir: "hor" | "ver"): Range | null {
	const fixed = obj(obj(conf.swingAngle).fixedAngle);
	const angle = Number(fixed[`${dir}Angle`]);
	const zero = Number(fixed[`${dir}ZeroAngle`]);
	if (!Number.isFinite(angle) || !Number.isFinite(zero) || angle <= 0) return null;
	return [-zero, angle - zero];
}

export function capsFor(fan: Pick<Fan, "model" | "kind" | "state" | "conf">): Caps {
	const s = fan.state;
	const has = (k: string) => s[k] !== undefined && s[k] !== null;
	const powerKey = has("poweron") ? "poweron" : has("fanon") ? "fanon" : "poweron";
	const maxSpeed = byModel(MODEL_SPEED, fan.model);
	const speed = speedFromConf(fan.conf) ?? (maxSpeed ? ([1, maxSpeed] as Range) : has("windlevel") ? ([1, 9] as Range) : null);

	let osc: Caps["osc"] = null;
	if (has("oscmode")) osc = { type: "oscmode", vertical: fan.kind === "circulator" && (has("fixedconf") || has("voscadj") || has("cruiseconf")) };
	else if (has("hoscon")) osc = { type: "hvosc", vertical: has("voscon") };
	else if (has("shakehorizon")) osc = { type: "single", key: "shakehorizon", vertical: false };
	else if (has("oscon")) osc = { type: "single", key: "oscon", vertical: false };

	const aim: Caps["aim"] = has("fixedconf") ? "fixedconf" : has("hangleadj") ? "hangleadj" : null;
	return {
		powerKey,
		speed,
		osc,
		aim,
		nudge: { h: has("hoscadj"), v: has("voscadj") },
		hRange: angleFromConf(fan.conf, "hor") ?? byModel(MODEL_H, fan.model) ?? [-60, 60],
		vRange: angleFromConf(fan.conf, "ver") ?? byModel(MODEL_V, fan.model) ?? [-30, 90],
	};
}

/** fixedconf is "vertical,horizontal". */
export function parseFixed(v: unknown): { v: number; h: number } | null {
	if (typeof v !== "string") return null;
	const [a, b] = v.split(",").map((x) => Number(x.trim()));
	return Number.isFinite(a) && Number.isFinite(b) ? { v: a, h: b } : null;
}

export class DreoCloud extends EventEmitter {
	state: AccountState = "SIGNED_OUT";
	error = "";
	fans = new Map<string, Fan>();

	private email = "";
	private hash = "";
	private token = "";
	private region = "us";
	private ws?: WebSocket;
	private ping?: NodeJS.Timeout;
	private retry?: NodeJS.Timeout;
	private retryMs = 2000;
	private gen = 0;
	private signingIn?: Promise<void>;

	private get apiBase() {
		return API_OVERRIDE ?? `https://app-api-${this.region}.dreo-tech.com`;
	}
	private get wsBase() {
		return WS_OVERRIDE ?? `wss://wsb-${this.region}.dreo-tech.com`;
	}

	/** Called whenever global settings change. Signs in again only if the account actually changed. */
	configure(email: string, passwordHash: string): void {
		email = email.trim();
		if (email === this.email && passwordHash === this.hash && this.state !== "SIGNED_OUT") return;
		this.email = email;
		this.hash = passwordHash;
		this.token = "";
		this.stop();
		this.fans.clear();
		if (!email || !passwordHash) {
			this.setState("SIGNED_OUT", "");
			return;
		}
		void this.signIn();
	}

	/** Re-read the device list and every fan's state (PI "Refresh" button, or after a reconnect). */
	refresh(): Promise<void> {
		if (!this.email || !this.hash) return Promise.resolve();
		return this.token ? this.loadDevices().catch((e) => this.fail(e)) : this.signIn();
	}

	summaries(): FanSummary[] {
		return [...this.fans.values()].map(({ sn, name, model, kind, online, caps }) => ({ sn, name, model, kind, online, caps }));
	}

	signIn(): Promise<void> {
		if (this.signingIn) return this.signingIn;
		const gen = ++this.gen;
		this.setState("SIGNING_IN", "");
		this.signingIn = (async () => {
			try {
				await this.login();
				if (gen !== this.gen) return;
				await this.loadDevices();
				if (gen !== this.gen) return;
				this.setState("READY", "");
				this.connect();
			} catch (e) {
				if (gen === this.gen) this.fail(e);
			} finally {
				this.signingIn = undefined;
			}
		})();
		return this.signingIn;
	}

	stop(): void {
		this.gen++;
		clearTimeout(this.retry);
		clearInterval(this.ping);
		const ws = this.ws;
		this.ws = undefined;
		if (ws) {
			ws.removeAllListeners();
			ws.on("error", () => {});
			ws.terminate();
		}
	}

	/** Send a control command. Several keys in one call go out in one message, which matters for e.g.
	 *  power-on + speed: a fan that's switched on restores its old speed and would ignore a separate one. */
	control(sn: string, params: Record<string, unknown>): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify({ devicesn: sn, method: "control", params, timestamp: String(Date.now()) }));
		return true;
	}

	// ---------------------------------------------------------------- REST

	private headers(): Record<string, string> {
		const h: Record<string, string> = { ua: "dreo/2.8.2", lang: "en", "content-type": "application/json; charset=UTF-8", "user-agent": "okhttp/4.9.1" };
		if (this.token) h.authorization = `Bearer ${this.token}`;
		return h;
	}

	private async api(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const url = new URL(this.apiBase + path);
		if (method === "GET") for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v));
		url.searchParams.set("timestamp", String(Date.now()));
		const res = await fetch(url, {
			method,
			headers: this.headers(),
			body: method === "POST" ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(20_000),
		});
		if (res.status === 401) throw new AuthError("Session expired");
		const json = obj(await res.json().catch(() => ({})));
		if (json.code !== 0) {
			const msg = String(json.msg ?? `HTTP ${res.status}`);
			throw /password|account|user|email|credential/i.test(msg) ? new AuthError(msg) : new Error(msg);
		}
		return obj(json.data);
	}

	private async login(): Promise<void> {
		this.token = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const data = await this.api("POST", "/api/oauth/login", {
				acceptLanguage: "en",
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				email: this.email,
				encrypt: "ciphertext",
				grant_type: "email-password",
				himei: HIMEI,
				password: this.hash,
				scope: "all",
			});
			// Accounts live in one region; the US server tells EU accounts to go to the EU server.
			const region = String(data.region ?? "NA").toUpperCase() === "EU" ? "eu" : "us";
			if (region !== this.region && !API_OVERRIDE) {
				this.region = region;
				continue;
			}
			this.token = String(data.access_token ?? "");
			if (!this.token) throw new Error("No access token in login reply");
			return;
		}
		throw new Error("Region redirect loop");
	}

	private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (!(e instanceof AuthError) || !this.email) throw e;
			await this.login();
			return fn();
		}
	}

	private async loadDevices(): Promise<void> {
		const data = await this.withAuth(() =>
			this.api("GET", "/api/v2/user-device/device/list", { acceptLanguage: "en", method: "devices", pageNo: 1, pageSize: 100 }),
		);
		const list = Array.isArray(data.list) ? data.list.map(obj) : [];
		const seen = new Set<string>();
		for (const d of list) {
			const sn = String(d.sn ?? "");
			const model = String(d.model ?? "");
			const kind = kindOf(model, String(d.productName ?? ""));
			// Only fans: Dreo also sells heaters, purifiers, humidifiers, ACs…
			if (!sn || kind === "other") continue;
			seen.add(sn);
			const prev = this.fans.get(sn);
			const fan: Fan = {
				sn,
				model,
				kind,
				name: String(d.deviceName ?? model),
				online: prev?.online ?? true,
				state: prev?.state ?? {},
				conf: obj(d.controlsConf),
				caps: prev?.caps ?? capsFor({ model, kind, state: {}, conf: {} }),
			};
			this.fans.set(sn, fan);
		}
		for (const sn of [...this.fans.keys()]) if (!seen.has(sn)) this.fans.delete(sn);
		await Promise.all([...this.fans.values()].map((f) => this.loadState(f).catch(() => {})));
		this.emit("devices");
	}

	private async loadState(fan: Fan): Promise<void> {
		const data = await this.withAuth(() => this.api("GET", "/api/user-device/device/state", { acceptLanguage: "en", deviceSn: fan.sn }));
		const mixed = obj(data.mixed);
		const state: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(mixed)) state[k] = v && typeof v === "object" && "state" in v ? (v as { state: unknown }).state : v;
		fan.state = state;
		if (typeof state.connected === "boolean") fan.online = state.connected;
		fan.caps = capsFor(fan);
		this.emit("update", fan);
	}

	// ---------------------------------------------------------------- WebSocket

	private connect(): void {
		const gen = this.gen;
		const ws = new WebSocket(`${this.wsBase}/websocket?accessToken=${encodeURIComponent(this.token)}&timestamp=${Date.now()}`);
		this.ws = ws;
		ws.on("open", () => {
			if (gen !== this.gen) return;
			this.retryMs = 2000;
			this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("2"), PING_MS);
			this.emit("connection", true);
		});
		ws.on("message", (raw) => {
			let msg: Record<string, unknown>;
			try {
				msg = obj(JSON.parse(String(raw)));
			} catch {
				return; // keep-alive replies aren't JSON
			}
			this.onMessage(msg);
		});
		ws.on("error", () => {});
		ws.on("close", () => {
			clearInterval(this.ping);
			if (gen !== this.gen) return;
			this.ws = undefined;
			this.emit("connection", false);
			this.retry = setTimeout(() => {
				if (gen !== this.gen) return;
				// The token may have expired: sign in again, which also reloads every fan's state.
				this.signingIn = undefined;
				void this.signIn();
			}, this.retryMs);
			this.retryMs = Math.min(this.retryMs * 2, 60_000);
		});
	}

	private onMessage(msg: Record<string, unknown>): void {
		const fan = this.fans.get(String(msg.devicesn ?? ""));
		if (!fan) return;
		const method = String(msg.method ?? "");
		if (method === "device-offline") {
			fan.online = false;
			this.emit("update", fan);
			return;
		}
		if (method === "device-online") fan.online = true;
		// control-reply only echoes what the server accepted, not what the fan did: ignore it.
		if (!["report", "control-report", "device-online"].includes(method)) return;
		const reported = obj(msg.reported);
		Object.assign(fan.state, reported);
		if (typeof reported.connected === "boolean") fan.online = reported.connected;
		fan.caps = capsFor(fan);
		this.emit("update", fan);
	}

	private fail(e: unknown): void {
		const err = e as Error;
		const auth = err instanceof AuthError;
		this.setState("ERROR", auth ? `Sign-in failed: ${err.message}` : `Can't reach Dreo: ${err.message}`);
		if (auth) return; // wrong password: wait for new settings rather than hammering the login endpoint
		clearTimeout(this.retry);
		const gen = this.gen;
		this.retry = setTimeout(() => gen === this.gen && void this.signIn(), this.retryMs);
		this.retryMs = Math.min(this.retryMs * 2, 60_000);
	}

	private setState(s: AccountState, error: string): void {
		this.state = s;
		this.error = error;
		this.emit("account");
	}
}

class AuthError extends Error {}

export const cloud = new DreoCloud();
cloud.setMaxListeners(0);
