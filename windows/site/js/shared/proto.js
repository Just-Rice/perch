// Constants shared by the website and the host on the computer, for Perch and Roost alike. docs/PROTOCOL.md explains each one.

// Wire protocol version. Bump PROTO for any incompatible change; MIN_PEER_PROTO is the oldest peer still served.
export const PROTO = 1;
export const MIN_PEER_PROTO = 1;

// Where Roost's website lives, and its own meeting points, are in product.js. Re-exported here, so nothing that
// imported them from proto.js changes.
export { APP_ORIGIN, RP_ID, SITE_URL, CONNECT_URL, TOPIC_PREFIX, CLIENT_PREFIX } from './product.js';

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

// Public STUN servers: they tell each side its public address so the two can connect directly.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const ENVELOPE_MAX_BYTES = 64 * 1024;
export const ENVELOPE_MAX_SKEW_MS = 5 * 60 * 1000;

// The passkey's user handle carries the computer's address: hostId (16 bytes) then the rendezvous key (32 bytes).
export const HOST_ID_BYTES = 16;
export const SIG_KEY_BYTES = 32;
export const PAIR_ID_BYTES = 16;
export const PAIR_SECRET_BYTES = 32;

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const AUTH_TIMEOUT_MS = 120 * 1000;

// Video quality presets: longest edge in pixels, frames per second, starting and ceiling bitrate. `fast` (60 frames
// a second) needs a computer that lists "fps60" in its offer's caps; older ones ignore it.
// maxFps: the computer steps up to this when the link has room for the picture at that rate (and back to fps when it
// hasn't), so a good connection gets a sharp picture at 60 frames a second and a weaker one keeps text readable.
// holdSize and maxQp make detail come first: the picture keeps its full size whatever the link does (no stepping down
// the ladder below), and the encoder may not go coarser than quantiser maxQp (51 is H.264's coarsest, a smeared
// picture; around 30 small text stays crisp). A link too slow for that gets fewer frames a second instead of a blurry
// or smaller picture.
export const QUALITY = {
  smooth:   { maxEdge: 1280, fps: 30, maxFps: 60, kbps: 2500, maxKbps: 6000 },
  balanced: { maxEdge: 1920, fps: 30, maxFps: 60, kbps: 5000, maxKbps: 14000 },
  sharp:    { maxEdge: 2880, fps: 30, maxFps: 30, kbps: 10000, maxKbps: 30000, holdSize: true, maxQp: 30 },
  fast:     { maxEdge: 1920, fps: 60, maxFps: 60, kbps: 8000, maxKbps: 20000 },
};
export const DEFAULT_QUALITY = 'balanced';

// Picture sizes (longest edge) the computer steps between, and roughly how many kbit/s a moving desktop needs at 30
// frames a second before the encoder has to start dropping frames at that size. When the link can't carry the
// current size the computer sends a smaller picture at full frame rate instead of a big one that stutters; it also never
// sends more pixels than the viewer's screen can show.
export const EDGE_LADDER = [640, 960, 1280, 1600, 1920, 2560, 2880];
export const EDGE_NEEDS_KBPS = { 640: 0, 960: 500, 1280: 900, 1600: 1500, 1920: 2200, 2560: 4000, 2880: 5000 };

// Data channel labels (the computer creates all three). `pointer` is unordered with no retransmits: moves only.
export const CONTROL_CHANNEL = 'control';
export const INPUT_CHANNEL = 'input';
export const POINTER_CHANNEL = 'pointer';
