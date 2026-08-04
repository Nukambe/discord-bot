// Self-update check run at launch, before the bot logs in.
//
// Only does anything for the packaged exe (process.pkg) — a no-op when run
// from source. Checks the latest GitHub release; if it's newer than what's
// installed, downloads it, swaps the running exe's files for the new ones,
// and relaunches. Any failure here just logs a warning and lets the current
// build start normally — an update check must never keep the bot offline.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.UPDATER_GITHUB_REPO || 'Nukambe/discord-bot';
const TOKEN = process.env.UPDATER_GITHUB_TOKEN;

const githubRequest = async (url, accept) => {
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${TOKEN}`,
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
    if (!process.pkg || !TOKEN) return false;

    const appDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath);
    const versionFile = path.join(appDir, 'familygo-version.txt');

    let release;
    try {
        release = await (await githubRequest(
            `https://api.github.com/repos/${REPO}/releases/latest`,
            'application/vnd.github+json',
        )).json();
    } catch (err) {
        console.warn(`⚠️ Update check failed, continuing with current build: ${err.message}`);
        return false;
    }

    const latestTag = release.tag_name;
    const installedTag = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;

    if (!installedTag) {
        // First launch after a fresh install — record the baseline instead of
        // immediately re-downloading whatever was just installed.
        fs.writeFileSync(versionFile, latestTag);
        return false;
    }

    if (latestTag === installedTag) return false;

    console.log(`⬆️ Updating MogoBot ${installedTag} -> ${latestTag}...`);
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

        console.log('✅ Update installed, relaunching...');
        spawn(currentExePath, [], { cwd: appDir, detached: true, stdio: 'ignore' }).unref();
        return true;
    } catch (err) {
        console.warn(`⚠️ Update failed, continuing with current build: ${err.message}`);
        return false;
    }
}
