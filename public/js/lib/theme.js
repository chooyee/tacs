// Runs in <head> before the page paints, so a dark-mode user never sees a white flash.
// A classic script (not a module) because modules are deferred. Stored choice wins over the OS setting.
(function applyTheme() {
  let stored = null;
  try {
    stored = window.localStorage.getItem('psc.theme');
  } catch {
    // localStorage can be blocked (privacy settings): fall back to the OS setting.
  }
  const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();
