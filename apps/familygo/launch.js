// Packaged entry point (see build/familygo/build.mjs). Runs the self-update
// check before the real app ever loads, so an update never races against an
// already-logged-in Discord client. index.js is only imported — starting the
// bot — when no update was installed this launch.
import "dotenv/config";
import { checkForUpdatesAndMaybeRestart } from "./selfUpdate.js";

checkForUpdatesAndMaybeRestart().then((restarting) => {
    if (!restarting) {
        import("./index.js");
    }
});
