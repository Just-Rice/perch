// Which devices go straight to the backup sign-in (site/js/ui/device.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { passkeyFriendly } from '../../site/js/ui/device.js';

const UA = {
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
};

test('a Chromebook prefers the backup sign-in, whatever its browser says', () => {
  assert.equal(passkeyFriendly(UA.chromebook, { platformAuthenticator: true }), false);
});

test('a device with its own authenticator keeps passkeys; one without goes to the backup', () => {
  assert.equal(passkeyFriendly(UA.iphone, { platformAuthenticator: true }), true);
  assert.equal(passkeyFriendly(UA.windows, { platformAuthenticator: true }), true);
  assert.equal(passkeyFriendly(UA.windows, { platformAuthenticator: false }), false, 'no Windows Hello set up');
  assert.equal(passkeyFriendly(UA.linux, { platformAuthenticator: false }), false);
  assert.equal(passkeyFriendly(UA.linux, { platformAuthenticator: null }), true, 'unknown: passkeys as before');
});
