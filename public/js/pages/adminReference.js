// Full-screen add / edit of a library reference (D-37): type, title, file, link, rich guidance.
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { setupDialogs } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { setupReferenceFields } from '../lib/referenceForm.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const page = $('#reference-page');
const form = $('#reference-form');
const referenceId = page.dataset.referenceId;
const t = JSON.parse(page.dataset.strings);
const fields = setupReferenceFields(form, 'rf');

setupDialogs();
setupReferenceViewer();

let dirty = false;
form.addEventListener('input', () => {
  dirty = true;
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

page.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="view-reference"]');
  if (button) openReferenceViewer(button.dataset.referenceId);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('.form-bar .form-error');
  const problem = fields.validate(!referenceId);
  error.textContent = problem;
  error.hidden = !problem;
  if (problem) return;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const saved = await api(referenceId ? `/api/admin/references/${referenceId}` : '/api/admin/references', {
      method: referenceId ? 'PATCH' : 'POST',
      body: fields.toFormData(),
    });
    dirty = false;
    if (page.dataset.forStandard === 'true') {
      // D-38: the standard form that opened this tab ticks the new reference (same-origin message).
      const channel = new BroadcastChannel('psc-references');
      channel.postMessage({ type: 'reference-created', reference: saved });
      channel.close();
      toast(t.linkedClose);
      window.close(); // works for a tab opened by the standard form; otherwise we stay and go on below
      setTimeout(() => window.location.assign(saved.url), 1500);
      return;
    }
    toast(t.saved);
    // Reload so "Last edited by" and the file details show the saved state.
    window.location.assign(referenceId ? window.location.pathname : saved.url);
  } catch (err) {
    error.textContent = err.details?.[0]?.message ?? err.message;
    error.hidden = false;
    submit.disabled = false;
  }
});
