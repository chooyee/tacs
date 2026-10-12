// Top bar behaviour that every page shares: the dark-mode toggle (docs/03 §1.1).
// The user menu dropdown is handled by Basecoat's dropdown-menu script.
import { $ } from './dom.js';

const root = document.documentElement;

/** Show the icon for the mode you would switch TO (moon in light mode, sun in dark mode). */
function syncIcon() {
  const dark = root.classList.contains('dark');
  $('.theme-light')?.classList.toggle('hidden', dark);
  $('.theme-dark')?.classList.toggle('hidden', !dark);
}

$('#theme-toggle')?.addEventListener('click', () => {
  const dark = root.classList.toggle('dark');
  syncIcon();
  try {
    window.localStorage.setItem('psc.theme', dark ? 'dark' : 'light');
  } catch {
    // Not saved (storage blocked): the choice lasts until the page reloads.
  }
});
syncIcon();
