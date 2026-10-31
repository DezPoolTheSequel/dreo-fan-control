# Dreo Fan Control

A Stream Deck plugin for **Dreo smart fans**. Turn them on and off, change the speed, switch
oscillation on and off, and **aim the fan at a saved spot** (a horizontal and vertical angle) with one
key press. Each key shows the fan's live state.

## Actions

| Action | What a press does | What the key shows |
| --- | --- | --- |
| **Power** | Toggle, or always on / always off | Fan icon, ON · speed or OFF |
| **Speed** | Speed up, speed down (step size you choose), or set an exact speed | Current speed and a bar with one segment per level |
| **Aim** | Go to a position (horizontal + vertical angle), or nudge left / right / up / down by N° | A map of the fan's range: the dot is the target, the ring is where it points now. The key lights up when the fan is there. |
| **Oscillate** | Toggle / on / off for side-to-side, up-and-down, or both | Sweep arrows, lit while oscillating |
| **Fan Dial** (Stream Deck +) | Turn right = faster, left = slower (or aim 5° a click). Push and touch each do whichever you choose: **toggle on/off** or **switch to the next fan** | Fan name, speed and a fan icon in the fan's colour on the touch strip |

Every action works with **any of your fans**. Pick the fan in each key's settings, so with two fans
you can set up one row per fan or put both on one key with a Multi Action.

### Fan Dial (Stream Deck +)

Drag **Fan Dial** onto a dial. Stream Deck only offers it on dials, and the key actions only on keys,
so it's all one plugin.

- **Turn:** right speeds up, left slows down. Turning right on a fan that's off switches it on. You
  can also set turning to aim the fan left/right or up/down instead.
- **Push** and **Touch:** each one can be **Toggle on / off** or **Switch to next fan**. The default
  is push = power, touch = next fan.
- **Next fan** goes through every fan on your account in name order and wraps around. The touch strip
  shows which one the dial is on (`Tall Fan  1/2`) in that fan's colour, and the dial remembers
  its fan after a restart.

### Fan colours

Each fan can have its own "on" colour: sky blue, teal, green, purple, pink, orange, red or gold.
Pick it under **On colour** in any key's settings. The colour belongs to the fan, so every key for
that fan (and its Stream Deck + dial) changes together, whichever key you set it from. Keys for a fan
that's off, or for something that isn't active, stay grey.

### Aim presets

In the Aim key's settings, choose **Go to a position** and then either:

- pick from **Quick pick**: Center, Left/Right 30° or 60°, Tilt up 30° or 60°, Straight up, Tilt down, or
- type a **Horizontal** and **Vertical** angle (the panel shows your fan's range), or
- point the fan where you want it with the Dreo app or the remote, then click **Use where the fan
  points now**. This is the easiest way to save spots like "desk" or "bed".

If the fan is oscillating when you press an Aim key, the plugin turns oscillation off first, because
the fan ignores a fixed position while it's sweeping.

## Which fans work

The plugin uses the same Dreo cloud the phone app uses, so it works with any fan that's set up in
the Dreo app. Different fan types have different features:

| Fan type | Power / speed | Oscillate | Aim at a position |
| --- | --- | --- | --- |
| Air circulators with 3D / vertical tilt (DR-HPF…, DR-HAF004S, …) | ✅ | ↔ and ↕ | ✅ horizontal + vertical |
| Air circulators with horizontal-only adjust | ✅ | ↔ | ✅ horizontal only |
| Tower fans (DR-HTF…) | ✅ | ↔ on/off | ❌ (towers don't have a fixed-position setting) |
| Ceiling fans (DR-HCF…) | ✅ | – | ❌ |

The settings panel says what the selected fan supports, and keys for something it can't do show
`NO AIMING` or `NO SWEEP`. Heaters, purifiers and other Dreo devices on the account are left out of
the fan list.

## Setup

1. Install the plugin (below) and drag any **Dreo Fan Control** action onto a key.
2. In the key's settings, enter the **email and password you use in the Dreo app** and click
   **Sign in**. You only do this once; every key shares the login.
3. Pick a **Fan** from the list, then set up what the key does.

Use the **▶ Test this key** button at the bottom of the panel to try it without leaving the settings.

**About your password:** the plugin only stores an MD5 hash of it (that's what Dreo's login takes),
in the plugin's global settings. It's never stored as plain text and isn't included in exported
profiles. You can sign out from any key's settings.

## Requirements

- Stream Deck 6.6+
- Windows 10+ or macOS 12+
- Fans set up in the Dreo app, and an internet connection (Dreo fans are controlled through Dreo's cloud;
  they have no local API)
- [Node.js](https://nodejs.org/) 20+ (only for building from source)

## Install (prebuilt)

Download `com.dez.dreofan.streamDeckPlugin` from the
[latest release](https://github.com/DezPoolTheSequel/dreo-fan-control/releases/latest) and
double-click it. The actions are listed under **Dreo Fan Control**.

## Build from source

```sh
git clone https://github.com/DezPoolTheSequel/dreo-fan-control.git
cd dreo-fan-control
npm install
npm run build
npx streamdeck dev
npx streamdeck link com.dez.dreofan.sdPlugin
```

> If you already installed the packaged `.streamDeckPlugin`, uninstall it in Stream Deck first.
> The linked dev copy and the installed copy share the same UUID.

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `com.dez.dreofan.sdPlugin/bin/plugin.js` |
| `npm run watch` | Rebuild when a file is saved and restart the plugin |
| `npm run typecheck` | TypeScript check |
| `npm run pack` | Build and package `dist/com.dez.dreofan.streamDeckPlugin` |
| `npm run icons` | Regenerate the PNG icons |
| `npm run test:render` | Run the plugin against a fake Stream Deck and a fake Dreo cloud, check the commands sent for each key press, and render every key to `tools/out/` |

## How it works

- `src/dreo.ts`: the Dreo cloud client. It signs in (`app-api-us.dreo-tech.com`, or the EU server
  for EU accounts), reads the device list and each fan's state over REST, then keeps one WebSocket
  open (`wsb-us.dreo-tech.com`) for live state reports and for sending commands. It also works out what
  each fan can do from its model and the state keys it reports.
- `src/control.ts`: fan operations: power, speed, oscillation (`oscmode` bit flags, `hoscon`/`voscon`,
  or `shakehorizon` depending on the fan) and aim (`fixedconf` = "vertical,horizontal", or `hangleadj`).
  Commands that have just been sent count as the current value for a few seconds, so pressing speed-up
  three times quickly goes up three steps.
- `src/render.ts`: draws the 144×144 SVG key images.
- `src/actions.ts`: the five actions and the settings-panel messages.
- `com.dez.dreofan.sdPlugin/ui/fan.html`: the settings panel (plain HTML/JS), shared by all actions.

The protocol details come from the [hass-dreo](https://github.com/JeffSteinbok/hass-dreo) Home
Assistant integration.

## Troubleshooting

- **`SIGN IN`**: no account entered yet. Open any key's settings.
- **`DREO ERROR` / check login**: Dreo rejected the email or password. Sign in again from the settings.
  If you normally log in to the Dreo app with Google or Apple, set a password for your Dreo account
  in the app first.
- **`OFFLINE`**: Dreo says the fan isn't connected. Check that it shows as online in the Dreo app.
- **Left and right are swapped on Aim presets**: fans don't all use the same sign for the
  horizontal angle. Use **Use where the fan points now** to save positions, or flip the sign of the
  number.
- **New fan doesn't show up**: click ⟳ next to the fan list.

## License

Do whatever you want with it.
