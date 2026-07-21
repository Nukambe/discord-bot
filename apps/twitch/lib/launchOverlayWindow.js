import { spawn } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

const CHROME_PATHS = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
};

function findChrome() {
  const candidates = CHROME_PATHS[process.platform] ?? [];
  return candidates.find(p => p && existsSync(p)) ?? null;
}

/**
 * Opens the overlay URL in a chrome-less, fixed-size Chrome "app" window so
 * it can be captured 1:1 in OBS via Window Capture. Uses a dedicated
 * profile dir so it always opens a fresh window at the requested size, even
 * if a regular Chrome instance is already running.
 */
export function launchOverlayWindow(url, { width = 383, height = 1080 } = {}) {
  const chromePath = findChrome();

  if (!chromePath) {
    console.warn(`⚠️  Chrome not found — open ${url} manually for the OBS overlay window.`);
    return null;
  }

  const profileDir = path.join(os.tmpdir(), 'twitch-bot-overlay-profile');

  const child = spawn(
    chromePath,
    [
      `--app=${url}`,
      `--window-size=${width},${height}`,
      '--window-position=0,0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' }
  );

  child.unref();
  return child;
}
