// Roost's own settings for the shared protocol (github.com/perch-nest/core): where Roost's website lives (passkeys
// are made for RP_ID, and Roost PCs accept sign-ins from APP_ORIGIN) and Roost's own meeting points, so a Roost viewer
// and a Perch Mac never find each other by accident. The only file in site/js/shared/ that is Roost's: the rest comes
// from core (scripts/sync-core.mjs) and must be changed there.
export const APP_ORIGIN = 'https://faarisaahmed.github.io';
export const RP_ID = 'faarisaahmed.github.io';
export const SITE_URL = 'https://faarisaahmed.github.io/roost/';
export const CONNECT_URL = 'https://faarisaahmed.github.io/roost/connect.html';
export const TOPIC_PREFIX = 'roost/v1/';
export const CLIENT_PREFIX = 'roost-';
