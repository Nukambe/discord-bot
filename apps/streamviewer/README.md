# streamviewer

Opens [methstreams](https://methstreams.gs) in a Chrome window and cleans up every game page so it shows only:

- the site header (to get back to the league lists),
- the link selector (Link-1 / Link-2 / ...),
- the video player, stretched to fill the rest of the window.

League and home pages are left as they are, so you browse to a game normally and it gets cleaned up when it opens. Popup tabs opened by ads are closed straight away, and anything ads add to a game page later is removed.

## Running it

From the repo root:

```bash
npm run streamviewer
# or start on a different page:
node apps/streamviewer/index.js https://methstreams.gs/league/nflstreams
```

It opens on the NBA list by default and keeps running until you close the window.

## Requirements

- Google Chrome installed. It uses `CHROME_PATH` from the root `.env` if set, otherwise `C:/Program Files/Google/Chrome/Application/chrome.exe`.
- Root dependencies installed (`npm install`). It uses the repo's `playwright-core`, which drives your installed Chrome, so no separate browser download is needed.

## How it works

The cleanup is a Playwright init script, so it runs at the start of every page load in the window, not just the first one. On `/stream/` pages it:

1. adds a stylesheet that hides everything except `header` and `.player-container` and lays them out as a full-height column, with the player's iframe set to 100% width and height;
2. once the page has loaded, removes every other element from `<body>`, and keeps watching so anything added later is removed too.

The site's own link-switching code is untouched, so changing links still works and the new stream fills the window too.

A second init script keeps the stream playing. It runs inside the player's iframes too, since that's where the `<video>` is. Chrome is started with `--autoplay-policy=no-user-gesture-required`, so the video can start without a click. Then, every two seconds:

- a video that paused on its own is played again. If you clicked or pressed a key in the player just before it paused, that pause counts as yours and is left alone until you press play;
- a video that's "playing" but has been frozen for about 6 seconds, with more video already loaded ahead of it, jumps forward past the stuck spot.

Each restart is logged in the terminal as `[streamviewer] resumed (...)`. If Chrome still won't play it with sound, it plays it muted instead and says so in the log.

## Limitations

- The stream keeps its own 16:9 shape, so a window wider than that shows black bars on the sides. Use the player's fullscreen button to avoid them.
- Ads *inside* the stream come from the third-party player in the iframe, which the page can't edit, so those stay.
- Auto-resume can't fix a stream that has stopped sending video (nothing new loaded). Switch links when that happens.
- If methstreams renames `.player-container`, `#linkSelector` or `#videoPlayer`, the cleanup stops matching and needs updating.
