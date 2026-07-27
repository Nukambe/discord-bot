// Builds a standalone Windows package for apps/familygo (MogoBot):
//   dist/familygo/MogoBot.exe   - bundled app + Node runtime
//   dist/familygo/chrome-win/   - Playwright's Chromium (Cloudflare needs headed Chrome)
//   dist/familygo/.env          - config, copied from the real .env (familygo keys only)
//   dist/familygo/README.txt    - plain-language instructions
//
// Run: node build/familygo/build.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'dist', 'familygo');
const bundlePath = path.join(root, 'dist', 'familygo-bundle.cjs');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log('1/4 Bundling apps/familygo with esbuild...');
execFileSync('npx', [
  'esbuild', 'apps/familygo/index.js',
  '--bundle', '--platform=node', '--target=node20', '--format=cjs',
  '--packages=external',
  `--outfile=${bundlePath}`,
  '--log-level=warning',
], { cwd: root, stdio: 'inherit', shell: true });

console.log('2/4 Packaging with pkg (this downloads a base Node binary on first run)...');
execFileSync('npx', [
  'pkg', bundlePath,
  '-t', 'node22-win-x64',
  '-o', path.join(outDir, 'MogoBot.exe'),
  '--fallback-to-source',
], { cwd: root, stdio: 'inherit', shell: true });

console.log('3/4 Copying bundled Chromium...');
const chromiumCacheRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const chromiumDir = fs.existsSync(chromiumCacheRoot)
  ? fs.readdirSync(chromiumCacheRoot).find((d) => d.startsWith('chromium-') && !d.includes('headless_shell'))
  : null;
if (!chromiumDir) {
  console.warn('   ⚠️ Could not find a cached Chromium under %LOCALAPPDATA%\\ms-playwright — run `npx playwright install chromium` first, then re-run this build.');
} else {
  fs.cpSync(path.join(chromiumCacheRoot, chromiumDir, 'chrome-win'), path.join(outDir, 'chrome-win'), { recursive: true });
}

console.log('4/4 Writing config + README...');
const realEnvPath = path.join(root, '.env');
const FAMILYGO_KEYS = [
  'CLIENT_ID', 'DISCORD_TOKEN', 'GUILD_ID', 'CHANNEL_ID', 'GIFT_ROTATION_CHANNEL_ID',
  'ROLLER_CHANNEL_ID', 'WRECKER_CHANNEL_ID', 'BUILDER_CHANNEL_ID', 'COLLECTOR_CHANNEL_ID',
  'ANCHOR_CHANNEL_ID', 'OLY_CHANNEL_ID', 'MECH_CHANNEL_ID', 'MAJESTIC_CHANNEL_ID',
  'GAMER_CHANNEL_ID', 'TEST_CHANNEL_ID', 'IMG_CHANNEL_ID', 'FORTUNE_FLIP_CHANNEL_ID',
  'ROLLER_USER_ID', 'WRECKER_USER_ID', 'BUILDER_USER_ID', 'COLLECTOR_USER_ID',
  'ANCHOR_USER_ID', 'GAMER_USER_ID',
];
const realEnv = fs.existsSync(realEnvPath)
  ? Object.fromEntries(
      fs.readFileSync(realEnvPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^"|"$/g, '')])
    )
  : {};

const envLines = [
  '# Copied from the live bot config. Do not share this file — DISCORD_TOKEN is a secret.',
  ...FAMILYGO_KEYS.map((k) => `${k}=${realEnv[k] ?? ''}`),
  '',
  '# Cloudflare blocks headless Chrome on the wiki, so this must stay false.',
  'CHROME_HEADLESS=false',
];
fs.writeFileSync(path.join(outDir, '.env'), envLines.join('\n') + '\n');

console.log('Done -> dist/familygo/');
