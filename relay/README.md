# Perch's Worker relay

A tiny Cloudflare Worker for networks that block the direct connection Perch normally uses (school or office Wi-Fi).
You run it in **your own** free Cloudflare account: no payment details, and no monthly data allowance to use up
(Workers don't charge for bandwidth).

It passes bytes between your Mac and your browser, helps them find each other, and serves the Perch website. Everything it carries is end-to-end encrypted by Perch, so it
can't see your screen, your sound, what you type or how you sign in. See [docs/PROTOCOL.md](../docs/PROTOCOL.md#worker-relay)
and [SECURITY.md](../SECURITY.md).

## Set it up (about 5 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js](https://nodejs.org) on any
computer.

```sh
git clone https://github.com/Just-Rice/perch
cd perch/relay
npx wrangler login
npx wrangler deploy
```

Wrangler prints the relay's address, like `https://perch-relay.your-name.workers.dev`. On your Mac, open Perch's
**Setup**, go to **Relay without a card**, paste the address and choose **Check and save**.

### Where only `*.workers.dev` gets through

The relay also helps the two ends find each other (it is a rendezvous broker, so the public ones can be blocked), and
it serves the Perch website from its own address. If the Perch website or the public brokers are blocked where you
are, use your relay's address instead:

1. In Setup, **Sites that can sign in**: add `https://perch-relay.your-name.workers.dev/`.
2. In **Pair a device**, choose that site under **Pair it for**, make the link and open it on your device, once.
3. From then on, sign in at `https://perch-relay.your-name.workers.dev/connect.html`.

The first Mac to save a relay becomes its owner, and only that Mac can use it. For a second Mac, deploy another copy
under a different name: change `name` in `wrangler.toml` (or run `npx wrangler deploy --name perch-relay-2`).

## How much it can carry

On the Workers free plan, Durable Objects allow about 100,000 requests and 13,000 GB-seconds a day. Perch sends one
message per video frame plus a few for sound, and Cloudflare counts 20 incoming WebSocket messages as one request, so a
day's allowance is many hours of use (roughly 10 at 30 frames a second). Past it, the relay stops for the rest of the
day (it resets at midnight UTC); nothing is ever charged.

## Starting over

To give a relay a new owner, delete it (`npx wrangler delete`) and deploy it again. Or set your own secret with
`npx wrangler secret put RELAY_SECRET` (64 hex characters); the relay then ignores claims.

## Developing

```sh
npm ci
npx wrangler dev          # http://localhost:8787
```

`tests/e2e/relay.test.mjs` runs the real relay under `wrangler dev` with the real host and website. Set
`PERCH_E2E_RELAY=https://<a fresh deploy>.workers.dev` to run it against Cloudflare itself.
