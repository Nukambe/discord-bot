# Changelog — twitchext

Twitch Extension showing item tooltips for **Kuroko's Basketball: Street
Rivals**, read out of an Android emulator by computer vision.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

**Companion app** (`companion/`) — runs beside the emulator.
- Frame capture over `adb exec-out screencap`, using the raw RGBA buffer rather
  than `-p` so there is no PNG to decode and no image dependency. Handles both
  the 12-byte and Android 9+ 16-byte header layouts, and uses `exec-out` rather
  than `shell` because `shell` mangles `0x0a` into CRLF on Windows and silently
  corrupts every frame.
- Item recognition by normalized cross-correlation over 16×16 RGB thumbnails
  (`vision/fingerprint.js`). Fingerprints are mean-centered so matching survives
  the emulator's brightness drifting between scenes, and stored quantized to
  int8 base64.
- Matcher with a confidence floor *and* a runner-up margin
  (`vision/matcher.js`), so it abstains rather than guessing between
  near-identical icons. Per-slot smoother suppresses single-frame flicker.
- `calibrate.js` — writes a capture with slot rects drawn on it so slot
  coordinates can be read off directly. `--raw` for an unannotated frame.
- `learn.js` — teaches an item from live captures, averaging N samples. Warns
  when samples disagree (animating or misaligned slot) or when the result
  collides with an already-known item.
- `capture/png.js` — minimal PNG writer on `node:zlib`, used only by the
  calibration tools, so the companion needs no image library.

**Backend service** (`ebs/`) — runs on the same machine.
- HS256 JWT verification on `node:crypto` (`auth.js`); no JWT dependency, since
  Twitch only uses the one algorithm here. Rejects `alg: none`, expired tokens,
  and bad signatures.
- Per-channel ring buffer of timestamped snapshots (`store.js`), TTL- and
  count-bounded, nothing persisted.
- `node:http` server with no framework (`server.js`), binding loopback by
  default.
- Throttled Twitch PubSub broadcast (`pubsub.js`).

**Extension frontend** (`frontend/`) — served by Twitch's CDN.
- Transparent overlay with one hover element per visible item, tooltip
  rendering, and viewer-adjustable delay persisted per channel.
- Broadcaster config page showing live companion status, so "no tooltips" has
  somewhere to look, plus a default-delay control and a preview of the game rect.

**Shared** — `shared/protocol.js` wire contract, rect validation, and the
game-space → stream-space conversion that accounts for OBS letterboxing.

**Tooling** — `build/package.mjs` builds the upload zip with the EBS URL baked
in; six `twitchext:*` npm scripts; 30 tests under `tests/`.

**Data** — `data/items.json` seeded with SP Midorima's Lucky Items (Frog,
Tanuki, Raccoon, Wooden Bear, Rubber Duck), copy taken from
`apps/nukoko/commands/lucky-items.js`. Fingerprints start empty and are learned
locally. `data/layout.json` ships an uncalibrated placeholder slot layout.

### Notes on design

- **Polling, not PubSub, is the primary transport.** Twitch caps extension
  PubSub at 100 messages/min/channel (~1.6/s), which cannot carry 4fps
  snapshots. PubSub is a ~1/s nudge that gets a freshly-loaded viewer to first
  paint; everything works with it disabled.
- **The EBS keeps history, not latest-state.** Viewers see video 5–20s late, so
  the frontend asks what was on screen at `now - delay`. A single latest-state
  value cannot answer that.
- **Hover uses per-item elements, not a full-player mousemove catcher**, which
  would swallow every click on the player controls and fail extension review.
- **Recognition is slot-based rather than template matching across the frame**,
  because the game draws items into fixed UI slots. No OpenCV, no Python, no
  native dependency.

### Known limitations

- `data/layout.json` is an uncalibrated placeholder (`"calibrated": false`) and
  the item fingerprints are empty — the companion refuses to start with a
  message pointing at the learn command rather than silently matching nothing.
- Only the five Lucky Items are seeded. Other item categories need adding to
  `items.json` and learning.
- **Loopback is not reachable by remote viewers.** Running the EBS on
  `127.0.0.1` works for the local components and for watching your own stream,
  but a viewer's browser resolves localhost to their own machine. Real viewers
  require a tunnel or host, plus that hostname on the extension's URL fetching
  allowlist.
