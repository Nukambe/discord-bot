---
name: mogo-collab
description: Work through the MogoBot (familygo, the Monopoly GO Discord bot) collaboration channel end to end — read the requests and bug reports posted since the last patch notes, investigate each against the bot's real state, fix or implement them in apps/familygo, post patch notes to the channel as daBot, then commit and push. Use when asked to check the collab/collaboration channel, handle the Monopoly GO bot's requests or issues, or "do the mogo requests".
---

# MogoBot collaboration channel → fixes → patch notes → push

The familygo bot's requester posts bug reports and feature requests in a Discord channel; this
skill turns everything posted since the last patch notes into shipped code. Read the repo's
CLAUDE.md first — it documents familygo's jobs, db, dedupe and scheduling in depth, and every
change here has to stay consistent with it.

## Who and where

| What | Value |
|---|---|
| Collaboration channel | `1456432233870266504` (#collaboration) |
| Requester | **nukambabe** (`1045717565185466438`) — the server owner, not technical, runs the packaged .exe on her PC |
| Developer (the user) | **nukambe** (`99340850160467968`) |
| Bot account | **daBot** — familygo's `DISCORD_TOKEN` |
| familygo db channel | `1526768575816270035` (history of every db version) |
| Gift rotation log | `GIFT_ROTATION_CHANNEL_ID` in `.env` (cycle `STATE:` lines) |
| Daily events channel | `CHANNEL_ID` in `.env` |
| Unofficial spoilers | `1449448347965460553` |

All Discord access goes through the helper script, run from the repo root:

```bash
node --env-file=.env .claude/skills/mogo-collab/scripts/discord.mjs <command>
```

Commands: `since-notes`, `read <channel> [--limit N] [--after id] [--before id]`,
`message <channel> <id>` (raw JSON), `db [--history N] [--out file]`, `post <channel> <file>`,
`edit <channel> <id> <file>`. The header of `scripts/discord.mjs` documents them. Put scratch
files (patch-notes drafts, db dumps) in the session scratchpad, not the repo.

## Workflow

### 1. Collect what's new

Run `since-notes`. It prints daBot's latest `**Patch notes…` message and every message after
it — that marker is how "already handled" is tracked, so nothing else needs remembering. Also:

- Read the last patch notes themselves: a follow-up is often a reply to them ("will that
  happen?"), and anything they promised but that didn't land is still open.
- An empty-looking message is usually a **forward** (screenshot of a bot post) — the helper
  prints its `message_snapshots`; use `message` for the raw JSON when needed. Attachments are
  screenshots of what she saw; open them with Read if the text alone is ambiguous.
- Skim further back (`read … --limit 200`) when a message refers to something earlier.
- The user's own prompt may add requests or paste her words with placeholders like `<USER>`.
  Resolve placeholders from evidence (rotation log, rosters) and say what you resolved them to.

Make a list: each item is a **bug**, **feature request**, **question**, or **config change**.

### 2. Investigate before changing anything

Confirm every bug report against real data rather than the description — the reports are
accurate about symptoms but not causes:

- `db --history 50 --out <scratch>/dbs.json` and diff the relevant keys across versions to see
  *when* state changed (that's how a forgotten-id bug and a hand-set pause were told apart).
- Read the destination channel to see what the bot actually posted and when.
- The rotation channel's recent messages show manual vs scheduled picks (scheduled ones land
  at :30:0x).

Find the root cause in code. Note any other place with the same flaw (CLAUDE.md flags
duplicated logic, e.g. familygo/nukoko cooldowns).

**Questions** get answered in the patch notes; verify the answer against code and state first.

**Config changes** (pause dates, gifs, rosters, schedule) are made by her through the bot's own
slash commands (`/config`, `/gift-pool`, …). Never hand-write the db: tell her the exact command
in the patch notes, or add a command if none can do it.

If a request is ambiguous or needs a product decision only the user can make, ask the user
before implementing — briefly, with a recommended option.

### 3. Implement

- Follow CLAUDE.md conventions: new familygo commands go in `apps/familygo/commands/` **and**
  the `staticCommands` array in `commands/index.js` (the packaged .exe can't dynamic-import);
  options with dynamic values use autocomplete (routed in `index.js`); every job dedupes
  before doing work; wiki fetches cost a visible Chrome window, so never add runs — widen
  windows; times are `America/New_York`.
- State the bot needs between runs lives in the db (`db.lastPosts`, via `updateLastPosts`) or
  the relevant channel — never process memory, since the .exe restarts nightly.
- Prefer formats she already approved (her earlier posts show the exact markdown she wants;
  copy headings, emoji and spacing literally).
- Emoji ids must match the guild's live emoji (a re-uploaded emoji gets a new id).

### 4. Verify without the live wiki

Don't run the wiki-scraping jobs to test — each fetch opens a headed Chrome window on the
user's machine, and posting from a dev run would hit the live server. Instead:

- `node --check` every changed file.
- Exercise new pure logic in isolation (extract the function into a `node -e` script) with
  real inputs pulled from the db/channels — e.g. the real ids that triggered the bug.
- Don't run build checks (project convention; the user verifies live).

### 5. Update the docs

- `apps/familygo/CHANGELOG.md` — under `## [Unreleased]`, in `### Added` / `### Fixed` /
  `### Changed`, written for a user of the bot (what changed and why it matters).
- `CLAUDE.md` — update any paragraph whose description the change made untrue, and document
  new state keys or non-obvious design decisions there.

### 6. Post patch notes

Written for **nukambabe**: plain language, no code internals, commands in backticks.

```
**Patch notes: <topics, comma-separated>**
- <one bullet per change: what she'll notice, and the command/option name if there is one>
- <answers to her questions, as their own bullets>

These take effect with the next bot update.

**<Heading for anything she must do>**
1. <exact steps: which command, which option, what to pick — and how to check it worked>
```

- Keep it under 2000 characters (the helper refuses longer). Split into two messages only if
  unavoidable.
- If she has to *do* something (run a command, set a pause), give numbered steps, and say it
  only works once the bot has updated (`/update` pulls the new release immediately).
- Write the draft to a scratch file, `post 1456432233870266504 <file>`; posts go out with
  pings disabled. To amend notes already posted in this session, `edit` that message id
  rather than posting again.

### 7. Commit and push

- Stage only the files you changed — the working tree often holds the user's unrelated edits
  (e.g. other apps); leave those alone and mention them.
- One commit per coherent change set, message `familygo: <summary>` with a short bulleted
  body, ending with the attribution trailer from the system prompt.
- `git push origin main`. A push touching `apps/familygo/**` triggers the release workflow
  (`familygo-v<run>`); the .exe self-updates on its next launch or via `/update`.

### 8. Report back

Tell the user: each item found and what was done (or why not), how it was verified and what
wasn't tested live, the patch-notes link/id, the commit hash, and anything left for them —
decisions, unrelated working-tree changes left uncommitted, messages that arrived mid-run.
