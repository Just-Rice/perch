// Constants shared by the website and the Mac host. docs/PROTOCOL.md explains each one.

// Wire protocol version. Bump PROTO for any incompatible change; MIN_PEER_PROTO is the oldest peer still served.
export const PROTO = 1;
export const MIN_PEER_PROTO = 1;

// Where the real website lives. Passkeys are made for RP_ID, and the Mac only accepts sign-ins from APP_ORIGIN
// (plus a localhost origin when it runs in test mode).
export const APP_ORIGIN = 'https://just-rice.github.io';
export const RP_ID = 'just-rice.github.io';
export const SITE_URL = 'https://just-rice.github.io/perch/';
export const CONNECT_URL = 'https://just-rice.github.io/perch/connect.html';

// Free public MQTT-over-WebSocket brokers from three separate operators, all used at once. They only carry sealed
// rendezvous messages, which stay under 32 KB (the smallest limit seen on public brokers is about 48 KB). Node's
// built-in WebSocket can't talk to brokers that offer HTTP/2 WebSockets, so only add brokers tested from Node too.
export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

// Public STUN servers: they tell each side its public address so the two can connect directly.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const TOPIC_PREFIX = 'perch/v1/';
export const ENVELOPE_MAX_BYTES = 64 * 1024;
export const ENVELOPE_MAX_SKEW_MS = 5 * 60 * 1000;

// The passkey's user handle carries the Mac's address: hostId (16 bytes) then the rendezvous key (32 bytes).
export const HOST_ID_BYTES = 16;
export const SIG_KEY_BYTES = 32;
export const PAIR_ID_BYTES = 16;
export const PAIR_SECRET_BYTES = 32;

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const AUTH_TIMEOUT_MS = 120 * 1000;

// Video quality presets: longest edge in pixels, frames per second, starting and ceiling bitrate.
export const QUALITY = {
  smooth:   { maxEdge: 1280, fps: 30, kbps: 2500, maxKbps: 4000 },
  balanced: { maxEdge: 1920, fps: 30, kbps: 5000, maxKbps: 8000 },
  sharp:    { maxEdge: 2880, fps: 30, kbps: 9000, maxKbps: 14000 },
};
export const DEFAULT_QUALITY = 'balanced';

// Data channel labels (the Mac creates all three). `pointer` is unordered with no retransmits: moves only.
export const CONTROL_CHANNEL = 'control';
export const INPUT_CHANNEL = 'input';
export const POINTER_CHANNEL = 'pointer';
