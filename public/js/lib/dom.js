// Tiny DOM helpers shared by the page scripts.

/** First element matching a CSS selector. */
export const $ = (selector, root = document) => root.querySelector(selector);

/** All elements matching a CSS selector, as an array. */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Escape text for the rare case HTML must be built as a string (prefer textContent). */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Call `fn` only after `ms` without new calls (autosave). */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
