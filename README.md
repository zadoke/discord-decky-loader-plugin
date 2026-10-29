# Discord Deck for Windows

Discord voice controls for Steam Big Picture on Windows, through the unofficial Windows ports of [Decky Loader](https://decky.xyz). Join a voice channel, mute, leave and share your screen with just the controller.

Fork of [brunoccst/discord-decky-loader-plugin](https://github.com/brunoccst/discord-decky-loader-plugin), which is built for the Steam Deck.

It's deliberately simple. It isn't a full Discord client and there are no plans to make it one.

## Features

From the Quick Access Menu (`...` button):

- Sign in by scanning a QR code shown right in the panel.
- Join a voice channel: pick a server, then a channel.
- See the call you're in and who's in it.
- Mute, deafen and leave the call.
- Push to talk on a back button (R4, R5, L4 or L5).
- Share a screen or window into the call (Windows only).
- Open the full Discord page when you need it (not on Windows).
- Check for updates and install them through Decky.

Discord stays connected in the background while you play.

## Install

1. Install Decky: one of the unofficial Windows ports on Windows, or [Decky Loader](https://decky.xyz) on a Steam Deck.
2. In Big Picture (Game Mode on the Deck), open Decky's settings, turn on **Developer mode**, then go to **Developer** › **Install plugin from URL** and enter:

   ```
   https://github.com/zadoke/discord-decky-loader-plugin/releases/latest/download/discord-deck.zip
   ```

3. Open **Discord Deck** from the Quick Access Menu. The first time, scan the QR code it shows with the Discord app on your phone (**Settings** › **Scan QR Code**). You only need to do this once.

If your Steam account uses **Family View**, unlock it first: Discord can't open while Family View is locked, and the plugin tells you when that's the case.

## Windows

Works with the unofficial Windows ports of Decky, in Big Picture mode. Big Picture never shows Discord's hidden page, so the sign-in QR code is drawn in the panel and the **Open Discord** buttons are hidden.

While you're in a call, **Share screen** lets you pick a monitor or window and goes live in the call. Pick 720p30, 1080p30 or 1080p60 first. The first share downloads ffmpeg (about 190 MB). It encodes on the GPU when it can (NVIDIA, AMD or Intel), otherwise on the CPU. Video only for now, no game audio.

## Updates

The plugin checks this repository's GitHub releases when it starts, and has a **Check for updates** button at the bottom of its panel. Updates install through Decky's own installer, which asks you to confirm.

To publish a release, bump `version` in `package.json`, then run the **Release** workflow from the Actions tab with a matching tag such as `v1.0.1` (a hyphen, as in `v1.1.0-beta.1`, marks a pre-release). The repository must stay public, since Decky downloads updates without signing in to GitHub.

## How it works

| Piece | File | Role |
|---|---|---|
| Frontend | `src/` | The Quick Access Menu panel. Creates a hidden Steam browser view for Discord, relays the microphone, and listens for the push-to-talk button. |
| Backend | `main.py` | Connects to the hidden view over Steam's local DevTools endpoint (`127.0.0.1:8080`), loads `discord.com/app`, and passes commands and events between the panel and the page. |
| Bridge | `defaults/bridge.js` | Runs inside the Discord page, reads Discord's own state (user, voice, channels) and triggers Discord's own voice actions. No third-party client mod is used. |
| Screen share | `py_modules/screenshare.py` | Windows only. Captures a screen or window with ffmpeg and sends the video to the bridge, which hands it to Discord's Go Live. |

Discord runs as its regular web app, loaded from discord.com each time the plugin starts. The microphone is captured by the Steam UI and relayed to the page, because Steam's hidden browser views can't open it themselves.

## Development

Requires Node.js 16.14+ and pnpm.

```bash
pnpm i
pnpm run build      # outputs dist/index.js
pnpm run typecheck
```

See the [Decky plugin template](https://github.com/SteamDeckHomebrew/decky-plugin-template) for deploying a development build to a Deck.

## Notes

- This is an unofficial integration, not affiliated with Discord. It uses your own signed-in session and Discord's own web app, but Discord can change its internals at any time and break things.
- The hidden browser view and microphone relay approach is based on [Deckcord](https://github.com/marios8543/Deckcord) by marios8543.

## License

[MIT](LICENSE): anyone can use, copy, change and share it, and it comes with no warranty. The author isn't responsible for anything that happens from using it.
