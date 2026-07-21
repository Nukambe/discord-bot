import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const ENV_PATH = path.resolve(process.cwd(), '.env');

export function updateEnvVar(key, value) {
  if (!existsSync(ENV_PATH)) return;

  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const pattern = new RegExp(`^${key}=`);
  let found = false;

  const next = lines.map(line => {
    if (pattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) next.push(`${key}=${value}`);

  writeFileSync(ENV_PATH, next.join('\n'));
}
