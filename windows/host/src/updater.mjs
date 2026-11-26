// Updates: asks GitHub whether a newer Roost has been released (Roost lives in Perch's repository, under windows/, and
// its releases are the ones tagged windows-v<version>; the others are Perch's, for the Mac), and installs it with the same PowerShell script people
// used to install Roost in the first place (install.ps1: it downloads the release zip for this PC's processor
// (Roost-<version>-win-x64.zip or -win-arm64.zip), checks it against its .sha256, quits Roost, replaces it and starts
// it again).
//
// Checking never throws: no network, GitHub being down or a strange answer all simply mean "no update right now".
import { spawn } from 'node:child_process';
import { existsSync, readFile } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const REPO = 'Just-Rice/perch';
// The newest releases first. Perch's and Roost's are mixed, and "latest" is always Perch's, so Roost picks out its own.
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
export const TAG_PREFIX = 'windows-';
export const SITE = 'https://just-rice.github.io/perch/windows/';
// Used when the installed copy has no install.ps1 beside it (an older or hand-made install).
export const INSTALL_SCRIPT_URL = `${SITE}install.ps1`;
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

// Resolves to {version, url, notes} when Roost's newest release is newer than `currentVersion`, otherwise null.
export async function checkForUpdate(currentVersion, { fetchImpl = globalThis.fetch, log = defaultLog, timeoutMs = TIMEOUT_MS } = {}) {
  const current = parseVersion(currentVersion);
  if (!current) {
    log(`updater: this copy's version "${currentVersion}" isn't a version number; not checking`);
    return null;
  }
  let releases;
  try {
    const res = await fetchImpl(RELEASES_API, {
      headers: {
        'User-Agent': `Roost/${currentVersion} (+${SITE})`,
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
    releases = await res.json();
  } catch (e) {
    log(`updater: couldn't check for updates (${e?.name === 'TimeoutError' ? 'timed out' : e?.message || e})`);
    return null;
  }
  if (!Array.isArray(releases)) {
    log('updater: GitHub sent something that isn\'t a list of releases');
    return null;
  }
  // The newest of Roost's own releases (drafts and pre-releases aside).
  const release = releases.find(r => r && typeof r === 'object' && !r.draft && !r.prerelease
    && typeof r.tag_name === 'string' && r.tag_name.trim().startsWith(TAG_PREFIX));
  if (!release) {
    log('updater: no Roost release yet');
    return null;
  }
  const tag = release.tag_name.trim();
  const latest = parseVersion(tag.slice(TAG_PREFIX.length));
  if (!latest) {
    log(`updater: the latest release's tag "${tag.slice(0, 40)}" isn't a version number`);
    return null;
  }
  if (compareVersions(latest, current) <= 0) return null;
  return {
    version: tag.slice(TAG_PREFIX.length).replace(/^v/, '').replace(/\+.*$/, ''),
    url: releasePage(release, tag),
    notes: shortNotes(release.body),
  };
}

// --- installing ---

// Windows' own PowerShell, by its full path when Windows says where it is, so a powershell.exe elsewhere on the PATH
// (in a folder another program added) can't stand in for it.
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

// What installUpdate runs: install.ps1 from the installed copy when it has one, otherwise the one on the website,
// fetched and run in the same PowerShell. Both with -Update, so the script installs the latest release over this one
// and starts Roost again. Returns {cmd, args}.
export function installCommand({ installDir = null, env = process.env, exists = existsSync } = {}) {
  const cmd = powershellPath(env);
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  const local = installDir ? path.join(installDir, 'install.ps1') : null;
  if (local && exists(local)) return { cmd, args: [...base, '-File', local, '-Update'] };
  // TLS 1.2 first: Windows PowerShell 5.1 on an older Windows 10 may not offer it by default, and GitHub needs it.
  // DownloadString always gives text, whatever type the website labels the file with.
  const script = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor ' +
    '[Net.SecurityProtocolType]::Tls12; ' +
    `& ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('${INSTALL_SCRIPT_URL}'))) -Update`;
  return { cmd, args: [...base, '-Command', script] };
}

// Starts the install script detached, so it outlives this process: the script quits Roost (which ends this host
// process too), replaces it and starts it again. It always installs the latest release, so it needs nothing about the
// update; `options` may carry {log, installDir} (and {spawnImpl, env, exists} in tests), and anything else is ignored.
export function installUpdate(options) {
  const { spawnImpl = spawn, log = defaultLog, installDir = null, env = process.env, exists = existsSync } = options ?? {};
  const { cmd, args } = installCommand({ installDir, env, exists });
  const child = spawnImpl(cmd, args, {
    detached: true, stdio: 'ignore', windowsHide: true,
    // Not from inside the install folder: the script replaces it, and Windows won't remove a folder in use.
    cwd: tmpdir(),
  });
  child.on?.('error', (e) => log(`updater: couldn't start the update (${e.message})`));
  child.unref();
  log(`updater: update started (${args.includes('-File') ? 'install.ps1 from the installed copy' : 'install.ps1 from the website'})`);
  return { started: true };
}

// --- finishing an update ---
//
// An update only takes effect once Roost has restarted. installedVersion looks at the copy on disk, so the host can
// tell when it differs from the one running (an update that replaced the files but couldn't restart Roost) and say so.

// The version in <installDir>\VERSION (the installer writes it, e.g. "0.1.0"), or null: no install folder, the file
// missing or mid-write, or not a version number.
export function installedVersion(installDir, { readFileImpl = readFile } = {}) {
  if (!installDir) return Promise.resolve(null);
  return new Promise((resolve) => {
    readFileImpl(path.join(installDir, 'VERSION'), 'utf8', (err, text) => {
      const v = err ? '' : String(text ?? '').replace(/^\uFEFF/, '').trim();
      resolve(parseVersion(v) && v.length <= 64 ? v : null);
    });
  });
}
