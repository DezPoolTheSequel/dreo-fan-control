import streamDeck from "@elgato/streamdeck";
import { AimAction, FanDial, OscillateAction, PowerAction, SpeedAction, setAccount } from "./actions.js";
import { cloud } from "./dreo.js";
import type { GlobalSettings } from "./settings.js";

streamDeck.logger.setLevel("info");
// Works on Stream Deck 6.x and 7.x.
streamDeck.settings.useLegacySettingsBehavior = true;
for (const a of [new PowerAction(), new SpeedAction(), new AimAction(), new OscillateAction(), new FanDial()]) streamDeck.actions.registerAction(a);

// The Dreo login lives in global settings, so it's entered once and never ends up in exported profiles.
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => setAccount(ev.settings));
await streamDeck.connect();
setAccount(await streamDeck.settings.getGlobalSettings<GlobalSettings>());

for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => cloud.stop());
