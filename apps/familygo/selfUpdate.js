// Self-update check run at launch, before the bot logs in.
//
// Only does anything for the packaged exe (process.pkg) — a no-op when run
// from source. Checks the latest GitHub release; if it's newer than what's
// installed, downloads it, swaps the running exe's files for the new ones,
// and relaunches. Any failure here just logs a warning and lets the current
// build start normally — an update check must never keep the bot offline.
//
// Every outcome prints a timestamped line, including the boring ones ("up to
// date", "first launch"). There's no log file and the console doesn't survive a
// relaunch, so a silent path is indistinguishable from the check never running —
// which is exactly the question anyone debugging this build starts with.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toEstDateString, toEstTimeParts } from '../../util/dateUtils.js';

const REPO = process.env.UPDATER_GITHUB_REPO || 'Nukambe/discord-bot';

/**
 * Timestamp prefix for the update log, e.g. "[2026-08-20 19:44 ET]".
 *
 * These lines are the only record of whether the updater ran — the packaged app writes no
 * log file, and once it relaunches, the console it was printing to is gone — so every one
 * of them is stamped. Built from typed Intl parts rather than a locale string for the same
 * reason util/dateUtils.js exists: pkg's bundled Node formats locale strings differently.
 */
const stamp = () => {
    const now = new Date();
    const { hour, minute } = toEstTimeParts(now);
    return `[${toEstDateString(now)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET]`;
};

const githubRequest = async (url, accept) => {
    const res = await fetch(url, {
        headers: {
            Accept: accept,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'familygo-self-update',
        },
    });
    if (!res.ok) {
        throw new Error(`GitHub request failed (${res.status} ${res.statusText}) for ${url}`);
    }
    return res;
};

/**
 * @returns {Promise<boolean>} true if an update was installed and a new
 *   process has been spawned — the caller should exit immediately without
 *   starting the bot. false if it's safe to continue starting normally.
 */
export async function checkForUpdatesAndMaybeRestart() {
    if (!process.pkg) {
        console.log(`${stamp()} ℹ️ Running from source — skipping update check.`);
        return false;
    }

    const appDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath);
    const versionFile = path.join(appDir, 'familygo-version.txt');

    console.log(`${stamp()} 🔎 Checking ${REPO} for a newer MogoBot release...`);

    let release;
    try {
        release = await (await githubRequest(
            `https://api.github.com/repos/${REPO}/releases/latest`,
            'application/vnd.github+json',
        )).json();
    } catch (err) {
        console.warn(`${stamp()} ⚠️ Update check failed, continuing with current build: ${err.message}`);
        return false;
    }

    const latestTag = release.tag_name;
    const installedTag = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;

    if (!installedTag) {
        // First launch after a fresh install — record the baseline instead of
        // immediately re-downloading whatever was just installed.
        fs.writeFileSync(versionFile, latestTag);
        console.log(`${stamp()} 📌 First launch — recorded installed version as ${latestTag}.`);
        return false;
    }

    if (latestTag === installedTag) {
        console.log(`${stamp()} ✅ MogoBot is up to date (${installedTag}). Starting...`);
        return false;
    }

    console.log(`${stamp()} ⬆️ Updating MogoBot ${installedTag} -> ${latestTag}...`);
    try {
        const asset = release.assets?.find((a) => a.name.endsWith('.zip'));
        if (!asset) throw new Error(`Release ${latestTag} has no .zip asset attached.`);

        const assetRes = await githubRequest(asset.url, 'application/octet-stream');
        const zipPath = path.join(os.tmpdir(), `familygo-${latestTag}.zip`);
        fs.writeFileSync(zipPath, Buffer.from(await assetRes.arrayBuffer()));

        const extractDir = path.join(os.tmpdir(), `familygo-${latestTag}-extract`);
        fs.rmSync(extractDir, { recursive: true, force: true });
        execFileSync('powershell.exe', [
            '-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
        ]);

        // Windows lets a running exe's backing file be renamed aside even
        // while it's executing — that's what makes swapping it in place safe.
        const currentExePath = path.join(appDir, exeName);
        fs.renameSync(currentExePath, `${currentExePath}.old`);

        fs.cpSync(extractDir, appDir, {
            recursive: true,
            force: true,
            filter: (src) => path.basename(src) !== '.env',
        });
        fs.rmSync(`${currentExePath}.old`, { force: true });
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.rmSync(zipPath, { force: true });
        fs.writeFileSync(versionFile, latestTag);

        console.log(`${stamp()} ✅ Update installed (now ${latestTag}). Relaunching in a new window...`);

        // Launched through `cmd /c start` rather than spawned directly so the new instance
        // gets a console of its own and its output stays visible. Spawning it detached with
        // stdio 'ignore' — what this did before — left the updated bot running with nowhere
        // to print, so from the user's side an update looked like the app simply vanished.
        // Inheriting this process's stdio isn't an option either: we exit immediately after,
        // taking the console with us. The empty string is `start`'s window-title argument,
        // which has to be present or a quoted exe path gets consumed as the title instead.
        spawn('cmd.exe', ['/c', 'start', '', currentExePath], {
            cwd: appDir,
            detached: true,
            stdio: 'ignore',
        }).unref();
        return true;
    } catch (err) {
        console.warn(`${stamp()} ⚠️ Update failed, continuing with current build: ${err.message}`);
        return false;
    }
}
