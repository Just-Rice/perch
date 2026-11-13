// The rules for a Mac name the owner chooses, for checking as they type. The Setup page can't load the website's shared
// code, so these are copies of normalizeMacName and CUSTOM_MAC_NAME_RE in site/js/shared/rendezvous.js; a test keeps
// them the same. The Mac checks again before renaming.
export const CUSTOM_MAC_NAME_RE = /^(?=.{4,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeMacName(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}
