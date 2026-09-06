# Changelog — nukoko

Discord bot for **Kuroko's Basketball: Street Rivals**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **LAST GAME Aomine** added to the PF roster (`roster.js`) — picked up
  automatically by `/random-character` and `/builds`.
- `/balls show|add|remove` — user-submitted ball images, stored the same way as
  builds (`ballsDb.js`, same channel under a separate `BALLS_DB:` index) but
  keyed by the user who added them. `/balls show` looks a user up by their
  saved name (autocompleted) — no @-mention needed. Max 10 balls per user;
  removal is by ID and restricted to your own. Both index scans now page up to
  500 messages deep so neither db's traffic can bury the other's index.
- `/builds show|add|remove` — user-submitted build screenshots, stored in a
  dedicated Discord channel (`buildsDb.js`). Images are re-posted by the bot so
  the record points at a message it owns; the index is a JSON attachment on the
  channel's last message. Max 10 builds per character, and only the user who
  added a build can remove it.
- `roster.js` — the character roster, shared by `random-character` and `builds`.
- Autocomplete interactions are now dispatched to a command's optional
  `autocomplete()` export (`index.js`); the roster is larger than the 25-choice
  cap, so character options can't use `addChoices`.

## Baseline — 2026-08-08

Changelog tracking started here. The app predates it, so this entry records
what exists rather than reconstructing per-change history; see `git log --
apps/nukoko` for what came before.

### Present at baseline
- Slash commands: `1v1`, `63`, `attributes`, `bonds`, `contest`, `drip`, `duo`,
  `lucky-items`, `ping`, `rank1`, `traits`, `where`.
- Image-reply helper (`_replyWithImage.js`) and media under `media/` for bonds,
  traits, drip and rank art.
- `streamNotifier.js` for stream announcements.
- `jobs/weekendCode.js` scheduled job.
- `deploy-commands.js` for registering slash commands.
