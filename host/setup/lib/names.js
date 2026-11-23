// The rules for a PC name the owner chooses, for checking as they type. The Control Center can't load the website's shared
// code, so these are copies of normalizeMacName and CUSTOM_MAC_NAME_RE in site/js/shared/rendezvous.js; a test keeps
// them the same. The host checks again before renaming.
export const CUSTOM_MAC_NAME_RE = /^(?=.{4,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeMacName(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}
