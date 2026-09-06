# Changelog — familygo

Discord bot for **Monopoly GO** events, dice links and gift rotation.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `/update` (admin only) — checks GitHub for a newer MogoBot release and, if
  there is one, downloads it, swaps the exe's files in place, logs the bot out
  and relaunches the new build in its own console window, so an update no longer
  needs someone at the machine to close and reopen the app. `check-only: true`
  just reports the installed and latest versions. Running from source it reports
  there's nothing to update. `selfUpdate.js` was split into `checkForUpdate` /
  `installUpdate` / `relaunch` so the launch-time check and the command share
  one implementation.

### Fixed
- Future-events posts tagged `blocks-boutique` now route to the special-events
  channel with the Blocks Boutique emoji around the title, instead of falling
  through to the unrouted default with a bare title.
- Future-events posts whose in-article images have no `editorial-image` class
  (the Blocks Boutique guide wraps each one in a plain `<figure>`) no longer
  post with only the hero image: any full-size `<figure>` image inside the
  article body is picked up as well.

### Changed
- Daily schedule post reformatted: each event is a bold emoji + name line with
  Start/End/Duration bullets underneath in the short `Sep 6, 4:00 PM` form (no
  seconds, no year), and Quick Wins tasks get their own emojis (pass go, chance,
  community chest, utility, landmark, cash, rolls, heist, shutdown, sticker —
  `QUICK_WIN_EMOJI_MAP` in `emojiMap.js`). The "Week Of" and "Piggy Bank" entries
  the wiki lists under Tournaments are dropped. The `source:` link is wrapped in
  angle brackets so Discord no longer attaches a link preview; the event images
  and the milestone-channel forward are unchanged.
- Weekly predictions reformatted: each event is a `> ` quote line showing how long
  one instance runs — "(30 Mins)", from the calendar record's `local_duration`;
  omitted for multi-day events that don't have one — ahead of its availability
  window. "Week Of" and "Piggy Bank" are excluded alongside milestones and
  tournaments.

### Added
- `/dump-logs` — posts the process's console history (captured into an
  in-memory ring buffer by `logBuffer.js`, hooked into stdout/stderr as the
  first import of both `launch.js` and `index.js`) plus the current db state as
  file attachments to the hardcoded diagnostics channel `1437862445266895001`.
  The packaged .exe writes no log file, so this is the only way to get history
  off the user's machine; the capture only covers the current process run.

### Fixed
- Daily schedule post: "Blocks Boutique" now gets the blocks emoji. The rule only
  matched the preview-post spelling "Minigame: Blocks", so the 9/6 schedule's
  entry rendered as a plain `•` bullet.
- Free dice links are no longer re-posted under a new URL. monopolygo.wiki wraps
  Scopely's links in its own shortener and mints a fresh slug whenever it re-lists a
  card, so the same reward kept arriving as a "new" link — and anyone clicking it was
  told they'd already claimed it. Each href is now followed to Scopely's own
  `mply.io` link (which is what gets posted, so it's stable) and to the campaign id
  behind it (`monopolygo://reward-link/<id>`); dedupe keys off both, so no number of
  wiki slugs can produce a repeat. Resolution is plain HTTPS — no extra Chrome
  window — and falls back to the unresolved URL if a shortener is unreachable.
- Free dice cards whose availability window has already closed are skipped instead
  of posted as dead links.
- Daily schedule post: "Dig Treasures" (and "Roll Treasures") now get the pickaxe
  emoji. The emoji only matched the name "Dig Minigame", which is not what the
  daily schedule calls the event, so it rendered as a plain `•` bullet.
- Free dice links no longer vanish at the calendar boundary. The check ran once a
  day as a step of the daily events post and filtered to that moment's date — but
  the daily post routinely lands after midnight, by which time the previous day's
  links no longer count as "today" and no later run looks back at them.
### Changed
- The free-dice and wiki-news scans both cover a today+yesterday window and skip
  anything whose URL is already in the destination channel (`alreadyPosted.js`),
  so consecutive runs overlap rather than each owning a separate day, and the
  overlap can't produce duplicates.
- `/future-events` covers today's posts as well as yesterday's.

### Added
- Weekly predictions post: every Sunday at 7:30pm Eastern, the bot posts the
  upcoming Monday–Sunday event schedule from the wiki's `/events` calendar,
  grouped by day with the usual event emojis, excluding milestone events and
  tournaments. If the calendar doesn't cover the full week yet, it retries every
  half hour (through Monday 3:30pm) until it does — same pattern as the daily
  post. Multi-day spans (Peg-E, Sticker Boom) show their real end date, taken
  from the calendar's underlying data rather than the cards' time-only labels.
  Manual twin: `/weekly-predictions` (with the usual `debug` option); posts to a
  hardcoded predictions channel (see `WEEKLY_CHANNEL_ID` in
  `postWeeklyPredictions.js`).
- The event-name → emoji map now lives in its own module (`emojiMap.js`), shared
  by the daily schedule post and the weekly predictions post.
- The self-updater logs every outcome, timestamped in Eastern time: the check
  starting, "up to date", the first-launch baseline, and the existing
  updating/failed lines. Previously the common paths returned silently, so a
  normal startup gave no sign the check had run at all.
- Free dice links now have their own nightly cron at 00:05 America/New_York, which
  sweeps the day that just ended. They previously went out only as a step of the
  daily events post, whose hour drifts (it retries until the wiki publishes), so a
  link appearing after it ran waited for the next day's post and could be near
  expiry by then. The daily-post call is kept as the earlier, opportunistic pass.

### Fixed (updater)
- After installing an update, the relaunched bot is visible again. It was spawned
  detached with `stdio: 'ignore'`, so the new instance had nowhere to print and an
  update looked like the app had closed itself. It now relaunches through
  `cmd /c start`, which gives it its own console window.

### Notes
- Scan frequency is otherwise unchanged on purpose. Each wiki fetch opens a
  visible Chrome window on the end user's machine (Cloudflare rejects headless),
  so added polling is a UX cost, not a free one — hence one nightly run per job
  rather than periodic sweeps, staggered so they don't put two windows on screen
  at once.
- Still outstanding: a preview post published in the last minutes before midnight
  can miss the one nightly sweep if the news index hasn't listed it yet. Moving
  `startFutureEventsCron` to 1–2am would close that without adding runs.

## Baseline — 2026-08-08

Changelog tracking started here. The app predates it, so this entry records
what exists rather than reconstructing per-change history; see `git log --
apps/familygo` for what came before.

### Present at baseline
- Event scraping and posting: `getEvents.js`, `getEvent.js`, `getFutureEvents.js`,
  `parseFutureEventPost.js`, `formatEvent.js`, `postEvent.js`,
  `postFutureEvents.js`.
- Free dice links (`getFreeDiceLinks.js`, `postFreeDiceLinks.js`) and gift
  rotation (`giftRotation.js`).
- Commands: `config`, `future-events`, `giftRotation`, `highRoller`, `next`,
  `openVault`, `ping`, `postDaily`, `skip`, `sticker-request`.
- `db.js` persistence, `selfUpdate.js`, `launch.js`, `postInstructions.js`.
- Tests under `tests/` (ad-hoc scripts).
- Packaged binary via `build/familygo/build.mjs` and the
  `.github/workflows/familygo-release.yml` release workflow.
