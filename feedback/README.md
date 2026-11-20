# Perch's feedback box

People send ideas and problems from **site/feedback.html** (linked from the website's footer, the viewer's More menu
and Setup › About). They land here: a Cloudflare Worker with a D1 database in the owner's own Cloudflare account,
separate from the relay. Only the owner can read them.

- **Address:** https://perch-feedback.justrice.workers.dev
- **Code:** `src/handler.js` (all the rules; tested by `tests/feedback/handler.test.mjs`), `src/index.js` (Cloudflare
  glue: D1, the rate limiter, Turnstile), `schema.sql`.
- **What's kept:** the message, how to reach the sender if they gave it, the kind (idea, problem, other), and, when
  they came from Perch and left it in, Perch's version, which page and which kind of computer. Never the sender's IP
  address; request logs are off. Entries older than a year are deleted daily. `site/privacy.html#feedback` says the
  same in plain words: keep the two in step.

## Spam protection

In order: only Perch's own pages may send (CORS), at most 8 KB, a hidden honeypot field (bots that fill it are thanked
and nothing is kept), a rate limit (3 a minute from one address, counted by Cloudflare, nothing stored), Cloudflare
Turnstile (the "not a robot" check, verified on the server, action `feedback`), and a cap of 300 a day.

## Reading and marking

| Token (Worker secret) | Kept in this Mac's Keychain as | Can |
| --- | --- | --- |
| `DIGEST_TOKEN` | `perch-feedback-digest` | read: `GET /v1/admin/feedback?status=new&since=<ISO>` |
| `ADMIN_TOKEN` | `perch-feedback-admin` | also mark: `PATCH /v1/admin/feedback/<id>` with `{"status": "approved"\|"declined"\|"done"\|"new", "notes": "…"}` |

```sh
curl -s -H "Authorization: Bearer $(security find-generic-password -s perch-feedback-digest -a token -w)" \
  "https://perch-feedback.justrice.workers.dev/v1/admin/feedback?status=new"
```

## The weekly digest

`digest/weekly-digest.sh` runs on this Mac every Monday at 9:00 (launchd, `digest/install.sh`). It fetches new
feedback and the open pull requests itself, then Claude groups them into numbered ideas with a recommendation each
and emails the owner. The owner answers in a Claude session ("approve 1 and 3, turn down 2"); nothing is implemented,
merged or marked from the digest itself.

Feedback and pull requests are written by strangers, so the Claude in the digest has no tools except loading tool
schemas and one Gmail send, and `digest/guard-recipient.mjs` (a hook, so it doesn't rely on Claude saying no) refuses
any connector call other than that send, to anyone but the owner, with no copies, drafts, attachments or replies.

- Try it without sending: `PERCH_DIGEST_TO=… PERCH_DIGEST_TOOL=… PERCH_DIGEST_DRY=1 digest/weekly-digest.sh`
- Run it now: `launchctl kickstart gui/$(id -u)/com.rishirao.perch-digest`; log in `~/Library/Logs/perch-digest.log`

## Setting it up again

```sh
cd feedback && npm ci
npx wrangler d1 create perch-feedback        # put the id in wrangler.toml
npx wrangler d1 execute perch-feedback --remote --file schema.sql
npx wrangler secret put DIGEST_TOKEN         # and ADMIN_TOKEN, TURNSTILE_SECRET
npx wrangler deploy
```

Turnstile: a widget in the Cloudflare dashboard for `just-rice.github.io` and `perch-relay.justrice.workers.dev`; its
site key goes in `site/js/shared/proto.js` (`TURNSTILE_SITE_KEY`), its secret in the Worker as `TURNSTILE_SECRET`.
Until the site key is set, the page says the feedback box isn't open yet.
