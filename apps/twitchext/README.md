# Item Tooltips — Twitch Extension

Viewers hover an item on the stream and get a tooltip explaining what it does.

The game is **Kuroko's Basketball: Street Rivals**, running in an Android
emulator. It exposes no API, so item state is read off the screen with computer
vision on the streamer's PC.

**This runs entirely on your machine.** The EBS binds loopback by default and
nothing is deployed to a host — see [Local-only and who can
see tooltips](#local-only-and-who-can-see-tooltips) for what that means for
viewers, because it is not free.

Three pieces, following the architecture the TFT Tooltips extension uses:

```
  YOUR PC
  ══════════════════════════════════════════════════════════

    Android emulator  ──adb screencap──▶  companion/
    (Street Rivals)                       crop + match
                                               │
                                               │  POST snapshot, 4/sec
                                               ▼
                                             ebs/
                                       ring buffer, 60s
  ══════════════════════════════════════════════════════════
                                               │
                          poll 1/s  +  PubSub nudge ~1/s
                                               ▼
                                          frontend/
                                       hover + tooltip
                                     (viewer's browser)

  Only the bottom arrow leaves your machine. On loopback it resolves
  for you but not for remote viewers — see below.
```

| Directory    | Runs where     | Job |
|--------------|----------------|-----|
| `companion/` | Your PC        | Grabs frames over adb, identifies items, POSTs snapshots |
| `ebs/`       | Your PC        | Authenticates, buffers game state, serves it to viewers |
| `frontend/`  | Twitch's CDN   | Transparent overlay: hover regions and tooltips |
| `shared/`    | both           | Wire format and coordinate helpers |

## Local-only and who can see tooltips

The EBS runs on your machine and binds `127.0.0.1`. That is fine for the two
components that also run on your machine, and fine for *you* watching your own
stream — browsers treat `localhost` and `127.0.0.1` as trustworthy origins, so
the HTTPS extension page is allowed to call them without mixed-content blocking.

**It does not work for remote viewers.** Their browser resolves `localhost` to
*their own* machine, finds nothing there, and shows no tooltips. There is no
configuration that changes this; it is how loopback addresses work.

So:

| What you want | What you need |
|---|---|
| Develop and test it yourself | Nothing extra. Run the EBS locally. |
| Watch your own stream and see tooltips | Nothing extra. |
| **Real viewers see tooltips** | Expose the EBS over HTTPS — a tunnel (`cloudflared tunnel --url http://localhost:8080`, ngrok) or a small host. |

If you go the tunnel route, the code does not change: point
`TWITCHEXT_EBS_URL` at the tunnel hostname and re-run
`npm run twitchext:package`. You must also add that hostname to your
extension's **Allowlist for URL Fetching Domains** in the Twitch console, or
Twitch's CSP blocks the request regardless of what your server says.

Two things the EBS does specifically to make the local case work:

- Answers Chrome's **Private Network Access** preflight
  (`Access-Control-Allow-Private-Network`). A public page calling a loopback
  address triggers this, and without the header every request is blocked with no
  visible error beyond an empty overlay.
- Allows the developer-rig `localhost` origins by default
  (`TWITCHEXT_ALLOW_LOCAL=false` turns that off).

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

### 2. Run the EBS

```bash
npm run twitchext:ebs        # http://127.0.0.1:8080
```

It holds nothing worth persisting — a restart just means the companion
repopulates within a frame — so there is nothing to back up and no database.

`TWITCHEXT_HOST` overrides the bind address and `TWITCHEXT_PORT` the port. Keep
it on loopback unless you have a specific reason not to: binding `0.0.0.0`
exposes your game state to everything on your local network.

To let real viewers reach it, put a tunnel in front rather than changing the
bind — see [Local-only and who can see
tooltips](#local-only-and-who-can-see-tooltips).

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
npm run twitchext:package                                        # local: http://127.0.0.1:8080
TWITCHEXT_EBS_URL=https://your-tunnel.example.com npm run twitchext:package   # for viewers
```

Produces `dist/twitchext-frontend.zip` with the EBS URL baked in — Twitch serves
extension files from its own CDN with no build step, so the URL cannot be
configured at runtime. Building against loopback prints a warning reminding you
viewers won't reach it.

Upload under **Files → Asset Hosting**:

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
| `TWITCHEXT_HOST` | `127.0.0.1` | EBS bind address. `0.0.0.0` exposes game state to your LAN |
| `TWITCHEXT_PORT` | `8080` | EBS port |
| `TWITCHEXT_ALLOW_LOCAL` | on | Allows developer-rig localhost origins through CORS |
| `TWITCHEXT_PUBSUB` | on | `false` runs poll-only |
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
