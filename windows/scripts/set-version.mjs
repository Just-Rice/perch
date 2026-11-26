// Sets Roost's version everywhere it is written down: the app (app/Cargo.toml) and the host (host/package.json).
// Usage: node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v ?? '')) {
  console.error('usage: node scripts/set-version.mjs <x.y.z>');
  process.exit(1);
}
const root = new URL('..', import.meta.url);
const cargo = new URL('app/Cargo.toml', root);
writeFileSync(cargo, readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${v}"`));
const pkg = new URL('host/package.json', root);
const json = JSON.parse(readFileSync(pkg, 'utf8'));
json.version = v;
writeFileSync(pkg, JSON.stringify(json, null, 2) + '\n');
console.log(`Roost ${v}: app/Cargo.toml, host/package.json`);
