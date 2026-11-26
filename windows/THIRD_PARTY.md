# Third-party code

Roost is derived from [Perch](https://github.com/Just-Rice/perch) by Just-Rice (Apache 2.0): the protocol, the host,
the website's connection and sign-in code and the relays started there. Roost includes or depends on the following;
each keeps its own licence.

| Component | Where | Licence |
|---|---|---|
| [Perch](https://github.com/Just-Rice/perch) | `host/`, `site/js/shared/`, `relay/` (derived) | Apache 2.0 |
| [OpenH264](https://github.com/cisco/openh264) by Cisco (H.264 encoder, built from source) | `app/` via the `openh264` crate | BSD 2-Clause |
| [libopus](https://opus-codec.org) (Opus audio, built from source) | `app/` via the `opus` crate | BSD 3-Clause |
| [windows-rs](https://github.com/microsoft/windows-rs) (Windows APIs for Rust) | `app/` (crates.io) | MIT or Apache 2.0 |
| [serde_json](https://github.com/serde-rs/json), [base64](https://github.com/marshallpierce/rust-base64), [png](https://github.com/image-rs/image-png), [image](https://github.com/image-rs/image), [embed-resource](https://github.com/nabijaczleweli/rust-embed-resource) | `app/` (crates.io) | MIT or Apache 2.0 |
| [@serenity-kit/opaque](https://github.com/serenity-kit/opaque) 1.1.0 (OPAQUE password sign-in, WebAssembly) | `site/js/vendor/opaque/` (copied), `host` (npm) | MIT, see `site/js/vendor/opaque/LICENSE` |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase | `host/setup/vendor/qrcode.js` (copied) | MIT (header of the file) |
| [werift](https://github.com/shinyoshiaki/werift-webrtc) 0.25.0 (WebRTC in TypeScript) | `host` (npm) | MIT |
| [@simplewebauthn/server](https://github.com/MasterKale/SimpleWebAuthn) 14.0.3 (passkey verification) | `host` (npm) | MIT |
| [Node.js](https://nodejs.org) (runtime bundled with Roost) | `node\node.exe` in the install folder | MIT and others, see `node\LICENSE` |

H.264 is covered by patents in some countries. Cisco's royalty-free licence covers only the OpenH264 binaries Cisco
distributes; Roost builds OpenH264 from source, so it is not covered by Cisco's licence. A future release can switch to
the Windows Media Foundation encoder, or to Cisco's downloadable binary.
