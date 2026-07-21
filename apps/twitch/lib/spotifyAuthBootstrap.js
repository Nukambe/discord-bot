import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { request } from 'undici';
import 'dotenv/config';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-read-currently-playing';

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`
❌ Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env

Setup:
  1. Go to https://developer.spotify.com/dashboard, log in, "Create app".
  2. App name/description: anything. Redirect URI: ${REDIRECT_URI} (exact match required).
  3. Copy the Client ID and Client Secret into .env as SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.
  4. Re-run: npm run spotify:auth
`);
  process.exit(1);
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { shell: true, stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  }).toString();

  const res = await request('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (res.statusCode !== 200) {
    throw new Error(`Token exchange failed (${res.statusCode}): ${await res.body.text()}`);
  }

  return res.body.json();
}

const state = crypto.randomBytes(16).toString('hex');
const authorizeUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  scope: SCOPE,
  redirect_uri: REDIRECT_URI,
  state,
})}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error || !code || returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h1>Auth failed</h1><p>You can close this tab and check the terminal.</p>');
    console.error(`❌ Spotify auth failed: ${error || 'state mismatch or missing code'}`);
    server.close();
    process.exit(1);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Spotify connected</h1><p>You can close this tab now.</p>');
  server.close();

  try {
    const data = await exchangeCode(code);
    console.log('\n✅ Success! Add this to your .env:\n');
    console.log(`SPOTIFY_REFRESH=${data.refresh_token}\n`);
  } catch (err) {
    console.error('❌ Token exchange failed:', err.message || err);
    process.exit(1);
  }
});

server.listen(8888, '127.0.0.1', () => {
  console.log(`\nOpening browser to authorize Spotify access...\nIf it doesn't open automatically, visit:\n\n${authorizeUrl}\n`);
  openBrowser(authorizeUrl);
});
