# Perch relay service

Some school and office networks block the direct connection Perch normally uses. A relay passes it through
Cloudflare instead. This small service lets every Perch Mac use a relay without setting anything up: it hands out
short-lived relay logins from **one** Cloudflare account (yours, if you publish Perch), and keeps that account inside
Cloudflare's free 1,000 GB.

## The limits

All counted over the last 31 days, so no Cloudflare billing month can pass them, whatever day it starts on:

| Who | Limit | Setting in `wrangler.toml` |
| --- | --- | --- |
| Each Mac that isn't yours | 20 GB | `MAC_LIMIT_GB` |
| All Macs that aren't yours, together | 900 GB (the last 90 GB are kept for your Macs) | `OTHERS_LIMIT_GB` |
| Everything on the Cloudflare account, your Macs included | 990 GB, and never more | `TOTAL_LIMIT_GB` |

How they are kept:

- A Mac asks for a login when someone connects. Over a limit, it gets none, and Setup on that Mac says why.
- Every five minutes the service reads Cloudflare's own usage numbers (the ones it bills by) and **revokes** the live
  logins of any Mac over a limit. At 990 GB that is every login, yours included.
- Logins also run out by themselves: 3 hours for other people's Macs, 24 for yours, and 1 hour for everyone once the
  total is within 40 GB of 990. Cloudflare ends a connection when its login runs out.
- If Cloudflare's numbers can't be read for 30 minutes, other people's Macs get no new logins until they can.

Each Mac proves who it is with a key of its own, so nobody can use up another Mac's share. Anyone can make new keys,
though, which is why the two overall limits exist.

**Honest limits of the limits.** Cloudflare's numbers arrive about 30 seconds late and are checked every five
minutes, and Cloudflare doesn't say whether revoking a login cuts a connection at once. With many people relaying at
the same moment, the total could go a few GB past 990 before everything stops; the 10 GB left below 1,000 is there
for that. Cloudflare has no spending cap of its own, so nothing here can make an overshoot impossible. If you also
use Cloudflare's Realtime SFU, that shares the same free 1,000 GB and counts toward the total too.

## Setting it up (about 15 minutes)

You need a Cloudflare account (the free plan is enough) and Node.js on your Mac.

1. **A TURN key.** In the [Cloudflare dashboard](https://dash.cloudflare.com), open **Realtime** (it may be called
   **Calls**), then **TURN Server**, then **Create**. Name it *Perch relay service*. Copy the **Turn Token ID** and
   the **API Token** it shows (the token is shown only once).
2. **Your account ID.** On the dashboard's account home page, choose **Copy account ID**.
3. **A token for usage numbers.** Open **My Profile › API Tokens › Create Token › Create Custom Token**. Give it the
   permission **Account › Account Analytics › Read**, for your account only, and create it. Copy it.
4. **Sign in from Terminal**, in this folder: `npx wrangler@4 login` (a browser window asks you to allow it).
5. **Add the secrets**, one at a time; each asks you to paste a value:
   ```
   npx wrangler@4 secret put TURN_KEY_ID
   npx wrangler@4 secret put TURN_KEY_API_TOKEN
   npx wrangler@4 secret put ANALYTICS_TOKEN
   npx wrangler@4 secret put OWNER_KEY
   ```
   For `OWNER_KEY`, make a long random key with `openssl rand -base64 32` and keep a copy in your password manager.
6. **Your account ID** goes in `wrangler.toml`: uncomment the `ACCOUNT_ID` line and paste it there (it isn't a secret).
7. **Publish:** `npx wrangler@4 deploy`. It prints the service's address, like
   `https://perch-relay.<your-name>.workers.dev`.
8. **Check it:** `curl -H "Authorization: Bearer <your OWNER_KEY>" https://perch-relay.<your-name>.workers.dev/v1/status`
   should show `"fresh": true` under `numbers` within five minutes. If it shows an `error`, the analytics token or
   account ID is wrong.
9. **Point Perch at it:** set `RELAY_SERVICE_URL` in `site/js/shared/proto.js` to that address and release Perch.
10. **Your own Macs:** in Perch's Setup on each of them, open *School or office Wi-Fi › I run this relay service* and
    paste the owner key. They then have no per-Mac limit, and Setup shows everyone's use.

To change a limit, edit `wrangler.toml` and run `npx wrangler@4 deploy` again.

## Tests

- `node --test test/*.test.mjs`: the whole service in Node, with a pretend Cloudflare.
- `node test/local-run.mjs`: the service in Cloudflare's own runtime on this computer (`wrangler dev`; nothing is
  uploaded), against a pretend Cloudflare.
