# discord-bot

A monorepo of independent apps sharing one dependency tree and `util/`.

| App | What it is |
|---|---|
| [`apps/nukoko`](apps/nukoko) | Discord bot for Kuroko's Basketball: Street Rivals |
| [`apps/familygo`](apps/familygo) | Discord bot for Monopoly GO events, dice links, gift rotation |
| [`apps/twitch`](apps/twitch) | Twitch chat bot (tmi.js) + local React overlay for OBS |
| [`apps/twitchext`](apps/twitchext) | Twitch Extension: hover an item on stream, see what it does |

## Changelogs

Each app tracks its own changelog at `apps/<app>/CHANGELOG.md`, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The apps ship and
version independently, so there is no root changelog — put an entry under the
`[Unreleased]` heading of whichever app you touched.

## Setup

Copy `.env.example` to `.env` and fill in the sections for the apps you intend
to run; each block is documented inline. Then:

```bash
npm install
```

Per-app setup lives in that app's directory — `apps/twitchext/README.md` in
particular has a full walkthrough, since it needs calibration before it works.
