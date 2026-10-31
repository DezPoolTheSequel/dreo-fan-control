// Fan operations on top of the raw cloud protocol: reading power/speed/oscillation/aim, and sending the
// right keys for each fan type.
import { cloud, parseFixed, type Fan } from "./dreo.js";

const clamp = (n: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, n));

// Values we've just sent but the fan hasn't confirmed yet. Lets fast repeated presses (speed up, up, up)
// build on each other instead of all starting from the last reported value.
const PENDING_MS = 3000;
const pending = new Map<string, { value: unknown; until: number }>();
const pkey = (fan: Fan, key: string) => `${fan.sn}|${key}`;

function read(fan: Fan, key: string): unknown {
	const p = pending.get(pkey(fan, key));
	if (p && p.until > Date.now() && p.value !== fan.state[key]) return p.value;
	pending.delete(pkey(fan, key));
	return fan.state[key];
}

function send(fan: Fan, params: Record<string, unknown>): boolean {
	const ok = cloud.control(fan.sn, params);
	if (ok) for (const [k, v] of Object.entries(params)) pending.set(pkey(fan, k), { value: v, until: Date.now() + PENDING_MS });
	if (ok) cloud.emit("update", fan); // redraw with the pending value straight away
	return ok;
}

export const isOn = (fan: Fan) => read(fan, fan.caps.powerKey) === true;

export function speedOf(fan: Fan): number | null {
	const v = Number(read(fan, "windlevel"));
	return Number.isFinite(v) && v > 0 ? v : null;
}

export function oscOf(fan: Fan): { h: boolean; v: boolean } {
	const o = fan.caps.osc;
	if (!o) return { h: false, v: false };
	if (o.type === "oscmode") {
		const m = Number(read(fan, "oscmode")) || 0;
		return { h: (m & 1) !== 0, v: (m & 2) !== 0 };
	}
	if (o.type === "hvosc") return { h: read(fan, "hoscon") === true, v: read(fan, "voscon") === true };
	return { h: read(fan, o.key!) === true, v: false };
}

/** Current aim, if the fan reports one. */
export function aimOf(fan: Fan): { h: number; v: number } | null {
	if (fan.caps.aim === "fixedconf") return parseFixed(read(fan, "fixedconf"));
	if (fan.caps.aim === "hangleadj") {
		const h = Number(read(fan, "hangleadj"));
		return Number.isFinite(h) ? { h, v: 0 } : null;
	}
	return null;
}

export function setPower(fan: Fan, on: boolean): boolean {
	return send(fan, { [fan.caps.powerKey]: on });
}

export function setSpeed(fan: Fan, speed: number, autoOn: boolean): boolean {
	if (!fan.caps.speed) return false;
	const params: Record<string, unknown> = { windlevel: clamp(Math.round(speed), fan.caps.speed) };
	// Power-on and speed must go in the same message, or the fan restores its old speed on power-up.
	if (autoOn && !isOn(fan)) params[fan.caps.powerKey] = true;
	return send(fan, params);
}

export function stepSpeed(fan: Fan, delta: number, autoOn: boolean): boolean {
	if (!fan.caps.speed) return false;
	const cur = speedOf(fan) ?? fan.caps.speed[0];
	// Speed down on a fan that's off does nothing; speed up on a fan that's off turns it on at its current speed + 1.
	if (!isOn(fan) && delta < 0) return true;
	return setSpeed(fan, cur + delta, autoOn);
}

export function setOsc(fan: Fan, axis: "h" | "v" | "both", on: boolean): boolean {
	const o = fan.caps.osc;
	if (!o) return false;
	const want = { ...oscOf(fan) };
	if (axis !== "v") want.h = on;
	if (axis !== "h" && o.vertical) want.v = on;
	if (o.type === "oscmode") return send(fan, { oscmode: (want.h ? 1 : 0) | (want.v ? 2 : 0) });
	if (o.type === "hvosc") return send(fan, o.vertical ? { hoscon: want.h, voscon: want.v } : { hoscon: want.h });
	return send(fan, { [o.key!]: want.h });
}

export function toggleOsc(fan: Fan, axis: "h" | "v" | "both"): boolean {
	const cur = oscOf(fan);
	const active = axis === "h" ? cur.h : axis === "v" ? cur.v : cur.h || cur.v;
	return setOsc(fan, axis, !active);
}

const aimTimers = new Map<string, NodeJS.Timeout>();

/** Point the fan at a fixed position. Oscillation is switched off first, since the fan ignores a fixed
 *  position while it's sweeping. */
export function aimAt(fan: Fan, h: number, v: number): boolean {
	const aim = fan.caps.aim;
	if (!aim) return false;
	h = clamp(h, fan.caps.hRange);
	v = clamp(v, fan.caps.vRange);
	const go = () => (aim === "fixedconf" ? send(fan, { fixedconf: `${v},${h}` }) : send(fan, { hangleadj: h }));
	clearTimeout(aimTimers.get(fan.sn));
	const osc = oscOf(fan);
	if (osc.h || osc.v) {
		if (!setOsc(fan, "both", false)) return false;
		aimTimers.set(fan.sn, setTimeout(go, 800));
		return true;
	}
	return go();
}

export function nudge(fan: Fan, dir: "left" | "right" | "up" | "down", step: number): boolean {
	const vertical = dir === "up" || dir === "down";
	const sign = dir === "right" || dir === "up" ? 1 : -1;
	const cur = aimOf(fan);
	if (cur && (fan.caps.aim === "fixedconf" || !vertical)) {
		return aimAt(fan, vertical ? cur.h : cur.h + sign * step, vertical ? cur.v + sign * step : cur.v);
	}
	// Fans without an absolute position move in fixed 5° steps.
	if (vertical ? fan.caps.nudge.v : fan.caps.nudge.h) {
		const key = vertical ? "voscadj" : "hoscadj";
		let ok = true;
		for (let i = 0; i < Math.max(1, Math.round(step / 5)); i++) ok = cloud.control(fan.sn, { [key]: sign * 5 }) && ok;
		return ok;
	}
	return false;
}

export const canNudge = (fan: Fan, dir: "left" | "right" | "up" | "down") => {
	const vertical = dir === "up" || dir === "down";
	return fan.caps.aim === "fixedconf" || (!vertical && fan.caps.aim === "hangleadj") || (vertical ? fan.caps.nudge.v : fan.caps.nudge.h);
};
