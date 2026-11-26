// How the connection of the session now running goes, in words. The Setup page can't load the website's shared code,
// so this is a copy of ROUTE_WORDS in site/js/shared/route.js; a test keeps them the same.
export const ROUTE_WORDS = Object.freeze({
  lan: 'Direct, on your network',
  internet: 'Direct, over the internet',
  turn: 'Through Cloudflare’s TURN relay',
  worker: 'Through your relay Worker',
});
