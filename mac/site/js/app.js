// The home-screen app's first page (app.html, the manifest's start_url): straight to the sign-in page of the kind of
// computer you use (remembered by js/platform.js), or the choice when it isn't known yet.
const CHOICE = 'perch.platform.v1';
const TARGET = { mac: 'connect.html', windows: 'windows/connect.html' };
let choice = null;
try { choice = localStorage.getItem(CHOICE); } catch { /* not remembered */ }
if (TARGET[choice]) {
  location.replace(TARGET[choice]);
} else {
  document.getElementById('choose').hidden = false;
  for (const a of document.querySelectorAll('[data-choose]')) {
    a.addEventListener('click', () => { try { localStorage.setItem(CHOICE, a.dataset.choose); } catch { /* fine */ } });
  }
}
