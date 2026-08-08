# Changelog — twitch

Twitch chat bot (tmi.js) plus a local React overlay for OBS capture.

Not to be confused with `apps/twitchext`, which is the Twitch *Extension* that
overlays tooltips on the video player for viewers. This app is the chat bot and
the streamer-side overlay window.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

_Nothing yet._

## Baseline — 2026-08-08

Changelog tracking started here. The app predates it, so this entry records
what exists rather than reconstructing per-change history; see `git log --
apps/twitch` for what came before.

### Present at baseline
- tmi.js chat client with OAuth token refresh and Heroku token persistence
  (`lib/persistRefreshToken.js`).
- Command loader and registry (`lib/commandLoader.js`), cooldowns
  (`lib/cooldown.js`), mod/broadcaster checks (`lib/utils.js`).
- Commands: `help`, `ping`, `character-request`, `player`, `club`.
- React/Vite overlay under `web/`, started as its own server and launched in an
  OBS-capturable window (`lib/overlayProcess.js`, `lib/launchOverlayWindow.js`).
- Spotify "Now Playing" panel (`lib/spotify.js`) with a one-time auth bootstrap
  (`lib/spotifyAuthBootstrap.js`); skips itself when unconfigured.
