// Paper types page (FR-ADM-01/02): the New paper type dialog. Creating opens the editor.
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { openDialog, setupDialogs, setFormError } from '../lib/dialog.js';

const dialog = $('#new-type-dialog');
const form = $('#new-type-form');
setupDialogs();

document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-action="new-type"]')) return;
  form.reset();
  setFormError(dialog, '');
  openDialog(dialog);
});

// Picking a type to copy also selects the "Copy" option, so one click is enough.
$('#nt-copy')?.addEventListener('change', () => {
  form.querySelector('input[name="copyFromTypeId"][value="copy"]').checked = true;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = form.elements.name.value.trim();
  if (!name) {
    setFormError(dialog, 'Give the paper type a name.');
    form.elements.name.focus();
    return;
  }
  const copy = form.elements.copyFromTypeId.value === 'copy' ? $('#nt-copy').value : '';
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const created = await api('/api/admin/types', {
      method: 'POST',
      body: { name, description: form.elements.description.value, ...(copy && { copyFromTypeId: copy }) },
    });
    // A blank type opens with the "add standard" box ready (FR-ADM-02).
    window.location.assign(copy ? created.url : `${created.url}#add`);
  } catch (err) {
    setFormError(dialog, err.details?.[0]?.message ?? err.message);
    submit.disabled = false;
  }
});
