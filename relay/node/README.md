# Perch's relay on your own computer

The same relay as the Cloudflare Worker (`../src/index.js`), as a plain Node.js server. Run it on a computer that
stays on (the Mac itself is fine: Perch only works while the Mac is on anyway) and expose it with a tunnel such as
[zrok](https://zrok.io). It also serves the Perch website.

Its main use is as a **backup** for your Worker relay: give it the Worker relay's secret, and the Mac names it in its
offers whenever the Worker can't be reached (for example after a day's free allowance is used up).

```sh
cd relay/node
npm ci
RELAY_SECRET=<the Worker relay's secret> PORT=8788 node server.mjs
zrok2 share public http://127.0.0.1:8788 --headless -n public:<your name>
```

Then, in Setup's API, `workerRelayBackupSet` with the share's `https://…zrok.io` address.

Settings (environment): `PORT` (8788), `HOST` (127.0.0.1), `RELAY_SECRET` (64 hex characters; without it the first
Mac to claim the relay owns it, remembered in `RELAY_DATA/secret`), `RELAY_DATA` (`~/.perch-relay`), `SITE_DIR`
(`../../site`).

`PERCH_E2E_RELAY_NODE=1 node --test tests/e2e/relay.test.mjs` runs the relay tests against it.
