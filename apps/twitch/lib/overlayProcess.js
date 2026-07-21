import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { request } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request(url);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(`Overlay server didn't start within ${timeoutMs}ms`);
}

/**
 * Spawns the Vite dev server for apps/twitch/web (which hosts the React
 * overlay plus the /events SSE + /events/push routes, see
 * vite-events-plugin.js) and waits for it to be reachable.
 */
export async function startOverlay({ port = 5183 } = {}) {
  const url = `http://localhost:${port}`;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const child = spawn(npmCmd, ['run', 'dev'], {
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  child.stdout.on('data', d => process.stdout.write(`[overlay] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[overlay] ${d}`));
  child.on('exit', code => {
    if (code) console.error(`❌ Overlay dev server exited with code ${code}`);
  });

  await waitForServer(url);

  async function push(type, data) {
    try {
      const qs = new URLSearchParams({ type, data: JSON.stringify(data) });
      await request(`${url}/events/push?${qs.toString()}`);
    } catch (err) {
      console.error('overlay push failed:', err?.message || err);
    }
  }

  return { url, push, child, stop: () => child.kill() };
}
