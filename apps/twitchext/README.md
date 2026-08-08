# Item Tooltips — Twitch Extension

Viewers hover an item on the stream and get a tooltip explaining what it does.
The game runs in an Android emulator and exposes no API, so item state is read
off the screen with computer vision on the streamer's PC.

Three pieces, following the architecture the TFT Tooltips extension uses:

```
  Android emulator                streamer's PC                     cloud                    viewer's browser
 ┌────────────────┐   adb      ┌─────────────────┐   HTTPS      ┌──────────────┐   HTTPS   ┌──────────────────┐
 │  the game      │──screencap─▶│  companion/     │──snapshot───▶│  ebs/        │◀──poll────│  frontend/       │
 │                │             │  crop + match   │   4/sec      │  ring buffer │           │  hover + tooltip │
 └────────────────┘             └─────────────────┘              └──────────────┘           └──────────────────┘
                                                                        │  PubSub nudge ~1/s      ▲
                                                                        └─────────────────────────┘
```

| Directory    | Runs where          | Job |
|--------------|---------------------|-----|
| `companion/` | Streamer's PC       | Grabs frames over adb, identifies items, POSTs snapshots |
| `ebs/`       | Heroku (or similar) | Authenticates, buffers game state, serves it to viewers |
| `frontend/`  | Twitch's CDN        | Transparent overlay: hover regions and tooltips |
| `shared/`    | both                | Wire format and coordinate helpers |

## Three design decisions worth knowing

**Recognition is slot-based, not template-matching across the frame.** The game
draws items into fixed UI slots, so we already know *where* to look and only
need to answer *which item is this*. That reduces to a normalized
cross-correlation between two small thumbnails — no OpenCV, no Python, and about
0.1ms per slot. `companion/vision/` is the only code that touches pixels; if
accuracy ever proves insufficient, swap in an OpenCV backend behind
`fingerprintRegion()` and `createMatcher()` without touching anything else.

**Polling is the primary transport; PubSub is only a nudge.** Twitch caps
extension PubSub at 100 messages/min/channel — about 1.6/s. At 4fps we'd blow
through that in the first minute and start collecting 429s. So viewers poll
`/api/state` for the authoritative history, and the ~1/s PubSub broadcast just
gets a freshly-loaded viewer painting immediately. With PubSub off entirely
(`TWITCHEXT_PUBSUB=false`) everything still works.

**Hover uses one small element per item, not a full-player mousemove catcher.**
An element covering the whole player intercepts every click, so viewers can't
pause or scrub — and Twitch rejects extensions that do this during review. Only
the item rectangles opt into `pointer-events`.

## Coordinate spaces

Getting these confused is the main cause of tooltips landing in the wrong place.

1. **capture px** — raw pixels from `adb screencap`.
2. **game space** — 0..1 within the emulator's game area. Slot layout lives here,
   so it survives a resolution change.
3. **stream space** — 0..1 within the Twitch video canvas. The frontend maps game
   → stream through `frame`, the rect describing where the emulator sits in the
   OBS scene. **This is what accounts for letterboxing**, side panels, and webcam
   borders.

## Setup

### 1. Create the extension

At [dev.twitch.tv/console/extensions](https://dev.twitch.tv/console/extensions),
create an extension of type **Video - Fullscreen** (add **Video - Component** if
you also want it on the component layer). From the extension's settings page copy
the **Client ID**, the **Extension Secret** (base64 — not the client secret), and
your own Twitch user ID.

Fill in the `TWITCHEXT_*` block in `.env` (see `.env.example`). Generate the
companion secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Deploy the EBS

```bash
npm run twitchext:ebs        # locally on :8080
```

It binds `process.env.PORT` and holds nothing worth persisting, so any Node host
works. It must be reachable over **HTTPS** — Twitch loads the extension over
HTTPS and a plain-http backend is blocked as mixed content.

Set `TWITCHEXT_ALLOW_LOCAL=true` only while testing against the developer rig.

### 3. Calibrate the slot layout

Start the emulator, get the game to a screen showing items, then:

```bash
npm run twitchext:calibrate
```

This writes `data/calibration.png` with the current slot rects drawn on it. Open
it, and edit the `slots` array in `data/layout.json` until the boxes sit on the
item icons. Coordinates are 0..1 within `gameArea`, so convert a pixel
measurement with `x_norm = x_px / capture_width`. Re-run until it lines up, then
set `"calibrated": true`.

Also set `frame` in the same file — where the emulator sits in your OBS scene. If
the game fills the whole canvas, leave it as `0,0,1,1`. The config page draws
this back to you as a preview.

`npm run twitchext:calibrate -- --raw` dumps the capture with no boxes, for
measuring against.

### 4. Teach it the items

Add each item to `data/items.json` with its tooltip copy, then, with that item
visible in a slot:

```bash
npm run twitchext:learn -- frog --slot item1
```

This captures 8 samples, averages them, and stores a fingerprint. References are
learned **from live captures rather than a wiki sprite sheet on purpose** — the
emulator scales, compresses and colour-shifts icons, and a reference taken
through the same pipeline matches far more reliably.

Watch the output:
- *frame agreement* below 0.9 means the samples disagree — the slot is animating,
  misaligned, or empty. Don't trust that fingerprint.
- a *similarity warning* against another item means the matcher will likely
  refuse both. Learn extra fingerprints (repeat the command; they accumulate) or
  tighten the slot rect onto the part of the icon that actually differs.

Learn the same item from several slots and lighting states — it only improves
matching. Use `--replace` to discard an item's existing fingerprints, and
`--samples N` to change the sample count.

### 5. Package and upload the frontend

```bash
TWITCHEXT_EBS_URL=https://your-ebs.example.com npm run twitchext:package
```

Produces `dist/twitchext-frontend.zip` with the EBS URL baked in. Upload under
**Files → Asset Hosting**:

| Twitch field                          | Path                  |
|---------------------------------------|-----------------------|
| Video - Fullscreen / Video - Component | `video_overlay.html` |
| Config                                 | `config.html`        |

### 6. Run the companion while streaming

```bash
npm run twitchext:companion
```

It prints how many items and reference fingerprints it loaded, then posts 4
snapshots a second. The extension's config page shows whether that data is
actually arriving — check there first when tooltips don't appear.

## Stream delay

Viewers see video 5–20 seconds behind reality, so tooltips have to be held back
by the same amount or hover regions sit where items are *going* to be. This is
why the EBS keeps a 60-second history instead of just the latest state: the
frontend asks "what was on screen at `now - delay`".

The streamer sets a default on the config page; each viewer can fine-tune it with
the ⚙ control and their choice is remembered per channel. Suggest they drag it
until tooltips line up with what they can see.

## Tuning recognition

| Env var | Default | Effect |
|---|---|---|
| `TWITCHEXT_CAPTURE_FPS` | 4 | Higher costs CPU and adb bandwidth for little gain |
| `TWITCHEXT_MIN_SCORE` | 0.86 | Match confidence floor. Lower = more matches, more wrong ones |
| `TWITCHEXT_MIN_MARGIN` | 0.03 | How far ahead of the runner-up a match must be |
| `TWITCHEXT_STABILITY` | 3 | Frames a slot must agree with itself before publishing |

Both guards exist because a confident-but-wrong tooltip is worse than no tooltip.
Item sets usually contain near-identical icons (same art, different tier), and
the margin check makes the matcher abstain rather than guess between them.

Tooltips flickering → raise `TWITCHEXT_STABILITY`. Tooltips never appearing →
lower `TWITCHEXT_MIN_SCORE` slightly, or re-learn the item; check
`data/calibration.png` first, since a misaligned slot looks exactly like a
recognition failure.

## Tests

```bash
npm run twitchext:test
```

Covers fingerprint stability under brightness shifts, matcher abstention on
ambiguous icons, flicker smoothing, `screencap` header parsing (both Android
layouts), JWT verification including the `alg: none` downgrade, cross-channel
read isolation, and the delay-compensation lookup.

## Security notes

- The channel a viewer reads is taken from their **Twitch-signed JWT**, never
  from a query parameter — a viewer can't read a channel they aren't watching.
- Item fingerprints stay companion-side; `/api/items` serves only display copy.
- The companion secret is compared in constant time.
- CORS is limited to `*.ext-twitch.tv` (plus localhost when explicitly opted in).
- Snapshots more than 30s off server time are rejected, since a wrong clock on
  the streaming PC would silently break delay compensation for every viewer.
