// Puts the two websites together for the relay to serve from its own address, the same way GitHub Pages has them:
// Perch's (mac/site/) at /, Roost's (windows/site/) at /windows/. Wrangler runs this before `wrangler dev` and
// `wrangler deploy` (wrangler.toml, [build]); the result, .site/, isn't kept in git.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '.site');
rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'mac', 'site'), out, { recursive: true });
cpSync(join(root, 'windows', 'site'), join(out, 'windows'), { recursive: true });
