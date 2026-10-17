// A changed DTLS fingerprint in the answer must stop the connection before anything is sent. In its own file
// because werift's DTLS keeps retrying the failed handshake in the background for about half a minute after the
// peers are closed, and that would hold up the other tests in a shared file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, waitConnected } from './rtc-helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('an answer whose DTLS fingerprint was changed never connects, and nothing gets through', async () => {
  const flip = sdp => sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F])/i, (m, p, h) => p + (h.toUpperCase() === 'A' ? 'B' : 'A'));
  const { host, viewer, pc } = await connect({ tamperAnswer: flip });
  try {
    const state = await waitConnected(host, 6000);
    assert.notEqual(state, 'connected');
    let opened = false;
    host.channels.control.stateChanged.subscribe(s => { if (s === 'open') opened = true; });
    await sleep(300);
    assert.equal(opened || host.channels.control.readyState === 'open', false);
    assert.equal(viewer.media.video + viewer.media.audio, 0);
  } finally {
    await host.close();
    await pc.close();
  }
});
