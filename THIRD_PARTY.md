# Third-party code

Perch includes or depends on the following. Each keeps its own licence.

| Component | Where | Licence |
|---|---|---|
| [@serenity-kit/opaque](https://github.com/serenity-kit/opaque) 1.1.0 (OPAQUE password sign-in, compiled to WebAssembly) | `site/js/vendor/opaque/` (copied), `host/node` (npm) | MIT, see `site/js/vendor/opaque/LICENSE` |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase | `host/node/setup/vendor/qrcode.js` (copied) | MIT (header of the file) |
| [werift](https://github.com/shinyoshiaki/werift-webrtc) 0.25.0 (WebRTC in TypeScript) | `host/node` (npm) | MIT |
| [@simplewebauthn/server](https://github.com/MasterKale/SimpleWebAuthn) 14.0.3 (passkey verification) | `host/node` (npm) | MIT |
| [Node.js](https://nodejs.org) (runtime bundled inside Perch.app) | `Perch.app/Contents/Helpers/node` | MIT and others, see Node's LICENSE |

Perch's Mac capture and input code was written with [Sill](https://github.com/Saffsanity/sill) (Apache 2.0, by Noah
Saffer) as a reference for how ScreenCaptureKit, VideoToolbox and Quartz events fit together.
