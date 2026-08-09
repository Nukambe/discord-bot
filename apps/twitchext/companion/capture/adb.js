import { spawn } from 'node:child_process';

/**
 * Frame grabber built on `adb exec-out screencap`.
 *
 * We ask for the raw buffer rather than `-p` (PNG) on purpose: raw is already
 * RGBA, so there is nothing to decode and no image dependency to install. It
 * costs more USB/loopback bandwidth, which is irrelevant against a local
 * emulator. `exec-out` (not `shell`) is required — `adb shell` mangles 0x0a
 * bytes into CRLF on Windows and silently corrupts every frame.
 */

const ADB = process.env.ADB_PATH || 'adb';

export async function listDevices() {
  const { stdout } = await run(ADB, ['devices'], { encoding: 'utf8' });
  return stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0]);
}

/**
 * Captures one frame.
 * @returns {Promise<{width:number,height:number,data:Buffer}>} tightly packed RGBA.
 */
export async function captureFrame({ serial } = {}) {
  const args = serial ? ['-s', serial, 'exec-out', 'screencap'] : ['exec-out', 'screencap'];
  const { stdout } = await run(ADB, args);
  return parseScreencap(stdout);
}

/**
 * screencap's header is width/height/format as LE uint32. Android 9 added a
 * fourth colorspace field, so the pixel offset is either 12 or 16 bytes — we
 * work out which by checking the payload size against width*height*4 rather
 * than sniffing the OS version.
 */
export function parseScreencap(buf) {
  if (buf.length < 16) throw new Error(`screencap returned ${buf.length} bytes; is the device awake?`);

  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const format = buf.readUInt32LE(8);

  if (!width || !height || width > 8192 || height > 8192) {
    throw new Error(`screencap header looks wrong (${width}x${height}); try \`adb exec-out screencap -p\``);
  }

  const expected = width * height * 4;
  let offset;
  if (buf.length - 12 === expected) offset = 12;
  else if (buf.length - 16 === expected) offset = 16;
  else throw new Error(`screencap payload is ${buf.length - 12} bytes, expected ${expected} for ${width}x${height}`);

  // 1 = RGBA_8888, 2 = RGBX_8888. Both are 4 bytes/px in RGBA order, so both work.
  if (format !== 1 && format !== 2) {
    throw new Error(`unsupported screencap pixel format ${format}; expected RGBA_8888`);
  }

  return { width, height, data: buf.subarray(offset, offset + expected) };
}

function run(cmd, args, { encoding } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = [];
    const err = [];

    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));

    child.on('error', e => {
      reject(
        e.code === 'ENOENT'
          ? new Error(`Could not run "${cmd}". Install platform-tools or set ADB_PATH.`)
          : e
      );
    });

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString().trim()}`));
      }
      const stdout = Buffer.concat(out);
      resolve({ stdout: encoding ? stdout.toString(encoding) : stdout });
    });
  });
}
