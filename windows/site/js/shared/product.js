// Roost's own settings for the shared protocol (core/protocol): where Roost's website lives (passkeys are made for
// RP_ID, and Roost PCs accept sign-ins from APP_ORIGIN) and Roost's own meeting points, so a Roost viewer and a Perch
// Mac never find each other by accident. The only file in this folder that is Roost's own protocol setting: the
// protocol files beside it are copied from core/protocol by core/sync.mjs, and must be changed there.
export const APP_ORIGIN = 'https://just-rice.github.io';
export const RP_ID = 'just-rice.github.io';
export const SITE_URL = 'https://just-rice.github.io/perch/windows/';
export const CONNECT_URL = 'https://just-rice.github.io/perch/windows/connect.html';
export const TOPIC_PREFIX = 'roost/v1/';
export const CLIENT_PREFIX = 'roost-';
