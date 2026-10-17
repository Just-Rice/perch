// Logging for the host process: every line goes to stderr (the app shows or saves it) and to $PERCH_HOME/perch.log,
// which is rotated to perch.log.1 at about 2 MB so it never grows without bound.
//
// stdout is reserved for IPC frames to the app (src/ipc.mjs); nothing in the host may print there. Never log secrets,
// codes, passwords, SDPs or sign-in responses: log what happened, not the material.
import { appendFileSync, statSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

function format(parts) {
  return parts.map(p => {
    if (p instanceof Error) return p.stack || p.message;
    if (typeof p === 'string') return p;
    try { return JSON.stringify(p); } catch { return String(p); }
  }).join(' ');
}

export function createLog({ home = null, level = 'info', stderr = process.stderr, maxBytes = LOG_MAX_BYTES } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const path = home ? join(home, 'perch.log') : null;
  let size = 0;
  let fileOk = !!path;
  if (path) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      try { size = statSync(path).size; } catch { size = 0; }
    } catch { fileOk = false; }
  }

  function toFile(line) {
    if (!fileOk) return;
    try {
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        try { renameSync(path, path + '.1'); } catch {}
        size = 0;
      }
      appendFileSync(path, line, { mode: 0o600 });
      if (size === 0) chmodSync(path, 0o600);
      size += bytes;
    } catch {
      fileOk = false; // a full or read-only disk must not take the host down
    }
  }

  function write(lvl, tag, parts) {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}${format(parts)}\n`;
    try { stderr.write(line); } catch {}
    toFile(line);
  }

  function make(tag) {
    const log = (...parts) => write('info', tag, parts);
    for (const lvl of Object.keys(LEVELS)) log[lvl] = (...parts) => write(lvl, tag, parts);
    log.child = sub => make(tag ? `${tag}:${sub}` : sub);
    log.path = path;
    return log;
  }
  return make('');
}

// A logger that drops everything (tests, and modules used before logging is set up).
export function silentLog() {
  const log = () => {};
  for (const lvl of Object.keys(LEVELS)) log[lvl] = () => {};
  log.child = () => log;
  return log;
}
