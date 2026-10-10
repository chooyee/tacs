// Top bar behaviour that every page shares: the dark-mode toggle (docs/03 §1.1).
// The user menu dropdown is handled by Basecoat's dropdown-menu script.
import { $ } from './dom.js';

const toggle = $('#theme-toggle');
toggle?.addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    window.localStorage.setItem('psc.theme', dark ? 'dark' : 'light');
  } catch {
    // Not saved (storage blocked): the choice lasts until the page reloads.
  }
});
