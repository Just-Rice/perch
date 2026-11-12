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

// Free public MQTT-over-WebSocket brokers from four separate operators, all used at once. They only carry sealed
// rendezvous messages, which stay under 32 KB (the smallest limit seen on public brokers is about 48 KB). Node's
// built-in WebSocket can't talk to brokers that offer HTTP/2 WebSockets, so only add brokers tested from Node too.
// The last one listens on the normal web port (443), so it still works on school and office Wi-Fi that blocks the
// others' ports; it asks for a fixed public login.
export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://public:public@public.cloud.shiftr.io/',
];

// Perch's shared relay service (relay-service/): relay logins for Macs on strict networks, within monthly limits.
// Empty until the service is running; a Mac then uses only a relay key of its owner's own, if any.
export const RELAY_SERVICE_URL = '';

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

// Video quality presets: longest edge in pixels, frames per second, starting and ceiling bitrate. `fast` (60 frames
// a second) needs a Mac that lists "fps60" in its offer's caps; older ones ignore it.
export const QUALITY = {
  smooth:   { maxEdge: 1280, fps: 30, kbps: 2500, maxKbps: 4000 },
  balanced: { maxEdge: 1920, fps: 30, kbps: 5000, maxKbps: 8000 },
  sharp:    { maxEdge: 2880, fps: 30, kbps: 10000, maxKbps: 20000 },
  fast:     { maxEdge: 1920, fps: 60, kbps: 8000, maxKbps: 16000 },
};
export const DEFAULT_QUALITY = 'balanced';

// Picture sizes (longest edge) the Mac steps between, and roughly how many kbit/s a moving desktop needs at 30
// frames a second before the encoder has to start dropping frames at that size. When the link can't carry the
// current size the Mac sends a smaller picture at full frame rate instead of a big one that stutters; it also never
// sends more pixels than the viewer's screen can show.
export const EDGE_LADDER = [640, 960, 1280, 1600, 1920, 2560, 2880];
export const EDGE_NEEDS_KBPS = { 640: 0, 960: 500, 1280: 900, 1600: 1500, 1920: 2200, 2560: 4000, 2880: 5000 };

// Data channel labels (the Mac creates all three). `pointer` is unordered with no retransmits: moves only.
export const CONTROL_CHANNEL = 'control';
export const INPUT_CHANNEL = 'input';
export const POINTER_CHANNEL = 'pointer';
