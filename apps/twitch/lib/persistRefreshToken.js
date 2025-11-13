import { request } from "undici";

export async function persistRefreshToHeroku(newRefresh) {
  if (!process.env.HEROKU_API_KEY || !process.env.HEROKU_APP_NAME) return;

  // Avoid unnecessary restarts: only update if it changed.
  if (newRefresh === process.env.TWITCH_REFRESH) return;

  const url = `https://api.heroku.com/apps/${process.env.HEROKU_APP_NAME}/config-vars`;
  const res = await request(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
      Accept: "application/vnd.heroku+json; version=3",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ TWITCH_REFRESH: newRefresh }),
  });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    console.log("🔐 Heroku config updated: TWITCH_REFRESH");
    // Heroku will restart the dyno when config changes.
  } else {
    const text = await res.body.text();
    console.error("Heroku config update failed:", res.statusCode, text);
  }
}
