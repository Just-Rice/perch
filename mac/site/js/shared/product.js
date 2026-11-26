// Perch's own settings for the shared protocol (core/protocol): where Perch's website lives (passkeys are made for
// RP_ID, and Macs accept sign-ins from APP_ORIGIN) and Perch's own meeting points, so a Perch viewer and a Roost PC
// never find each other by accident. The only file in this folder that is Perch's: the rest is copied from
// core/protocol by core/sync.mjs, and must be changed there.
export const APP_ORIGIN = 'https://just-rice.github.io';
export const RP_ID = 'just-rice.github.io';
export const SITE_URL = 'https://just-rice.github.io/perch/';
export const CONNECT_URL = 'https://just-rice.github.io/perch/connect.html';
export const TOPIC_PREFIX = 'perch/v1/';
export const CLIENT_PREFIX = 'perch-';
