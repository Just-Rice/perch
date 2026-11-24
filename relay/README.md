# Roost's Worker relay

A tiny Cloudflare Worker for networks that block the direct connection Roost normally uses (school or office Wi-Fi).
You run it in **your own** free Cloudflare account: no payment details, and no monthly data allowance to use up
(Workers don't charge for bandwidth).

It passes bytes between your PC and your browser, helps them find each other, and serves the Roost website.
Everything it carries is end-to-end encrypted by Roost, so it can't see your screen, your sound, what you type or how
you sign in. See [docs/PROTOCOL.md](../docs/PROTOCOL.md#worker-relay) and [SECURITY.md](../SECURITY.md).

## Set it up (about 5 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up), [Git](https://git-scm.com/download/win)
and [Node.js](https://nodejs.org) (the LTS installer) on any computer. On Windows, open **PowerShell** and run:

```powershell
git clone https://github.com/Just-Rice/roost
cd roost\relay
npx wrangler login
npx wrangler deploy
```

`npx wrangler login` opens your browser so you can let Wrangler use your Cloudflare account. If PowerShell says
running scripts is disabled, run the same commands with `npx.cmd` in place of `npx`.

Wrangler prints the relay's address, like `https://roost-relay.your-name.workers.dev`. On your PC, open Roost's
**Control Center** (from the Roost icon in the system tray), go to **Relay without a card**, paste the address and
choose **Check and save**.

### Where only `*.workers.dev` gets through

The relay also helps the two ends find each other (it is a rendezvous broker, so the public ones can be blocked), and
it serves the Roost website from its own address. If the Roost website or the public brokers are blocked where you
are, use your relay's address instead:

1. In the Control Center, **Sites that can sign in**: add `https://roost-relay.your-name.workers.dev/`.
2. In **Pair a device**, choose that site under **Pair it for**, make the link and open it on your device, once.
3. From then on, sign in at `https://roost-relay.your-name.workers.dev/connect.html`.

The first PC to save a relay becomes its owner, and only that PC can use it. For a second PC, deploy another copy
under a different name:

```powershell
npx wrangler deploy --name roost-relay-2
```

(or change `name` in `wrangler.toml`).

## How much it can carry

On the Workers free plan, Durable Objects allow about 100,000 requests and 13,000 GB-seconds a day. Roost sends one
message per video frame plus a few for sound, and Cloudflare counts 20 incoming WebSocket messages as one request, so
a day's allowance is many hours of use (roughly 10 at 30 frames a second). Past it, the relay stops for the rest of
the day (it resets at midnight UTC); nothing is ever charged. A [backup relay](node/README.md) on your own computer
can take over until then.

## Starting over

To give a relay a new owner, delete it (`npx wrangler delete`) and deploy it again. Or set your own secret with
`npx wrangler secret put RELAY_SECRET` (64 hex characters); the relay then ignores claims.

## Developing

```powershell
npm ci
npx wrangler dev          # http://localhost:8787
```

`tests/e2e/relay.test.mjs` runs the real relay under `wrangler dev` with the real host and website. Set
`$env:ROOST_E2E_RELAY = "https://<a fresh deploy>.workers.dev"` to run it against Cloudflare itself.
