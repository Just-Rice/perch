// Roost's own settings for the protocol: where Roost's website lives (passkeys are made for RP_ID, and Roost PCs
// accept sign-ins from APP_ORIGIN) and Roost's own meeting points, so a Roost viewer and a Perch Mac never find each
// other by accident.
export const APP_ORIGIN = 'https://just-rice.github.io';
export const RP_ID = 'just-rice.github.io';
export const SITE_URL = 'https://just-rice.github.io/roost/';
export const CONNECT_URL = 'https://just-rice.github.io/roost/connect.html';
export const TOPIC_PREFIX = 'roost/v1/';
export const CLIENT_PREFIX = 'roost-';
