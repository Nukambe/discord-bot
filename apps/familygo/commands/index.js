// Static registry of familygo commands. util/loadCommands.js normally discovers
// these via a runtime directory scan + dynamic import(), which works fine in
// dev/Heroku but can't be resolved once this app is bundled into a packaged
// exe (pkg's snapshot isn't reachable through Node's real ESM import() loader).
// This static list lets the packaged build reach the same command modules
// through an ordinary static import, which bundlers can inline.
import config from "./config.js";
import freeDice from "./free-dice.js";
import futureEvents from "./future-events.js";
import giftRotation from "./giftRotation.js";
import highRoller from "./highRoller.js";
import next from "./next.js";
import openVault from "./openVault.js";
import ping from "./ping.js";
import postDaily from "./postDaily.js";
import skip from "./skip.js";
import stickerRequest from "./sticker-request.js";

export const staticCommands = [
  config,
  freeDice,
  futureEvents,
  giftRotation,
  highRoller,
  next,
  openVault,
  ping,
  postDaily,
  skip,
  stickerRequest,
];
