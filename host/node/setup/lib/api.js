// Talking to Perch's Setup server on this Mac. Every call carries the page's key (from ?k= in its address) in the
// X-Perch-Key header; without it the server answers nothing. See host/node/src/setup-server.mjs.

const KEY = new URLSearchParams(location.search).get('k') ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const NOT_RUNNING = 'Can\'t reach Perch on this Mac. Check that Perch is running (its icon is in the menu bar).';

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: { 'X-Perch-Key': KEY, ...(options.headers ?? {}) },
    });
  } catch {
    throw new ApiError(NOT_RUNNING, 0);
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(body?.error || `Perch couldn't do that (error ${res.status}).`, res.status);
  return body;
}

export const getState = () => request('/api/state');

// POST /api/<action>. Resolves to {result, state}; a refusal throws ApiError with Perch's plain-language reason.
export function post(action, body = {}) {
  return request(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Live updates: a Server-Sent Events stream, read with fetch() because EventSource can't send the key header.
// Calls onState(state) for every snapshot and onStatus('live' | 'lost' | 'stale') when the connection changes.
// 'stale' means the key was refused (Perch restarted with a new one): reconnecting won't help.
export function watch(onState, onStatus) {
  let stopped = false;
  let controller = null;
  let failures = 0;

  async function readStream(res) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value.replace(/\r\n?/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // keep-alive comment
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
        if (event === 'state' && data.length) {
          try { onState(JSON.parse(data.join('\n'))); } catch (e) { console.warn('Setup: bad state update', e); }
        }
      }
    }
  }

  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch('/api/events', {
          headers: { 'X-Perch-Key': KEY, Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (res.status === 403) { onStatus('stale'); return; }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        failures = 0;
        onStatus('live');
        await readStream(res);
      } catch {
        // fall through to reconnect
      }
      if (stopped) return;
      failures++;
      onStatus('lost', failures);
      await sleep(Math.min(8000, 500 * 2 ** Math.min(failures, 4)));
    }
  })();

  return () => { stopped = true; controller?.abort(); };
}
