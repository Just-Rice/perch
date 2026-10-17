// Updates: asks GitHub whether a newer Perch has been released, and installs it with the same one-line script people
// used to install Perch in the first place (it downloads the release, checks its checksum, quits Perch, replaces it
// and opens it again).
//
// Checking never throws: no network, GitHub being down or a strange answer all simply mean "no update right now".
import { spawn } from 'node:child_process';

export const REPO = 'Just-Rice/perch';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
export const INSTALL_COMMAND = 'curl -fsSL https://just-rice.github.io/perch/install.sh | bash -s -- --update';
const TIMEOUT_MS = 10_000;
const NOTES_MAX = 500;

const defaultLog = (msg) => console.error(msg);

// --- versions (Semantic Versioning 2.0.0) ---

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// '1.2.3', 'v1.2.3-beta.2+build.5' -> {major, minor, patch, pre: ['beta', 2]}; null if it isn't a version.
export function parseVersion(text) {
  const m = SEMVER.exec(String(text ?? '').trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  // Leading zeros aren't allowed in numeric pre-release parts ("01").
  if (m[4] && m[4].split('.').some(id => /^0\d+$/.test(id))) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre };
}

// Negative when a < b, 0 when equal, positive when a > b. Build metadata is ignored, and a pre-release
// ("1.0.0-beta") comes before its release ("1.0.0"), as the SemVer rules say.
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error('not a version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    const pn = typeof p === 'number', qn = typeof q === 'number';
    if (pn && qn) return p - q;
    if (pn !== qn) return pn ? -1 : 1; // numbers sort before words
    return p < q ? -1 : 1;
  }
  return 0;
}

// --- checking ---

// The release notes, as plain text cut to about 500 characters on a word boundary.
function shortNotes(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length <= NOTES_MAX) return text;
  const cut = text.slice(0, NOTES_MAX);
  const space = cut.search(/\s\S*$/);
  return `${(space > NOTES_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Only ever link to this project's own release pages, whatever the answer says.
function releasePage(release, tag) {
  const url = typeof release.html_url === 'string' ? release.html_url : '';
  if (url.startsWith(`https://github.com/${REPO}/releases/`)) return url;
  return `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
}

// Resolves to {version, url, notes} when GitHub's latest release is newer than `currentVersion`, otherwise null.
export async function checkForUpdate(currentVersion, { fetchImpl = globalThis.fetch, log = defaultLog, timeoutMs = TIMEOUT_MS } = {}) {
  const current = parseVersion(currentVersion);
  if (!current) {
    log(`updater: this copy's version "${currentVersion}" isn't a version number; not checking`);
    return null;
  }
  let release;
  try {
    const res = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        'User-Agent': `Perch/${currentVersion} (+https://just-rice.github.io/perch/)`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) {
      // 404 means no release has been published yet; 403/429 means GitHub's hourly limit for this address.
      log(`updater: GitHub answered ${res.status}`);
      return null;
    }
    release = await res.json();
  } catch (e) {
    log(`updater: couldn't check for updates (${e?.name === 'TimeoutError' ? 'timed out' : e?.message || e})`);
    return null;
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    log('updater: GitHub sent something that isn\'t a release');
    return null;
  }
  if (release.draft || release.prerelease) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const latest = parseVersion(tag);
  if (!latest) {
    log(`updater: the latest release's tag "${tag.slice(0, 40)}" isn't a version number`);
    return null;
  }
  if (compareVersions(latest, current) <= 0) return null;
  return {
    version: tag.replace(/^v/, '').replace(/\+.*$/, ''),
    url: releasePage(release, tag),
    notes: shortNotes(release.body),
  };
}

// --- installing ---

// Starts the install script in its own process group so it outlives this process: the script quits Perch (which
// ends this host process too), replaces the app and opens it again. It always installs the latest release, so it
// needs nothing about the update; `options` may carry {log} (and {spawnImpl} in tests), and anything else is ignored.
export function installUpdate(options) {
  const { spawnImpl = spawn, log = defaultLog } = options ?? {};
  const child = spawnImpl('/bin/bash', ['-c', INSTALL_COMMAND], { detached: true, stdio: 'ignore', cwd: '/' });
  child.on?.('error', (e) => log(`updater: couldn't start the update (${e.message})`));
  child.unref();
  log('updater: update started');
  return { started: true };
}
