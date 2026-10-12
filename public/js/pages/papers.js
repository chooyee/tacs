// Papers home (FR-PAP-01/02/07): the New paper dialog, and the paper-type filter on All papers.
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { openDialog, setupDialogs, setFormError } from '../lib/dialog.js';

const dialog = $('#new-paper-dialog');
const form = $('#new-paper-form');
const t = JSON.parse($('#papers-strings').dataset.json);
setupDialogs();

document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-action="new-paper"]')) return;
  form.reset();
  setFormError(dialog, '');
  openDialog(dialog);
});

// All papers: choosing a paper type filters straight away (the Filter button stays for keyboards).
$('[data-auto-submit]')?.addEventListener('change', (event) => event.target.form.submit());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = form.elements.title.value.trim();
  if (title.length < 3 || title.length > 150) {
    setFormError(dialog, t.titleError);
    form.elements.title.focus();
    return;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const created = await api('/api/papers', {
      method: 'POST',
      body: {
        title,
        vendor: form.elements.vendor.value,
        paperTypeId: form.elements.paperTypeId.value,
      },
    });
    window.location.assign(created.url);
  } catch (err) {
    setFormError(dialog, err.details?.[0]?.message ?? err.message);
    submit.disabled = false;
  }
});
