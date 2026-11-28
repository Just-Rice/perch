// Builds the host into one file for the app bundle: dist/perch-host.mjs (the app runs
// Contents/Resources/host/perch-host.mjs), with the Setup page's files beside it in dist/setup/.
// Run from host/node:  node scripts/bundle.mjs   (needs the esbuild dev dependency)
//
// Everything the host needs is inside the one .mjs file: werift, the WebAuthn checks, the OPAQUE library (its
// WebAssembly is embedded in the library itself), the shared site modules and package.json's version. The Setup
// page's static files can't be bundled, so they are copied; main.mjs looks for them next to the bundle.
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const OPAQUE_FOR_BROWSERS = join(ROOT, '..', '..', 'site', 'js', 'vendor', 'opaque', 'index.js');

export async function bundle({ outDir = OUT } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'perch-host.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'main.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // werift's ESM build still has CommonJS dependencies (debug and friends) that call require() for Node's own
    // modules; an ESM bundle needs a real require for those.
    banner: { js: "import { createRequire as __perchCreateRequire } from 'node:module';\nconst require = __perchCreateRequire(import.meta.url);" },
    // Prefer each package's ESM build ("import" condition), the same files `node src/main.mjs` loads.
    conditions: ['import', 'node'],
    mainFields: ['module', 'main'],
    minify: false,
    legalComments: 'eof',
    logLevel: 'warning',
  });
  // The Setup page, and the browser copy of the OPAQUE library it loads.
  const setupSrc = join(ROOT, 'setup');
  if (existsSync(setupSrc)) cpSync(setupSrc, join(outDir, 'setup'), { recursive: true });
  if (existsSync(OPAQUE_FOR_BROWSERS)) {
    mkdirSync(join(outDir, 'setup', 'vendor', 'opaque'), { recursive: true });
    cpSync(OPAQUE_FOR_BROWSERS, join(outDir, 'setup', 'vendor', 'opaque', 'index.js'));
  }
  return { outfile, bytes: statSync(outfile).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // No minifying: src/rtc.mjs recognises the werift code it patches by its source text.
  const { outfile, bytes } = await bundle();
  console.log(`${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
