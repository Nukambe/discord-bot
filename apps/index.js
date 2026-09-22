import { startChappelly } from "./chappelly/index.js";

/**
 * Combined entry point: runs nukoko and chappelly in one process so the two
 * bots share a single dyno (see Procfile). Neither app knows about the other —
 * nukoko/index.js is the same top-level script it always was, and chappelly
 * is started through its exported startChappelly().
 *
 * chappelly starts first so its shutdown hook is registered ahead of nukoko's,
 * which calls process.exit() once its own client is logged out.
 */

const chappelly = startChappelly();
["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => chappelly.stop()));

// Evaluating the module is what boots nukoko.
await import("./nukoko/index.js");
