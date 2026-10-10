// Users page (FR-ACC-09): changing a role or status select saves it straight away.
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { toast } from '../lib/toast.js';

const table = $('#users-table');

table?.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-field]');
  if (!select) return;
  const row = select.closest('[data-user-id]');
  const previous = select.dataset.saved ?? select.querySelector('option[selected]')?.value;

  select.disabled = true;
  try {
    const user = await api(`/api/admin/users/${row.dataset.userId}`, {
      method: 'PATCH',
      body: { [select.dataset.field]: select.value },
    });
    select.dataset.saved = user[select.dataset.field];
    toast('Saved');
  } catch (err) {
    select.value = previous; // put the old value back so the page shows the truth
    toast(err.message, { error: true, ref: err.requestId });
  } finally {
    select.disabled = false;
  }
});
