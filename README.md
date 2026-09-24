# Twitch Emote No-Restart


Posted just in case somebody else has the same problem. Personal project. 

[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Greasy Fork](https://img.shields.io/badge/greasyfork-v2.6.2-red.svg)](https://greasyfork.org/)


---

## Overview


This userscript fixes my long-standing Twitch chat annoyance: animated emotes (from Twitch, 7TV, BetterTTV, and FrankerFaceZ) restarting or flickering whenever the same emote is posted again in chat. 


Normally, when someone sends an animated emote like `LOL` and another person sends `LOL` a second later:

- The new `LOL` starts from frame 0.
- **Every existing `LOL` on screen also gets re-rendered back to frame 0.**

This causes a very visible animation restart/flicker across the entire chat, especially during busy moments. This script ensures that **all on-screen copies of the same animated emote share one animation clock**, so a new instance never disturbs the ones already animating.

*(NOTE: This script only affects animated emotes. Static emotes are untouched and handled by Twitch normally.)*

### Before / After

| | Behavior |
|---|---|
| **Without this script** | New `LOL` → frame 0, existing `LOL`s → frame 0 (visible restart) |
| **With this script** | New `LOL` → current frame, existing `LOL`s → keep animating from current frame |

---

## What are user scripts?

User scripts put you in control of your browsing experience. Once installed, they automatically make the sites you visit better by adding features, making them easier to use, or taking out the annoying bits. The user scripts on Greasy Fork were written by other users and posted to share with the world. They're free to install and easy to use.

---

## Installation

### Greasy Fork

1. Install a user script manager.

   To use user scripts you need to first install a user script manager. Which user script manager you can use depends on which browser you use.

   - **Chrome:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
   - **Firefox:** [Greasemonkey](https://addons.mozilla.org/firefox/addon/greasemonkey/), [Tampermonkey](https://www.tampermonkey.net/), or [Violentmonkey](https://violentmonkey.github.io/)
   - **Safari:** [Tampermonkey](https://www.tampermonkey.net/) or [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
   - **Microsoft Edge:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
   - **Opera:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
   - **Maxthon:** [Violentmonkey](https://violentmonkey.github.io/)

   *(Note: If you are using the Tampermonkey extension in a Chrome-based browser, follow [these instructions](https://www.tampermonkey.net/faq.php#Q209) to enable Developer Mode.)*

2. Install this script by visiting Greasy Fork: `(https://greasyfork.org/en/scripts/595615-twitch-emote-no-restart)`


---

## How to Use

This script works automatically once installed. Just visit [twitch.tv](https://www.twitch.tv/) or hard-refresh your browser (ctrl + shift + R) and open any stream with animated emotes.

No configuration is needed. The script:

- Automatically detects animated emotes from **Twitch**, **7TV**, **BetterTTV**, and **FrankerFaceZ**.
- Creates a single shared animation state per unique emote.
- Renders all instances of that emote from the same frame, on the same clock.
- Draws the frames from a background worker, so emotes keep animating through Twitch's brief page freezes, just like normal images do.
- Cleans up decoded frames from memory ~15 seconds after the last instance disappears, and caps them at 192 MB (only emotes that are off screen are ever freed).

### Supported Emote Providers

- **Twitch** 
- **7TV** 
- **BetterTTV** 
- **FrankerFaceZ** 

### Supported Browsers

Requires a browser with **WebCodecs `ImageDecoder`** support:

- ✅ Chrome / Edge / Brave / Opera 94+
- ✅ Firefox 130+
- ✅ Safari 16.4+

If `ImageDecoder` is unavailable, the script silently disables itself and Twitch's default emote rendering takes over — no breakage.

---

## Changelog

### 2.6.1

- Rewritten to be much smaller (1,927 → ~700 lines) with the same behaviour. The backup renderer used when a background worker can't start is now the worker's own code running on the page, instead of a second copy of everything.
- Fixed: during a heavy flood of many different emotes, a reused canvas could briefly show the **previous** emote (about 1 in 4 canvases in testing), and emotes freed to save memory could come back **blank**. Both are gone.
- Fixed: an emote could stay blurry in the enlarged hover preview if a sharper version was requested while another was still loading.
- Tested with real 7TV, BetterTTV and FrankerFaceZ animated emotes spammed at up to 60 messages per second, alongside the existing test suite.

Older release notes are in the commit history.

---

## Contributing

I welcome contributions from the community! If you'd like to contribute to Twitch Emote No-Restart, follow these steps:

### Reporting Issues

If you find a bug, compatibility issue, or have a feature request, please:

1. Check if the issue has already been reported in the **Issues** tab.
2. If not, create a new issue with a clear title and description. Attach screenshots, a screen recording, or console logs if applicable.

Please include:

- Your browser + version
- Your userscript manager (Tampermonkey / Violentmonkey) + version
- The exact emote(s) that misbehaved (if known)
- What you expected vs. what happened


## Support Author

If you like this script, you can [buy me a coffee ☕](https://ko-fi.com/sirsane2k)
