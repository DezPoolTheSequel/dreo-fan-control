import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type PropertyInspectorDidDisappearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TitleParametersDidChangeEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { aimAt, aimOf, canNudge, isOn, nudge, oscOf, setPower, setSpeed, speedOf, stepSpeed, toggleOsc, setOsc } from "./control.js";
import { cloud, hashPassword, type Fan } from "./dreo.js";
import { colorFor, COLORS, fanGlyph, renderAim, renderMessage, renderNudge, renderOsc, renderPower, renderSpeed, THEMES, toDataUrl, type View } from "./render.js";
import { resolveSettings, type ActionSettings, type GlobalSettings } from "./settings.js";

const log = () => streamDeck.logger.createScope("dreo");

// ---------------------------------------------------------------- account

let account: GlobalSettings = {};
/** Keys redraw when a fan's colour changes, since that colour is shared by every key for the fan. */
const colorListeners = new Set<() => void>();

export function setAccount(g: Partial<GlobalSettings> | undefined): void {
	const colors = g?.fanColors && typeof g.fanColors === "object" ? { ...g.fanColors } : {};
	const changed = JSON.stringify(colors) !== JSON.stringify(account.fanColors ?? {});
	account = { email: String(g?.email ?? ""), passwordHash: String(g?.passwordHash ?? ""), fanColors: colors };
	cloud.configure(account.email!, account.passwordHash!);
	if (changed) for (const fn of colorListeners) fn();
}

const saveGlobals = () => streamDeck.settings.setGlobalSettings(account as JsonObject);

async function signIn(email: string, password: string): Promise<void> {
	// Keep the stored hash if the PI sends a blank password (user only edited the email).
	const passwordHash = password ? hashPassword(password) : (account.passwordHash ?? "");
	account = { ...account, email: email.trim(), passwordHash };
	await saveGlobals();
	cloud.configure(account.email!, passwordHash);
	void cloud.signIn();
}

async function signOut(): Promise<void> {
	// Fan colours aren't part of the login, so they stay.
	account = { fanColors: account.fanColors };
	await saveGlobals();
	cloud.configure("", "");
}

async function setFanColor(sn: string, color: string): Promise<void> {
	if (!sn || !COLORS[color]) return;
	account = { ...account, fanColors: { ...account.fanColors, [sn]: color } };
	await saveGlobals();
	for (const fn of colorListeners) fn();
}

export const fanTheme = (sn: string) => colorFor(account.fanColors?.[sn]);

// ---------------------------------------------------------------- shared base

interface Instance {
	action: KeyAction<JsonObject> | DialAction<JsonObject>;
	settings: ActionSettings;
	lastImage?: string;
	lastFeedback?: string;
	/** dial ticks waiting to be sent */
	ticks: number;
	tickTimer?: NodeJS.Timeout;
}

abstract class FanAction extends SingletonAction<JsonObject> {
	protected items = new Map<string, Instance>();
	private piActionId?: string;

	constructor() {
		super();
		cloud.on("update", (fan: Fan) => {
			for (const it of this.items.values()) if (it.settings.fan === fan.sn) void this.redraw(it);
		});
		for (const ev of ["account", "devices"]) cloud.on(ev, () => this.redrawAll());
		colorListeners.add(() => this.redrawAll());
	}

	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		const it: Instance = { action: ev.action as Instance["action"], settings: resolveSettings(ev.payload.settings), ticks: 0 };
		this.items.set(ev.action.id, it);
		if (ev.action.isKey()) await ev.action.setTitle("");
		await this.redraw(it);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		this.items.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		it.settings = resolveSettings(ev.payload.settings);
		await this.redraw(it);
		await this.sendToPI(it);
	}

	override async onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<JsonObject>): Promise<void> {
		// The name is drawn inside the image; a Stream Deck title would sit on top of it.
		if (ev.action.isKey() && ev.payload.title) await ev.action.setTitle("");
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		const fan = this.fanFor(it);
		if (!fan || !this.press(it, fan)) await ev.action.showAlert();
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<JsonObject>): void {
		this.piActionId = ev.action.id;
	}

	override onPropertyInspectorDidDisappear(ev: PropertyInspectorDidDisappearEvent<JsonObject>): void {
		if (this.piActionId === ev.action.id) this.piActionId = undefined;
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const msg = (ev.payload ?? {}) as Record<string, string>;
		this.piActionId = ev.action.id;
		const it = this.items.get(ev.action.id);
		if (msg.cmd === "signin") await signIn(msg.email ?? "", msg.password ?? "");
		else if (msg.cmd === "signout") await signOut();
		else if (msg.cmd === "refresh") await cloud.refresh();
		else if (msg.cmd === "color") await setFanColor(msg.fan ?? "", msg.color ?? "");
		else if (msg.cmd === "test" && it) {
			const fan = this.fanFor(it);
			if (!fan || !this.press(it, fan)) await it.action.showAlert();
		}
		if (it) await this.sendToPI(it);
	}

	/** What a key press does. Returns false if it couldn't (the key then shows an alert). */
	protected abstract press(it: Instance, fan: Fan): boolean;
	/** The key image for a fan that's online and ready. */
	protected abstract image(it: Instance, fan: Fan, view: View): string;

	protected fanFor(it: Instance): Fan | undefined {
		if (cloud.state !== "READY") return undefined;
		const fan = cloud.fans.get(it.settings.fan);
		return fan?.online ? fan : undefined;
	}

	private redrawAll(): void {
		for (const it of this.items.values()) {
			void this.redraw(it);
			void this.sendToPI(it);
		}
	}

	protected async redraw(it: Instance): Promise<void> {
		if (!this.items.has(it.action.id)) return;
		try {
			if (it.action.isDial()) return await this.drawDial(it);
			const img = toDataUrl(this.keyImage(it));
			if (img === it.lastImage) return;
			it.lastImage = img;
			await it.action.setImage(img);
		} catch (e) {
			log().warn(`draw failed: ${(e as Error).message}`);
		}
	}

	private keyImage(it: Instance): string {
		const fan = cloud.fans.get(it.settings.fan);
		const view: View = { label: it.settings.label || fan?.name || "Dreo", showLabel: it.settings.showLabel, theme: fanTheme(it.settings.fan) };
		if (cloud.state === "SIGNED_OUT") return renderMessage(view, "SIGN IN", "in key settings", THEMES.warn);
		if (cloud.state === "SIGNING_IN" && !fan) return renderMessage(view, "CONNECTING", "to Dreo…");
		if (cloud.state === "ERROR") return renderMessage(view, "DREO ERROR", cloud.error.startsWith("Sign-in") ? "check login" : "retrying…", THEMES.warn);
		if (!it.settings.fan) return renderMessage(view, "PICK A FAN", "in key settings", THEMES.warn);
		if (!fan) return renderMessage(view, "FAN NOT FOUND");
		if (!fan.online) return renderMessage(view, "OFFLINE");
		return this.image(it, fan, view);
	}

	protected async drawDial(_it: Instance): Promise<void> {}

	protected async sendToPI(it: Instance): Promise<void> {
		if (this.piActionId !== it.action.id) return;
		const fan = cloud.fans.get(it.settings.fan);
		const live = fan
			? { online: fan.online, on: isOn(fan), speed: speedOf(fan), aim: aimOf(fan), osc: oscOf(fan), caps: fan.caps }
			: null;
		try {
			await streamDeck.ui.sendToPropertyInspector({
				event: "state",
				account: { state: cloud.state, error: cloud.error, email: account.email ?? "", hasPassword: !!account.passwordHash },
				fans: cloud.summaries(),
				live,
				color: account.fanColors?.[it.settings.fan] ?? "blue",
				colors: Object.entries(COLORS).map(([id, c]) => ({ id, name: c.name, accent: c.accent, bg: c.bg1 })),
			} as unknown as JsonValue);
		} catch {
			/* PI closed */
		}
	}
}

// ---------------------------------------------------------------- actions

@action({ UUID: "com.dez.dreofan.power" })
export class PowerAction extends FanAction {
	protected press(it: Instance, fan: Fan): boolean {
		const on = it.settings.mode === "on" ? true : it.settings.mode === "off" ? false : !isOn(fan);
		return setPower(fan, on);
	}
	protected image(it: Instance, fan: Fan, view: View): string {
		return renderPower(view, isOn(fan), speedOf(fan), fan.caps.speed?.[1] ?? null, it.settings.mode);
	}
}

@action({ UUID: "com.dez.dreofan.speed" })
export class SpeedAction extends FanAction {
	protected press(it: Instance, fan: Fan): boolean {
		const s = it.settings;
		if (s.speedMode === "set") return setSpeed(fan, s.speed, true);
		return stepSpeed(fan, s.speedMode === "up" ? s.step : -s.step, s.autoOn);
	}
	protected image(it: Instance, fan: Fan, view: View): string {
		const max = fan.caps.speed?.[1] ?? 9;
		return renderSpeed(view, isOn(fan), speedOf(fan), max, it.settings.speedMode, Math.min(max, Math.max(1, it.settings.speed)));
	}
}

@action({ UUID: "com.dez.dreofan.aim" })
export class AimAction extends FanAction {
	protected press(it: Instance, fan: Fan): boolean {
		const s = it.settings;
		if (s.aimMode === "nudge") return nudge(fan, s.direction, s.nudge);
		return aimAt(fan, s.h, s.v);
	}
	protected image(it: Instance, fan: Fan, view: View): string {
		const s = it.settings;
		if (s.aimMode === "nudge") {
			const ok = canNudge(fan, s.direction);
			return renderNudge(view, s.direction, s.nudge, ok ? "" : "NOT SUPPORTED", isOn(fan));
		}
		if (!fan.caps.aim) return renderMessage(view, "NO AIMING", fan.model);
		const horizontalOnly = fan.caps.aim === "hangleadj";
		const current = aimOf(fan);
		const osc = oscOf(fan);
		const matched = !!current && !osc.h && !osc.v && current.h === s.h && (horizontalOnly || current.v === s.v);
		const angle = (n: number) => `${n > 0 ? "+" : ""}${n}°`;
		const caption = s.presetName || (horizontalOnly ? `H ${angle(s.h)}` : `H ${angle(s.h)} V ${angle(s.v)}`);
		return renderAim(view, {
			on: isOn(fan),
			hRange: fan.caps.hRange,
			vRange: fan.caps.vRange,
			target: { h: s.h, v: s.v },
			current: osc.h || osc.v ? null : current,
			horizontalOnly,
			caption,
			matched,
		});
	}
}

@action({ UUID: "com.dez.dreofan.oscillate" })
export class OscillateAction extends FanAction {
	protected press(it: Instance, fan: Fan): boolean {
		const { mode, axis } = it.settings;
		return mode === "toggle" ? toggleOsc(fan, axis) : setOsc(fan, axis, mode === "on");
	}
	protected image(it: Instance, fan: Fan, view: View): string {
		if (!fan.caps.osc) return renderMessage(view, "NO SWEEP", fan.model);
		return renderOsc(view, it.settings.axis, oscOf(fan), fan.caps.osc.vertical);
	}
}

/** Stream Deck + dial: turn for speed (or aim). Push and touch each either toggle power or switch the
 *  dial to the next fan on the account. */
@action({ UUID: "com.dez.dreofan.dial" })
export class FanDial extends FanAction {
	protected press(_it: Instance, fan: Fan): boolean {
		return setPower(fan, !isOn(fan));
	}
	protected image(_it: Instance, fan: Fan, view: View): string {
		return renderPower(view, isOn(fan), speedOf(fan), fan.caps.speed?.[1] ?? null, "toggle");
	}

	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		await super.onWillAppear(ev);
		await this.describeTriggers(ev.action.id);
	}
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): Promise<void> {
		await super.onDidReceiveSettings(ev);
		await this.describeTriggers(ev.action.id);
	}

	override async onDialDown(ev: DialDownEvent<JsonObject>): Promise<void> {
		await this.trigger(ev.action.id, "push");
	}
	override async onTouchTap(ev: TouchTapEvent<JsonObject>): Promise<void> {
		await this.trigger(ev.action.id, "touch");
	}

	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		const it = this.items.get(ev.action.id);
		if (!it) return;
		// Collect quick turns into one command so the fan isn't flooded.
		it.ticks += ev.payload.ticks;
		clearTimeout(it.tickTimer);
		it.tickTimer = setTimeout(() => {
			const ticks = it.ticks;
			it.ticks = 0;
			const fan = this.fanFor(it);
			if (!fan) return void it.action.showAlert();
			const r = it.settings.dialRotate;
			let ok: boolean;
			if (r === "speed") ok = stepSpeed(fan, ticks, true);
			else ok = nudge(fan, r === "h" ? (ticks > 0 ? "right" : "left") : ticks > 0 ? "up" : "down", Math.abs(ticks) * 5);
			if (!ok) void it.action.showAlert();
		}, 150);
	}

	private async trigger(id: string, which: "push" | "touch"): Promise<void> {
		const it = this.items.get(id);
		if (!it) return;
		if ((which === "push" ? it.settings.dialPush : it.settings.dialTouch) === "next") return this.nextFan(it);
		const fan = this.fanFor(it);
		if (!fan || !this.press(it, fan)) await it.action.showAlert();
	}

	/** Fans the dial cycles through: every fan on the account, in name order. */
	private cycle(): Fan[] {
		return [...cloud.fans.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sn.localeCompare(b.sn));
	}

	private async nextFan(it: Instance): Promise<void> {
		const fans = this.cycle();
		if (cloud.state !== "READY" || fans.length === 0) return void (await it.action.showAlert());
		const i = fans.findIndex((f) => f.sn === it.settings.fan);
		it.settings = { ...it.settings, fan: fans[(i + 1) % fans.length].sn };
		// Saved, so the dial remembers its fan and the settings panel shows the same one.
		await it.action.setSettings(it.settings as unknown as JsonObject);
		await this.redraw(it);
		await this.sendToPI(it);
	}

	private async describeTriggers(id: string): Promise<void> {
		const it = this.items.get(id);
		if (!it || !it.action.isDial()) return;
		const name = (m: "power" | "next") => (m === "next" ? "Next fan" : "Power on/off");
		await it.action.setTriggerDescription({
			rotate: it.settings.dialRotate === "speed" ? "Speed" : it.settings.dialRotate === "h" ? "Aim left/right" : "Aim up/down",
			push: name(it.settings.dialPush),
			touch: name(it.settings.dialTouch),
		});
	}

	protected override async drawDial(it: Instance): Promise<void> {
		const fan = cloud.fans.get(it.settings.fan);
		const cycling = it.settings.dialPush === "next" || it.settings.dialTouch === "next";
		// When the dial switches fans, a fixed name would be wrong, so show the fan's own name and its place in the list.
		let title = (cycling ? "" : it.settings.label) || fan?.name || "Dreo Fan";
		const fans = this.cycle();
		if (cycling && fan && fans.length > 1) title += `  ${fans.findIndex((f) => f.sn === fan.sn) + 1}/${fans.length}`;
		// The name can only be hidden on a dial that stays on one fan; a switching dial needs it to show which fan it's on.
		if (!cycling && !it.settings.showLabel) title = "";
		const theme = fanTheme(it.settings.fan);
		let value: string;
		let indicator = 0;
		let color = theme.accent;
		let on = false;
		if (cloud.state !== "READY") value = cloud.state === "SIGNED_OUT" ? "Sign in" : cloud.state === "ERROR" ? "Error" : "…";
		else if (!fan) value = it.settings.fan ? "Not found" : cycling ? "Press for a fan" : "Pick a fan";
		else if (!fan.online) value = "Offline";
		else {
			on = isOn(fan);
			const speed = speedOf(fan);
			const max = fan.caps.speed?.[1] ?? 9;
			const r = it.settings.dialRotate;
			const aim = aimOf(fan);
			if (r === "speed" || !aim) {
				value = on ? `${speed ?? "?"}/${max}` : "Off";
				indicator = on && speed ? Math.round((speed / max) * 100) : 0;
			} else {
				const [lo, hi] = r === "h" ? fan.caps.hRange : fan.caps.vRange;
				const a = r === "h" ? aim.h : aim.v;
				value = `${r === "h" ? "H" : "V"} ${a > 0 ? "+" : ""}${a}°${on ? "" : " · off"}`;
				indicator = Math.round(((a - lo) / (hi - lo)) * 100);
			}
		}
		if (!on) color = THEMES.off.dim;
		const icon = toDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${fanGlyph(24, 24, 15, on ? theme.accent : THEMES.off.dim)}</svg>`);
		const fb = { title, value, icon, indicator: { value: indicator, bar_fill_c: color } };
		const json = JSON.stringify(fb);
		if (json === it.lastFeedback) return;
		it.lastFeedback = json;
		await (it.action as DialAction<JsonObject>).setFeedback(fb);
	}
}
