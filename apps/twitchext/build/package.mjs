import 'dotenv/config';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the zip you upload in the Twitch extension console.
 *
 * Twitch serves extension assets from its own CDN with no build step and a
 * strict CSP, so the only thing to do here is bake the EBS URL into env.js and
 * archive the frontend. Everything must be self-contained: the Twitch helper
 * script is the sole permitted external reference.
 */

const frontendDir = fileURLToPath(new URL('../frontend/', import.meta.url));
const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const zipPath = path.join(distDir, 'twitchext-frontend.zip');

const ebsUrl = process.env.TWITCHEXT_EBS_URL || 'http://127.0.0.1:8080';

// http:// is only safe for loopback. Browsers treat localhost and 127.0.0.1 as
// trustworthy origins, so an HTTPS extension page may call them without being
// blocked as mixed content — but any other http:// host is blocked outright.
const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ebsUrl.replace(/\/$/, ''));

if (!ebsUrl.startsWith('https://') && !isLoopback) {
  console.error(`TWITCHEXT_EBS_URL must be https:// unless it is loopback (got "${ebsUrl}")`);
  process.exit(1);
}

if (isLoopback) {
  console.warn(
    '⚠️  Building against a loopback EBS. This works for you and anyone running\n' +
      '    the EBS on their own machine, but a remote viewer\'s browser resolves\n' +
      '    localhost to THEIR machine, so they will see no tooltips. Point\n' +
      '    TWITCHEXT_EBS_URL at a tunnel or host before going live.\n'
  );
}

const staging = await mkdtemp(path.join(tmpdir(), 'twitchext-'));

try {
  await cp(frontendDir, staging, { recursive: true });

  const envPath = path.join(staging, 'src', 'env.js');
  const source = await readFile(envPath, 'utf8');
  await writeFile(envPath, source.replace('__TWITCHEXT_EBS_URL__', ebsUrl.replace(/\/$/, '')));

  await mkdir(distDir, { recursive: true });
  await rm(zipPath, { force: true });
  await zip(staging, zipPath);

  const { size } = await import('node:fs').then(fs => fs.promises.stat(zipPath));
  console.log(`📦 ${zipPath} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`   EBS: ${ebsUrl}`);
  console.log('\nUpload it under Extension → Files → Asset Hosting, with these paths:');
  console.log('   Video - Fullscreen / Video - Component  →  video_overlay.html');
  console.log('   Config                                   →  config.html');
} finally {
  await rm(staging, { recursive: true, force: true });
}

/**
 * Shells out rather than adding an archiver dependency. `zip` exists on macOS
 * and Linux; PowerShell covers Windows.
 */
function zip(sourceDir, outPath) {
  const isWindows = process.platform === 'win32';
  const [cmd, args] = isWindows
    ? ['powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${outPath}' -Force`]]
    : ['zip', ['-r', '-q', outPath, '.']];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: sourceDir, stdio: 'inherit', windowsHide: true });
    child.on('error', err => {
      reject(
        err.code === 'ENOENT'
          ? new Error(`"${cmd}" not found. Install it, or zip ${sourceDir} by hand.`)
          : err
      );
    });
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}
