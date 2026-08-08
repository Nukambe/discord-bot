/**
 * Where the frontend finds the EBS.
 *
 * Twitch serves extension files from its own CDN, so there is no server-side
 * templating available at request time — this value is baked in when the zip is
 * built. `npm run twitchext:package` rewrites the string below from
 * TWITCHEXT_EBS_URL, so edit the env var, not this file.
 */
export const EBS_URL = '__TWITCHEXT_EBS_URL__';

/** Guards against shipping a zip that still points at the placeholder. */
export function resolveEbsUrl() {
  if (EBS_URL.startsWith('__')) {
    // Local rig fallback so `npm run twitchext:ebs` + the rig work untouched.
    return 'http://localhost:8080';
  }
  return EBS_URL.replace(/\/$/, '');
}
