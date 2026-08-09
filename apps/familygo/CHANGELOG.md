# Changelog — familygo

Discord bot for **Monopoly GO** events, dice links and gift rotation.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

_Nothing yet._

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
