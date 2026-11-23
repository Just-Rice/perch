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

### Without an account: a Cloudflare Quick Tunnel

```sh
RELAY_SECRET=<the Worker relay's secret> QUICK_TUNNEL=1 node server.mjs   # needs cloudflared
```

The relay starts `cloudflared` itself and gets a free `https://<random words>.trycloudflare.com` address, a new one
each time the tunnel starts (`GET /v1/public` says which). So the Mac is given the relay's address on this computer
instead, `workerRelayTunnelSet` with `http://127.0.0.1:8788`, and asks it for the current public address whenever an
offer needs the backup. Because the address changes, it is not added as a sign-in site or a broker: devices still
sign in through the main relay's site, and only the connection itself goes through the tunnel. Cloudflare describes
Quick Tunnels as being for testing, so a zrok share (fixed address) is the steadier backup.

Settings (environment): `PORT` (8788), `HOST` (127.0.0.1), `RELAY_SECRET` (64 hex characters; without it the first
Mac to claim the relay owns it, remembered in `RELAY_DATA/secret`), `RELAY_DATA` (`~/.perch-relay`), `SITE_DIR`
(`../../site`), `QUICK_TUNNEL=1` and `CLOUDFLARED` (the cloudflared binary, `cloudflared` on the PATH by default).

`PERCH_E2E_RELAY_NODE=1 node --test tests/e2e/relay.test.mjs` runs the relay tests against it.
