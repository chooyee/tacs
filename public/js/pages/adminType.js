// Paper type editor (FR-ADM-10…21, docs/03 §3.7).
// After each change the affected card is re-fetched as server-rendered HTML, so the markup lives
// only in the EJS partials. Actions are delegated from the page with data-action attributes.
import { api, fetchHtml } from '../lib/api.js';
import { $, $$, debounce } from '../lib/dom.js';
import { openDialog, closeDialog, setupDialogs, setFormError } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const editor = $('#type-editor');
const typeId = editor.dataset.typeId;
const t = JSON.parse(editor.dataset.strings);

setupDialogs();
setupReferenceViewer();

/** Show an API error the standard way: friendly message + request reference (docs/03 §4). */
function showError(err) {
  toast(err.message, { error: true, ref: err.requestId });
}

/** Re-render one or both cards from the server. */
async function refresh(...cards) {
  for (const card of cards) {
    const html = await fetchHtml(`/admin/types/${typeId}/cards/${card}`);
    const template = document.createElement('template');
    template.innerHTML = html.trim(); // server-rendered with escaped output (<%= %>)
    $(`#${card}-card`).replaceWith(template.content.firstElementChild);
  }
}

/** Run an API call, then refresh cards; errors become a toast. */
async function change(call, cards = ['standards']) {
  try {
    const result = await call();
    await refresh(...cards);
    return result;
  } catch (err) {
    showError(err);
    return undefined;
  }
}

/** Delete with an Undo toast (FR-ADM-13, FR-ADM-18): soft delete now, restore if Undo is clicked. */
async function deleteWithUndo(url, message, cards) {
  const ok = await change(() => api(url, { method: 'DELETE' }).then(() => true), cards);
  if (!ok) return;
  toast(message, {
    action: { label: t.undo, onClick: () => change(() => api(`${url}/restore`, { method: 'POST' }), cards) },
  });
}

/* ---------- Name and description: autosave (FR-ADM-10) ---------- */

const saveStatus = $('.save-status');
const saveTypeField = debounce(async (input) => {
  const value = input.value.trim();
  if (input.dataset.field === 'name' && !value) return; // the name is required; wait for text
  saveStatus.textContent = t.saving;
  try {
    await api(`/api/admin/types/${typeId}`, { method: 'PATCH', body: { [input.dataset.field]: value } });
    saveStatus.textContent = t.saved;
  } catch (err) {
    saveStatus.textContent = t.notSaved;
    showError(err);
  }
}, 600);
for (const input of $$('[data-field]', editor)) input.addEventListener('input', () => saveTypeField(input));

/* ---------- Section titles: save on change (blur / Enter) ---------- */

editor.addEventListener('change', async (event) => {
  const input = event.target.closest('.section-title');
  if (!input) return;
  const sectionId = input.closest('[data-section-id]').dataset.sectionId;
  const title = input.value.trim();
  if (!title) {
    input.value = input.defaultValue; // a section needs a title: put the old one back
    return;
  }
  try {
    await api(`/api/admin/sections/${sectionId}`, { method: 'PATCH', body: { title } });
    input.defaultValue = title;
  } catch (err) {
    showError(err);
  }
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.section-title')) event.target.blur();
});

/* ---------- Inline "add standard" box (FR-ADM-16) ---------- */

/** Open the add box at the end of a section and focus it. */
function openAddBox(sectionId) {
  closeAddBox();
  const slot = $(`[data-section-id="${sectionId}"] .add-slot`);
  if (!slot) return;
  const box = document.createElement('div');
  box.className = 'add-box grid gap-1';
  const textarea = Object.assign(document.createElement('textarea'), {
    className: 'textarea',
    rows: 2,
    maxLength: 500,
    placeholder: t.addPlaceholder,
  });
  textarea.setAttribute('aria-label', t.addPlaceholder);
  const row = document.createElement('div');
  row.className = 'flex items-center justify-between gap-2';
  const hint = Object.assign(document.createElement('span'), {
    className: 'text-xs text-muted-foreground',
    textContent: t.addHint,
  });
  const done = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'btn',
    textContent: t.done,
  });
  done.dataset.variant = 'outline';
  done.dataset.size = 'sm';
  done.dataset.action = 'close-add';
  row.append(hint, done);
  box.append(textarea, row);
  slot.replaceChildren(box);
  box.dataset.sectionId = sectionId;
  textarea.focus();
}

function closeAddBox() {
  const box = $('.add-box');
  if (!box) return;
  const slot = box.parentElement;
  const link = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'add-link',
    textContent: t.addStandard,
  });
  link.dataset.action = 'open-add';
  slot.replaceChildren(link);
}

/** Save the box's text (if any). Keeps the box open for the next one when `keepOpen`. */
async function submitAddBox({ keepOpen }) {
  const box = $('.add-box');
  if (!box) return;
  const sectionId = box.dataset.sectionId;
  const text = box.querySelector('textarea').value.trim();
  if (text) {
    const created = await change(() =>
      api(`/api/admin/sections/${sectionId}/standards`, { method: 'POST', body: { text } }),
    );
    if (!created) return; // error shown; keep what was typed
  }
  if (keepOpen)
    openAddBox(sectionId); // the card was re-rendered: open a fresh box
  else if (!text) closeAddBox();
}

editor.addEventListener('keydown', (event) => {
  if (!event.target.closest('.add-box')) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitAddBox({ keepOpen: true });
  } else if (event.key === 'Escape') {
    event.preventDefault();
    submitAddBox({ keepOpen: false });
  }
});

/* ---------- Reference dialog (FR-ADM-12) ---------- */

const referenceDialog = $('#reference-dialog');
const referenceForm = $('#reference-form');

function openReferenceDialog(row) {
  referenceForm.reset();
  setFormError(referenceDialog, '');
  referenceForm.dataset.referenceId = row?.dataset.referenceId ?? '';
  $('#reference-dialog-title').textContent = row ? t.editReference : t.addReference;
  $('.file-help', referenceForm).textContent = row ? t.fileReplaceHelp : t.fileHelp;
  $('.file-required', referenceForm).hidden = Boolean(row);
  if (row) {
    referenceForm.elements.type.value = row.dataset.type;
    referenceForm.elements.title.value = row.dataset.title;
    referenceForm.elements.url.value = row.dataset.url;
    referenceForm.elements.note.value = row.dataset.note;
  }
  openDialog(referenceDialog);
}

referenceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = referenceForm.dataset.referenceId;
  const data = new FormData(referenceForm);
  if (!data.get('file')?.size) data.delete('file'); // editing without a new file keeps the old one
  if (!id && !data.has('file')) return setFormError(referenceDialog, 'Choose a file to upload.');
  if (!String(data.get('title')).trim()) return setFormError(referenceDialog, 'Title is required.');
  const submit = referenceForm.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await api(id ? `/api/admin/references/${id}` : `/api/admin/types/${typeId}/references`, {
      method: id ? 'PATCH' : 'POST',
      body: data,
    });
    closeDialog(referenceDialog);
    await refresh('references', 'standards');
  } catch (err) {
    setFormError(referenceDialog, err.details?.[0]?.message ?? err.message);
  } finally {
    submit.disabled = false;
  }
});

/* ---------- Standard dialog (FR-ADM-17, FR-ADM-21) ---------- */

const standardDialog = $('#standard-dialog');
const standardForm = $('#standard-form');

function updateTooMany() {
  const count = $$('input[name="referenceIds"]:checked', standardForm).length;
  $('.too-many', standardForm).hidden = count <= 4;
}

function openStandardDialog(row) {
  setFormError(standardDialog, '');
  standardForm.dataset.standardId = row.dataset.standardId;
  standardForm.elements.text.value = row.dataset.text;
  standardForm.elements.isMandatory.checked = row.dataset.mandatory === 'true';
  const linked = new Set(row.dataset.referenceIds.split(',').filter(Boolean));
  const options = JSON.parse($('#reference-options').dataset.json);
  $('#sf-references').replaceChildren(
    ...options.map((ref) => {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 text-sm';
      const box = Object.assign(document.createElement('input'), {
        type: 'checkbox',
        className: 'input',
        name: 'referenceIds',
        value: ref.id,
        checked: linked.has(ref.id),
      });
      label.append(box, document.createTextNode(` ${ref.icon} ${ref.title} (${ref.type})`));
      return label;
    }),
  );
  updateTooMany();
  openDialog(standardDialog);
}

standardForm.addEventListener('change', updateTooMany);
standardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = standardForm.elements.text.value.trim();
  if (!text) return setFormError(standardDialog, 'The standard is required.');
  const body = {
    text,
    isMandatory: standardForm.elements.isMandatory.checked,
    referenceIds: $$('input[name="referenceIds"]:checked', standardForm).map((box) => box.value),
  };
  try {
    const saved = await api(`/api/admin/standards/${standardForm.dataset.standardId}`, {
      method: 'PATCH',
      body,
    });
    closeDialog(standardDialog);
    await refresh('standards', 'references');
    for (const warning of saved.warnings ?? []) toast(warning);
  } catch (err) {
    setFormError(standardDialog, err.details?.[0]?.message ?? err.message);
  }
});

/* ---------- Click actions ---------- */

const actions = {
  'add-section': async () => {
    const section = await change(() =>
      api(`/api/admin/types/${typeId}/sections`, { method: 'POST', body: { title: t.newSection } }),
    );
    if (!section) return;
    // FR-ADM-14: select the new title for editing; its add box opens when the title is done.
    const input = $(`[data-section-id="${section.id}"] .section-title`);
    input.focus();
    input.select();
    input.addEventListener('blur', () => openAddBox(section.id), { once: true });
  },
  'move-section': (button, section) =>
    change(() =>
      api(`/api/admin/sections/${section.dataset.sectionId}/move`, {
        method: 'POST',
        body: { direction: button.dataset.direction },
      }),
    ),
  'delete-section': (_b, section) =>
    deleteWithUndo(`/api/admin/sections/${section.dataset.sectionId}`, t.deletedSection, [
      'standards',
      'references',
    ]),
  'open-add': (_b, section) => openAddBox(section.dataset.sectionId),
  'close-add': () => submitAddBox({ keepOpen: false }),
  'toggle-mandatory': (_b, _s, row) =>
    change(() =>
      api(`/api/admin/standards/${row.dataset.standardId}`, {
        method: 'PATCH',
        body: { isMandatory: row.dataset.mandatory !== 'true' },
      }),
    ),
  'edit-standard': (_b, _s, row) => openStandardDialog(row),
  'move-standard': (button, _s, row) =>
    change(() =>
      api(`/api/admin/standards/${row.dataset.standardId}/move`, {
        method: 'POST',
        body: { direction: button.dataset.direction },
      }),
    ),
  'delete-standard': (_b, _s, row) =>
    deleteWithUndo(`/api/admin/standards/${row.dataset.standardId}`, t.deletedStandard, [
      'standards',
      'references',
    ]),
  'add-reference': () => openReferenceDialog(null),
  'edit-reference': (_b, _s, row) => openReferenceDialog(row),
  'delete-reference': (_b, _s, row) =>
    deleteWithUndo(`/api/admin/references/${row.dataset.referenceId}`, t.deletedReference, [
      'references',
      'standards',
    ]),
  'view-reference': (button, _s, row) =>
    openReferenceViewer(button.dataset.referenceId ?? row.dataset.referenceId),
  'delete-type': async () => {
    // A native confirm is accessible and enough for this rare action.
    if (!window.confirm(t.confirmDeleteType)) return;
    try {
      await api(`/api/admin/types/${typeId}`, { method: 'DELETE' });
      window.location.assign('/admin/types');
    } catch (err) {
      showError(err);
    }
  },
};

editor.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || !actions[button.dataset.action]) return;
  const section = button.closest('[data-section-id]');
  const row = button.closest('[data-standard-id], [data-reference-id]');
  actions[button.dataset.action](button, section, row);
});

// FR-ADM-02: a new blank type opens with the add box of its first section ready.
if (window.location.hash === '#add') {
  history.replaceState(null, '', window.location.pathname);
  const first = $('[data-section-id]');
  if (first) openAddBox(first.dataset.sectionId);
}
