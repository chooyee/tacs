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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  if (!name) {
    setFormError(dialog, 'Name is required.');
    $('#nt-name').focus();
    return;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const created = await api('/api/admin/types', {
      method: 'POST',
      body: {
        name,
        description: String(data.get('description')),
        ...(data.get('copyFromTypeId') && { copyFromTypeId: String(data.get('copyFromTypeId')) }),
      },
    });
    // A blank type opens with the "add standard" box ready (FR-ADM-02).
    window.location.assign(data.get('copyFromTypeId') ? created.url : `${created.url}#add`);
  } catch (err) {
    setFormError(dialog, err.details?.[0]?.message ?? err.message);
    submit.disabled = false;
  }
});
