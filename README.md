# Overview

This userscript fixes a long-standing Twitch chat annoyance: animated emotes (from Twitch, 7TV, BetterTTV, and FrankerFaceZ) restarting or flickering whenever the same emote is posted again in chat.

Normally, when someone sends an animated emote like LOL and another person sends LOL a second later:

The new LOL starts from frame 0.

Every existing LOL on screen also gets re-rendered back to frame 0.

This causes a very visible animation restart/flicker across the entire chat, especially during busy moments. This script ensures that all on-screen copies of the same animated emote share one animation clock, so a new instance never disturbs the ones already animating.

(NOTE: This script only affects animated emotes. Static emotes are untouched and handled by Twitch normally.)

Before / After
Behavior
Without this script	New LOL → frame 0, existing LOLs → frame 0 (visible restart)
With this script	New LOL → current frame, existing LOLs → keep animating from current frame
What are user scripts?
User scripts put you in control of your browsing experience. Once installed, they automatically make the sites you visit better by adding features, making them easier to use, or taking out the annoying bits. The user scripts on Greasy Fork were written by other users and posted to share with the world. They're free to install and easy to use.

Installation
Greasy Fork
Install a user script manager.

To use user scripts you need to first install a user script manager. Which user script manager you can use depends on which browser you use.

Chrome: Tampermonkey or Violentmonkey

Firefox: Greasemonkey, Tampermonkey, or Violentmonkey

Safari: Tampermonkey or Userscripts

Microsoft Edge: Tampermonkey or Violentmonkey

Opera: Tampermonkey or Violentmonkey

Maxthon: Violentmonkey

(Note: If you are using the Tampermonkey extension in a Chrome-based browser, follow these instructions to enable Developer Mode.)

Install this script by visiting Greasy Fork: [link to your script]

Manual Installation
Install a user script manager (see list above).

Open the Tampermonkey/Violentmonkey Dashboard, drag & drop twitch-emote-no-restart.user.js into it, and click the Install button.

How to Use
This script works automatically once installed. Just visit twitch.tv and open any chat with animated emotes.

No configuration is needed. The script:

Automatically detects animated emotes from Twitch, 7TV, BetterTTV, and FrankerFaceZ.

Creates a single shared animation state per unique emote.

Renders all instances of that emote from the same frame, on the same clock.

Cleans up decoded frames from memory ~15 seconds after the last instance disappears.

Supported Emote Providers
Twitch — static-cdn.jtvnw.net/emoticons/v2/...

7TV — cdn.7tv.app/emote/... and cdn.7tv.io/emote/...

BetterTTV — cdn.betterttv.net/emote/...

FrankerFaceZ — cdn.frankerfacez.com/emote/...

Supported Browsers
Requires a browser with WebCodecs ImageDecoder support:

✅ Chrome / Edge / Brave / Opera 94+

✅ Firefox 130+

✅ Safari 16.4+

If ImageDecoder is unavailable, the script silently disables itself and Twitch's default emote rendering takes over — no breakage.

Check Script Activity
The script runs silently by default. If you want to verify it's working, open DevTools Console (F12) and look for messages prefixed with [TENR]. You should also notice that animated emotes no longer flicker when spammed.

Contributing
We welcome contributions from the community! If you'd like to contribute to Twitch Emote No-Restart, follow these steps:

Reporting Issues
If you find a bug, compatibility issue, or have a feature request, please:

Check if the issue has already been reported in the Issues tab.

If not, create a new issue with a clear title and description. Attach screenshots, a screen recording, or console logs if applicable.

Please include:

Your browser + version

Your userscript manager (Tampermonkey / Violentmonkey) + version

The exact emote(s) that misbehaved (if known)

What you expected vs. what happened

Submitting Pull Requests
Fork the repository: Click on the "Fork" button in the top-right of the repo.

Clone your fork:

bash
git clone https://github.com/YOUR-USERNAME/Twitch-Emote-No-Restart.git
cd Twitch-Emote-No-Restart
Create a new branch for your feature or bugfix:

bash
git checkout -b feature-or-bugfix-name
Make your changes and ensure the script still works correctly on Twitch.

Commit your changes with a descriptive message:

bash
git commit -m "Add feature/fix issue: Brief description"
Push to your fork:

bash
git push origin feature-or-bugfix-name
Submit a Pull Request (PR):

Go to the original repository: YOUR-USERNAME/Twitch-Emote-No-Restart

Click "New Pull Request" and select your branch.

Add a description of your changes and submit.

Development Guidelines
Keep your code clean and well-documented.

Follow the existing coding style.

Test your changes on both regular and /popout/ Twitch chat windows.

Ensure compatibility with major user script managers like Tampermonkey and Violentmonkey.

Do not touch the shared-animation-state code paths (STATE_MAP, startTime, currentFrameIndex) unless the change is specifically about them — the whole point of the script is that adding a new <img> never resets an existing animation.

Architecture at a Glance
text
STATE_MAP:  emoteKey -> { frames, startTime, refCount, ... }   // one per unique emote
INSTANCES:  <img>    -> { canvas, key, ... }                   // one per on-screen emote

rAF loop:
  for each instance:
    frameIndex = currentFrameIndex(STATE_MAP[instance.key], now)
    draw STATE_MAP[instance.key].frames[frameIndex] into instance.canvas
Adding a new <img> only creates a new canvas and increments refCount. It never touches startTime, never re-decodes, and never disturbs existing canvases.

Help with Translations
Want to help translate the README or the script's Greasy Fork description? Submit a PR adding a new file in docs/ using the appropriate language code (e.g., docs/README-fr.md for French, docs/README-de.md for German).

Translate the content from docs/README-en.md into your language while keeping the formatting intact.

Language Codes
Use standard IETF Language Tag (e.g., es-ES for Spanish, ja-JP for Japanese). You can find a full list of codes here.

Support Author
If you like this script, you can support me via Ko-fi or Buy me a coffee ☕.
