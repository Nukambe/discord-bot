# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A monorepo of three independent, unrelated bots that happen to share `util/` helpers and deployment tooling. There is no shared runtime or shared "core" — each app under `apps/` boots its own client and owns its own commands, jobs, and state. The root `index.js` is a vestigial skeleton, not the real entry point for anything.

- **`apps/familygo`** ("MogoBot") — Discord bot for a Monopoly GO Discord server. Scrapes `monopolygo.wiki` (via Playwright, since Cloudflare blocks headless requests) for daily events and posts formatted embeds, runs a gift-rotation reminder cron, and is also shipped as a standalone Windows `.exe` for a non-technical end user.
- **`apps/twitch`** ("nukambot") — Twitch chat bot (`tmi.js`) with slash-command-style `!commands`, a Spotify "Now Playing" panel, and a React/Vite overlay window (OBS-capturable) that the bot process launches and pushes live state into.
- **`apps/nukoko`** — Discord bot for a different server; slash commands plus scheduled jobs (stream notifier, weekend code).

## Commands

```bash
npm install                    # install root deps
npm start                      # runs root index.js (NOT one of the real bots — see Procfile)

# Run an individual bot directly:
node apps/familygo/index.js
node apps/twitch/index.js
node apps/nukoko/index.js

# familygo Windows .exe build (bundles esbuild -> pkg + Playwright Chromium)
npm run build:familygo
# requires: npx playwright-core install chromium   (once, before first build)
# use playwright-core (not the `playwright` package) so the downloaded Chromium
# revision matches the version actually pinned in package-lock.json

# Twitch overlay (React/Vite), run from apps/twitch/web
npm run dev      # vite dev server
npm run build    # vite build

# One-time Spotify OAuth bootstrap for the twitch overlay's Now Playing panel
npm run spotify:auth
```

There is no configured test runner (`npm test` is a stub) and no lint script. Files under `apps/familygo/tests/*.test.js` are plain scripts invoked directly with `node apps/familygo/tests/<file>.test.js`, not run by a framework — they hit the live `monopolygo.wiki` site and print output for manual inspection, they don't assert.

Per project convention ([[Skip build verification]] in memory): don't run `npx vite build` or similar checks after edits — the user verifies live against the running dev server.

## Deployment model

Each bot is a separate Heroku/Procfile process (see `Procfile`): `familygo`, `nukambot` (twitch), `nukoko`. There is one shared `.env` at the repo root; `.env.example` documents every variable across all three apps, grouped by app. `.env` is never delivered through CI — it's provisioned on the target machine directly.

`apps/familygo` has a second, independent distribution path: `.github/workflows/familygo-release.yml` builds a packaged Windows executable on every push touching `apps/familygo/**`, `build/familygo/build.mjs`, `util/**`, or `package.json`, and publishes it as a GitHub release (`familygo-v<run_number>`). That exe self-updates: `apps/familygo/launch.js` is the packaged entry point — it runs `selfUpdate.js` (checks the latest GitHub release, downloads/swaps files, relaunches) *before* `index.js` (the real bot) is ever imported, so an update never races a live-logged-in Discord client. The relaunch goes through `cmd /c start` so the updated instance gets its own console window — the packaged app writes no log file, so anything not printed to a console is simply lost, which is also why the updater logs every outcome rather than only the interesting ones. `apps/familygo/index.js` is the entry point when running from source (`npm start` equivalent for dev); `launch.js` is only used in the packaged build.

## Cross-app conventions

- **Command modules**: each command file default-exports `{ data: SlashCommandBuilder, execute(interaction), cooldown?, dmPermission?, defaultMemberPermissions? }`. `util/loadCommands.js` recursively walks a `commands/` directory and dynamically imports every `.js` file to build the registry — dropping a new file into `apps/<app>/commands/` is sufficient to register it, no manual index needed (except familygo's packaged build, see below). Both `familygo/index.js` and `nukoko/index.js` implement matching per-command, per-user cooldown and error-reply logic independently (not shared — if you fix a bug in one, check the other).
- **Slash command deployment**: each app has its own `deploy-commands.js`, called once at process startup (`deployCommands()` at the top of `index.js`), registering guild-scoped commands (instant updates, no global-command propagation delay).
- **Packaged builds can't dynamic-`import()`**: `pkg`-bundled executables (`process.pkg` truthy) can't reach the filesystem the way `loadCommands()` expects, so `apps/familygo/commands/index.js` exports a static `staticCommands` array and `index.js` branches: `process.pkg ? loadCommandsFromModules(staticCommands) : await loadCommands(...)`. If you add a familygo command, add it to both the `commands/` directory *and* the static array, or the packaged .exe won't see it.
- **familygo's config/db**: there's no real database — `apps/familygo/db.js` persists config (gift-rotation schedule, daily-post window) as JSON embedded in a marker line (`DB:`) of the latest message in a dedicated Discord channel (`DB_CHANNEL_ID`), and reads it back by fetching that channel's last message. `updateDb()` posts a new message per write (history lives in channel scrollback) and fires `onDbChange` listeners, which `index.js` uses to tear down and reschedule its cron jobs live.
- **Scheduling**: `node-cron`, always pinned to `America/New_York` regardless of host timezone. familygo's daily-post cron polls every `retryIntervalMinutes` inside a start/end time window and treats "does Discord already have a message containing this date slug" as its own idempotency check. Its free-dice and wiki-news scans follow the same principle via `apps/familygo/alreadyPosted.js`, which scans recent messages in the destination channels for a link's `host/path`: because "already posted?" is answered by Discord rather than local process state, those jobs scan an overlapping today+yesterday window instead of each owning one day, and re-running one is always safe. On top of the channel scan, `db.lastPosts` (see `getLastPosts`/`updateLastPosts` in `db.js`) records the most recent daily-post date slug, free-dice claim URLs, and per-event-type future-events post, so a scheduled run and its manual slash-command twin (`/post-daily`, `/free-dice`, `/future-events`) never double-post each other's work; the `debug` option on those commands bypasses both dedupe layers (and never records) so a test post always goes out. Widen the window rather than adding runs — every wiki fetch opens a *visible* Chrome window on the packaged desktop build (Cloudflare rejects headless, so `fetchWithPlaywright` can't hide it), which makes scan frequency a user-facing budget. That constraint is why the news sweep and the free-dice check are each a single daily cron rather than periodic polls: the news sweep at midnight (`0 0`) and the free-dice check at 7:30pm ET (`30 19`), fully independent of the daily events post. Missed free-dice links can be caught up manually with the `/free-dice` command, which is safe to re-run thanks to the overlap-plus-dedupe design.
- **Playwright over plain HTTP**: `util/fetchWithPlaywright.js` exists because `monopolygo.wiki` is behind Cloudflare, which challenges headless Chrome even from non-flagged IPs — headed mode is required, so `CHROME_HEADLESS=false` is mandatory on any machine without a virtual display. It resolves the Chrome binary in this order: `CHROME_PATH` env var → bundled `chrome-win/chrome.exe` next to a `pkg` executable → a hardcoded Heroku buildpack path.
- **Self-contained util helpers** (`util/`): `dateUtils.js` (EST-aware date slug formatting — familygo posts are keyed off `America/New_York` calendar dates, not UTC), `sanitize.js` (Twitch chat input sanitization), `loadCommands.js`, `outputToFile.js`, `regexUtils.js`. Treat these as shared, app-agnostic — don't put app-specific logic in `util/`.
- **Twitch overlay IPC**: `apps/twitch/lib/overlayProcess.js` starts the Vite dev server for `apps/twitch/web` as a child process and exposes `overlay.push(channel, data)` for the bot to stream live state (chat, now-playing, connection status) into the React app; `launchOverlayWindow.js` opens it in a dedicated browser window for OBS window-capture. Spotify integration (`lib/spotify.js`) is fully optional — leaving `SPOTIFY_CLIENT_ID/SECRET/REFRESH` unset skips the panel without crashing the bot.
