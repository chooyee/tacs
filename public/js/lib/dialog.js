// Native <dialog> helpers (Basecoat Dialog). Esc closes (browser default) and focus goes back to
// whatever opened the dialog (docs/03 §1.2).

const openers = new WeakMap();

/** Update a "123 / 500" counter that follows a textarea marked data-counter. */
export function updateCounter(textarea) {
  const counter = textarea.nextElementSibling;
  if (counter?.classList.contains('counter')) {
    counter.textContent = `${textarea.value.length} / ${textarea.maxLength}`;
  }
}

/**
 * Open a dialog as modal, remembering the element that had focus.
 * @param {HTMLDialogElement} dialog
 */
export function openDialog(dialog) {
  openers.set(dialog, document.activeElement);
  dialog.showModal();
  for (const textarea of dialog.querySelectorAll('textarea[data-counter]')) updateCounter(textarea);
  dialog.querySelector('[autofocus], input[type=text], input[type=url], textarea, select')?.focus();
}

/**
 * Close a dialog (focus returns to its opener via the "close" listener below).
 * @param {HTMLDialogElement} dialog
 */
export function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

/**
 * Wire every dialog on the page once: close buttons, clicking the backdrop, counters, focus return.
 */
export function setupDialogs() {
  for (const dialog of document.querySelectorAll('dialog.dialog')) {
    dialog.addEventListener('click', (event) => {
      // A click on the dialog element itself (not its content) is a click on the backdrop.
      if (event.target === dialog || event.target.closest('[data-action="close-dialog"]')) {
        closeDialog(dialog);
      }
    });
    dialog.addEventListener('input', (event) => {
      if (event.target.matches('textarea[data-counter]')) updateCounter(event.target);
    });
    dialog.addEventListener('close', () => {
      const opener = openers.get(dialog);
      if (opener?.isConnected) opener.focus();
    });
  }
}

/**
 * Show a form error inside a dialog (or hide it with an empty message).
 * @param {HTMLElement} dialog
 * @param {string} message
 */
export function setFormError(dialog, message) {
  const el = dialog.querySelector('.form-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}
