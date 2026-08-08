# Changelog — nukoko

Discord bot for **Kuroko's Basketball: Street Rivals**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

_Nothing yet._

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
