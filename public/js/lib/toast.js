// Toast messages (docs/03 §1.2), styled by Basecoat's .toaster / .toast CSS.
// Built with textContent (never innerHTML), so server or user text can't inject HTML (NFR-SEC-05).
import { $ } from './dom.js';

const DEFAULT_MS = 2200;
const ERROR_MS = 6000;

/**
 * Show a short message at the bottom of the screen.
 * @param {string} message
 * @param {{error?: boolean, ref?: string}} [opts]  ref = request ID, shown so support can find the log line
 */
export function toast(message, { error = false, ref } = {}) {
  const toaster = $('#toaster');
  if (!toaster) return;

  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', error ? 'alert' : 'status');
  el.dataset.category = error ? 'error' : 'success';

  const content = document.createElement('div');
  content.className = 'toast-content';
  const section = document.createElement('section');
  const text = document.createElement('h2');
  text.textContent = message;
  section.append(text);
  if (ref) {
    const small = document.createElement('p');
    small.textContent = `ref ${ref.slice(0, 8)}`;
    section.append(small);
  }
  content.append(section);
  el.append(content);
  toaster.append(el);

  setTimeout(() => el.remove(), error ? ERROR_MS : DEFAULT_MS);
}
