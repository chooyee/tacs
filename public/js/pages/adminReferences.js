// Admin → References (D-37): search and filter the library, preview, delete with Undo.
import { api } from '../lib/api.js';
import { $, $$ } from '../lib/dom.js';
import { setupDialogs } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const list = $('#library-list');
const t = JSON.parse($('#library-strings').dataset.json);
let typeFilter = '';

setupDialogs();
setupReferenceViewer();

function applyFilters() {
  if (!list) return;
  const query = $('#library-search').value.trim().toLowerCase();
  let shown = 0;
  for (const row of $$('.ref-row', list)) {
    const match =
      (!typeFilter || row.dataset.type === typeFilter) && (!query || row.dataset.search.includes(query));
    row.hidden = !match;
    if (match) shown += 1;
  }
  $('#library-no-match').classList.toggle('hidden', shown > 0);
}

$('#library-search')?.addEventListener('input', applyFilters);
$('#library-filters')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-type]');
  if (!button) return;
  typeFilter = button.dataset.type;
  for (const b of $$('[data-type]', event.currentTarget))
    b.setAttribute('aria-pressed', String(b === button));
  applyFilters();
});

list?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('[data-reference-id]');
  const id = row.dataset.referenceId;
  if (button.dataset.action === 'view-reference') openReferenceViewer(id);
  if (button.dataset.action === 'delete-reference') {
    try {
      await api(`/api/admin/references/${id}`, { method: 'DELETE' });
      row.hidden = true;
      toast(t.deleted, {
        action: {
          label: t.undo,
          onClick: async () => {
            await api(`/api/admin/references/${id}/restore`, { method: 'POST' });
            row.hidden = false;
          },
        },
      });
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  }
});
