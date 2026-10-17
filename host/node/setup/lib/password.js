// A plain-language strength hint for the backup password. Perch's suggestion (five random words, about 50 bits) is
// the yardstick: anything shorter than 12 characters is refused, and only long or varied passwords count as strong.

export const MIN_LENGTH = 12;

// -> {ok, level: 'empty' | 'short' | 'weak' | 'ok' | 'strong', text}
export function passwordStrength(pw, macName = '') {
  const p = String(pw ?? '');
  if (!p) return { ok: false, level: 'empty', text: `Use at least ${MIN_LENGTH} characters, or press "Suggest a strong password".` };
  const chars = [...p].length;
  if (chars < MIN_LENGTH) {
    const more = MIN_LENGTH - chars;
    return { ok: false, level: 'short', text: `Too short: add ${more} more character${more === 1 ? '' : 's'}.` };
  }
  const lower = p.toLowerCase();
  if (macName && lower.includes(macName.toLowerCase())) {
    return { ok: false, level: 'weak', text: 'Don\'t use the Mac\'s name in the password: it\'s the username.' };
  }
  if (new Set(lower).size <= 3 || /^(?:0123456789|1234567890|abcdefghijkl|qwertyuiop)/.test(lower)) {
    return { ok: false, level: 'weak', text: 'That\'s too easy to guess. Try the suggested password instead.' };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(p)).length;
  const words = p.split(/[\s\-_.,]+/).filter(w => w.length >= 3).length;
  if (chars >= 20 || (chars >= 16 && (kinds >= 3 || words >= 4))) return { ok: true, level: 'strong', text: 'Strong password.' };
  return { ok: true, level: 'ok', text: 'OK. A longer one is stronger: the suggested password is a good choice.' };
}
