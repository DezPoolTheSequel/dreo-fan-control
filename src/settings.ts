import type { JsonObject } from "@elgato/utils";

/** Plugin-wide settings. Only the MD5 of the password is stored — that's what Dreo's login takes anyway. */
export type GlobalSettings = {
	email?: string;
	passwordHash?: string;
};

export type ActionKind = "power" | "speed" | "aim" | "oscillate" | "dial";

export interface ActionSettings {
	/** fan serial number */
	fan: string;
	/** name drawn on the key; blank = the fan's name in the Dreo app */
	label: string;
	showLabel: boolean;
	// power + oscillate
	mode: "toggle" | "on" | "off";
	// speed
	speedMode: "up" | "down" | "set";
	speed: number;
	step: number;
	autoOn: boolean;
	// aim
	aimMode: "preset" | "nudge";
	h: number;
	v: number;
	presetName: string;
	direction: "left" | "right" | "up" | "down";
	nudge: number;
	// oscillate
	axis: "h" | "v" | "both";
	// dial
	dialRotate: "speed" | "h" | "v";
}

export const DEFAULTS: ActionSettings = {
	fan: "",
	label: "",
	showLabel: true,
	mode: "toggle",
	speedMode: "up",
	speed: 3,
	step: 1,
	autoOn: true,
	aimMode: "preset",
	h: 0,
	v: 0,
	presetName: "",
	direction: "left",
	nudge: 10,
	axis: "h",
	dialRotate: "speed",
};

const num = (v: unknown, d: number) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v: unknown, d: boolean) => (v === undefined ? d : v === true || v === "true");
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

export function resolveSettings(raw: JsonObject | undefined): ActionSettings {
	const r = (raw ?? {}) as Record<string, unknown>;
	return {
		fan: String(r.fan ?? ""),
		label: String(r.label ?? "").trim(),
		showLabel: bool(r.showLabel, DEFAULTS.showLabel),
		mode: pick(r.mode, ["toggle", "on", "off"], DEFAULTS.mode),
		speedMode: pick(r.speedMode, ["up", "down", "set"], DEFAULTS.speedMode),
		speed: Math.round(num(r.speed, DEFAULTS.speed)),
		step: Math.max(1, Math.round(num(r.step, DEFAULTS.step))),
		autoOn: bool(r.autoOn, DEFAULTS.autoOn),
		aimMode: pick(r.aimMode, ["preset", "nudge"], DEFAULTS.aimMode),
		h: Math.round(num(r.h, DEFAULTS.h)),
		v: Math.round(num(r.v, DEFAULTS.v)),
		presetName: String(r.presetName ?? "").trim(),
		direction: pick(r.direction, ["left", "right", "up", "down"], DEFAULTS.direction),
		nudge: Math.max(1, Math.round(num(r.nudge, DEFAULTS.nudge))),
		axis: pick(r.axis, ["h", "v", "both"], DEFAULTS.axis),
		dialRotate: pick(r.dialRotate, ["speed", "h", "v"], DEFAULTS.dialRotate),
	};
}
