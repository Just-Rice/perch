// Brings Perch Nest's core (github.com/perch-nest/core) into a project: Perch, Roost or Perch Nest itself.
//
// The project's core.json says which version of core it uses and where core's files go in it:
//   { "repo": "https://github.com/perch-nest/core.git", "ref": "v0.1.0",
//     "files": { "protocol/": "site/js/shared/", "relay/src/index.js": "relay/src/index.js", ... },
//     "keep": ["site/js/shared/product.js"] }
// A path ending in "/" copies every file of that folder. Files in "keep" are the project's own and never overwritten
// (product.js: the project's website address and its meeting points).
//
//   node scripts/sync-core.mjs                 fetch core at core.json's "ref" and copy its files in; writes core.lock
//   node scripts/sync-core.mjs --dir ../core   the same from a local checkout of core (for working on core itself)
//   node scripts/sync-core.mjs --check         CI: every file from core is exactly as core.lock records it, so nobody
//                                              has edited one here instead of in core (no network needed)
//
// Change a file that comes from core in core, tag a release there, then bump "ref" here and run this. That way a fix
// (above all a security fix) is made once and reaches every project the same.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOT = process.cwd();
const config = JSON.parse(readFileSync(join(ROOT, 'core.json'), 'utf8'));
const LOCK = join(ROOT, 'core.lock');
const args = process.argv.slice(2);
const sha = buf => createHash('sha256').update(buf).digest('hex');
const keep = new Set((config.keep ?? []).map(p => p.replace(/\\/g, '/')));

function filesIn(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...filesIn(f).map(x => join(name, x)));
    else out.push(name);
  }
  return out;
}

// Every [from in core, to in the project] pair the mapping names.
function plan(coreDir) {
  const pairs = [];
  for (const [from, to] of Object.entries(config.files)) {
    if (from.endsWith('/')) {
      for (const f of filesIn(join(coreDir, from))) pairs.push([join(from, f), join(to, f)]);
    } else {
      pairs.push([from, to]);
    }
  }
  return pairs.map(([a, b]) => [a.replace(/\\/g, '/'), b.replace(/\\/g, '/')]).filter(([, to]) => !keep.has(to));
}

if (args.includes('--check')) {
  if (!existsSync(LOCK)) { console.error('no core.lock: run node scripts/sync-core.mjs'); process.exit(1); }
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const bad = [];
  for (const [to, hash] of Object.entries(lock.files)) {
    const f = join(ROOT, to);
    if (!existsSync(f)) bad.push(`${to}: missing`);
    else if (sha(readFileSync(f)) !== hash) bad.push(`${to}: changed here; make the change in perch-nest/core instead`);
  }
  if (lock.ref !== config.ref) bad.push(`core.json asks for ${config.ref} but core.lock has ${lock.ref}: run node scripts/sync-core.mjs`);
  if (bad.length) { console.error(`Files from Perch Nest's core don't match core.lock:\n  ${bad.join('\n  ')}`); process.exit(1); }
  console.log(`core ${lock.ref} (${lock.commit.slice(0, 7)}): ${Object.keys(lock.files).length} files as they should be`);
  process.exit(0);
}

let coreDir;
let temp = null;
const at = args.indexOf('--dir');
if (at >= 0) {
  coreDir = args[at + 1];
} else {
  temp = mkdtempSync(join(tmpdir(), 'perch-nest-core-'));
  execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', config.ref, config.repo, temp], { stdio: 'inherit' });
  coreDir = temp;
}
let commit = 'local';
try { commit = execFileSync('git', ['-C', coreDir, 'rev-parse', 'HEAD']).toString().trim(); } catch {}

// Files an older core gave that this one no longer has are removed.
const old = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')).files : {};
const files = {};
for (const [from, to] of plan(coreDir)) {
  const dest = join(ROOT, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(coreDir, from), dest);
  files[to] = sha(readFileSync(dest));
}
for (const to of Object.keys(old)) if (!(to in files) && !keep.has(to)) rmSync(join(ROOT, to), { force: true });
writeFileSync(LOCK, JSON.stringify({ repo: config.repo, ref: config.ref, commit, files }, null, 2) + '\n');
if (temp) rmSync(temp, { recursive: true, force: true });
console.log(`core ${config.ref} (${commit.slice(0, 7)}): ${Object.keys(files).length} files → ${relative(process.cwd(), ROOT) || '.'}`);
