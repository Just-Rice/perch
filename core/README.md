# core: what Perch and Roost share

Perch (for a Mac, in [`mac/`](../mac/)) and Roost (for Windows, in [`windows/`](../windows/)) are two apps with one
protocol. The code they genuinely share lives here, once:

| Path | What |
|---|---|
| `protocol/` | The protocol a website and a computer speak: the MQTT client, sealed rendezvous notes, channel binding, the relay's client side, constants. Plain ES modules for browsers and Node 22+. |
| `site/` | The parts of the two websites that are the same: the "Mac · Windows" switch and the home-screen offer (`js/platform.js`, `css/platform.css`). |
| `relay/` | The Worker relay for strict networks, and `relay/node/`, its Node.js backup. One relay serves both: it carries Perch's (`perch/v1/…`) and Roost's (`roost/v1/…`) topics and serves both websites. See [relay/README.md](relay/README.md). |
| `sync.mjs` | Copies `protocol/` and `site/` into each project. |

## Changing shared code

Change it here, then run `node core/sync.mjs`: it copies `protocol/` into `mac/site/js/shared/` and
`windows/site/js/shared/`, and `site/` into each project's `site/`. Commit both. CI runs `node core/sync.mjs --check`
for each project, so a change made to only one project's copy is caught.

Each project keeps its own copy so that it stays whole on its own: its website is published as it is, and its app
bundles its host with the protocol inside. What differs between the two lives beside the copies, in each project's
`site/js/shared/product.js`: its website's address (where passkeys are made and sign-ins are accepted from) and its
own meeting points (`perch/v1/` or `roost/v1/`), so a Perch viewer and a Roost PC never find each other by accident.

A change here is a change to both projects: test both (`mac/` and `windows/` each have their own tests, and their
CI runs whenever `core/` changes).

## Credit

The protocol, its security model and the relay were designed and written by [Just-Rice](https://github.com/Just-Rice)
for Perch. Roost is a port of Perch to Windows.
