// A short, human description of this browser and device ("Safari on iPhone"), sent to the Mac when signing in so the
// Mac's menu and device list can say who is connected. Worked out from the user agent string, which is all a page has.

const BROWSERS = [
  [/EdgiOS\/|EdgA\/|Edg\//, 'Edge'],
  [/OPR\/|OPiOS\//, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/FxiOS\/|Firefox\//, 'Firefox'],
  [/CriOS\/|Chrome\/|Chromium\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\/|Mobile\/\w+.*Safari|AppleWebKit\/.*Mobile\//, 'Safari'],
];

export function browserName(ua = '') {
  for (const [re, name] of BROWSERS) if (re.test(ua)) return name;
  return 'A browser';
}

// iPads ask for desktop sites by default and then claim to be a Mac; a Mac has no touch screen, so touch points give
// them away.
export function deviceName(ua = '', { maxTouchPoints = 0 } = {}) {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'a device';
}

export function deviceLabel(ua = '', opts = {}) {
  return `${browserName(ua)} on ${deviceName(ua, opts)}`.slice(0, 48);
}

// Apple keyboards have ⌘ where the Mac expects it; everyone else gets "Ctrl acts as ⌘" by default.
export function isAppleDevice(ua = '', opts = {}) {
  return ['iPhone', 'iPad', 'Mac'].includes(deviceName(ua, opts));
}

// Phones and tablets: show the keyboard button and the keys bar, use touch gestures.
export function isTouchFirst(ua = '', { maxTouchPoints = 0, coarsePointer = false } = {}) {
  const d = deviceName(ua, { maxTouchPoints });
  return d === 'iPhone' || d === 'iPad' || d.startsWith('Android') || coarsePointer;
}
