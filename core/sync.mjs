// Perch (mac/) and Roost (windows/) share some code, written once here in core/:
//   core/protocol/  the protocol a website and a computer speak (each project's copy: <project>/site/js/shared/)
//   core/site/      the parts of the websites that are the same on both (the "Mac · Windows" switch and the
//                   home-screen offer: <project>/site/js/platform.js and css/platform.css)
// Each project keeps its own copy, so it stays whole on its own (its website is published as it is, and its app
// bundles it). This keeps those copies exactly the same as core.
//
//   node core/sync.mjs           copy core into both projects (after changing something in core/)
//   node core/sync.mjs --check   CI: both projects' copies are exactly core's, so nobody changed only one copy
//
// A project's own files beside the copies are never touched: its product.js (its website address and meeting
// points), Perch's cipher.js, Roost's ember.js.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = ['mac', 'windows'];
const SETS = [['core/protocol', 'site/js/shared'], ['core/site', 'site']]; // [in core, in each project]

function filesIn(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...filesIn(f).map(x => join(name, x)));
    else out.push(name);
  }
  return out;
}
const pairs = [];
for (const [from, to] of SETS) {
  for (const f of filesIn(join(ROOT, from))) {
    for (const p of PROJECTS) pairs.push([`${from}/${f}`, `${p}/${to}/${f}`]);
  }
}

if (process.argv.includes('--check')) {
  const bad = [];
  for (const [from, to] of pairs) {
    if (!existsSync(join(ROOT, to))) bad.push(`${to}: missing`);
    else if (!readFileSync(join(ROOT, to)).equals(readFileSync(join(ROOT, from)))) bad.push(`${to}: differs from ${from}`);
  }
  if (bad.length) {
    console.error(`Shared code must be changed in core/, then copied with node core/sync.mjs:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`core: ${pairs.length / PROJECTS.length} files, the same in ${PROJECTS.join(' and ')}`);
} else {
  for (const [from, to] of pairs) {
    mkdirSync(dirname(join(ROOT, to)), { recursive: true });
    copyFileSync(join(ROOT, from), join(ROOT, to));
  }
  console.log(`copied ${pairs.length / PROJECTS.length} files from core/ into ${PROJECTS.join(' and ')}`);
}
