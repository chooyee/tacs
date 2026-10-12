// Full-screen standard form (D-38): add / edit a standard, search and tick library references.
// "New reference" opens the References module in a new tab; what is saved there is ticked here. Linked standards are read-only except their
// section (position stays local) and offer "Duplicate here".
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { setupDialogs } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { createRichEditor } from '../lib/richEditor.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const page = $('#standard-page');
const form = $('#standard-form');
const t = JSON.parse(page.dataset.strings);
const typeId = page.dataset.typeId;
const standardId = page.dataset.standardId;
const isLinked = page.dataset.linked === 'true';
const options = JSON.parse(page.dataset.options);
const selected = new Set(JSON.parse(page.dataset.selected));
const startSection = form.elements.sectionId.value;
const MAX_REFS = 4; // FR-ADM-21

setupDialogs();
setupReferenceViewer();
const description = isLinked ? null : createRichEditor($('#sf-description'));

/* ---------- Unsaved changes guard ---------- */

let dirty = false;
const markDirty = () => {
  dirty = true;
};
form.addEventListener('input', markDirty);
description?.onChange(markDirty);
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

/* ---------- Reference picker: chips of what is selected + searchable results ---------- */

const byId = new Map(options.map((o) => [o.id, o]));

function chip(ref) {
  const el = document.createElement('span');
  el.className = 'ref-chip selected';
  const view = Object.assign(document.createElement('button'), { type: 'button', className: 'chip-view' });
  view.dataset.action = 'view-reference';
  view.dataset.referenceId = ref.id;
  view.append(
    Object.assign(document.createElement('span'), { textContent: ref.icon, ariaHidden: 'true' }),
    Object.assign(document.createElement('span'), { className: 't', textContent: ref.title }),
  );
  el.append(view);
  if (!isLinked) {
    const remove = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'chip-remove',
      textContent: '×',
    });
    remove.dataset.action = 'unselect';
    remove.dataset.referenceId = ref.id;
    remove.setAttribute('aria-label', `${t.remove}: ${ref.title}`);
    el.append(remove);
  }
  return el;
}

function renderSelected() {
  const list = [...selected].map((id) => byId.get(id)).filter(Boolean);
  $('#selected-refs').replaceChildren(
    ...(list.length
      ? list.map(chip)
      : [Object.assign(document.createElement('p'), { className: 'help', textContent: t.noneSelected })]),
  );
  $('#ref-count').textContent = list.length;
  $('.too-many').hidden = list.length <= MAX_REFS;
}

function renderResults() {
  const box = $('#ref-results');
  if (!box) return;
  const query = $('#ref-search').value.trim().toLowerCase();
  const matches = options.filter(
    (o) => !query || `${o.title} ${o.type} ${o.note}`.toLowerCase().includes(query),
  );
  box.replaceChildren(
    ...(matches.length
      ? matches.map((ref) => {
          const label = document.createElement('label');
          label.className = 'picker-row';
          const input = Object.assign(document.createElement('input'), {
            type: 'checkbox',
            className: 'input',
            value: ref.id,
            checked: selected.has(ref.id),
          });
          const text = document.createElement('span');
          text.className = 'min-w-0 flex-1';
          text.append(
            Object.assign(document.createElement('span'), {
              className: 'block truncate font-medium',
              textContent: `${ref.icon} ${ref.title}`,
            }),
            Object.assign(document.createElement('span'), {
              className: 'block truncate text-xs text-muted-foreground',
              textContent: `${ref.type}${ref.note ? ` · ${ref.note}` : ''}`,
            }),
          );
          label.append(input, text);
          return label;
        })
      : [Object.assign(document.createElement('p'), { className: 'help p-2', textContent: t.noMatch })]),
  );
}

$('#ref-results')?.addEventListener('change', (event) => {
  if (event.target.checked) selected.add(event.target.value);
  else selected.delete(event.target.value);
  markDirty();
  renderSelected();
});
$('#ref-search')?.addEventListener('input', renderResults);

/* ---------- New reference: made in the References module, ticked here (D-38) ---------- */

const icons = JSON.parse(page.dataset.icons);
const channel = new BroadcastChannel('psc-references');
channel.addEventListener('message', ({ data }) => {
  if (data?.type !== 'reference-created' || isLinked) return;
  const ref = data.reference;
  if (!byId.has(ref.id)) {
    const option = { id: ref.id, type: ref.type, title: ref.title, note: ref.note ?? '', icon: icons[ref.type] ?? '' };
    options.unshift(option);
    byId.set(ref.id, option);
  }
  selected.add(ref.id);
  markDirty();
  renderSelected();
  renderResults();
  toast(t.linked.replace('{title}', ref.title));
});

/* ---------- Save ---------- */

function backToType(id) {
  dirty = false;
  window.location.assign(`/admin/types/${typeId}${id ? `#std-${id}` : ''}`);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('.form-bar .form-error');
  const show = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };
  const sectionId = form.elements.sectionId.value;
  const title = form.elements.title.value.trim();
  if (!isLinked && !title) return show('Give the standard a title.');
  show('');
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    let id = standardId;
    if (!standardId) {
      const created = await api(`/api/admin/sections/${sectionId}/standards`, {
        method: 'POST',
        body: {
          title,
          description: description.getHtml(),
          isMandatory: form.elements.isMandatory.checked,
          referenceIds: [...selected],
        },
      });
      id = created.id;
    } else {
      if (!isLinked) {
        await api(`/api/admin/standards/${standardId}`, {
          method: 'PATCH',
          body: {
            title,
            description: description.getHtml(),
            isMandatory: form.elements.isMandatory.checked,
            referenceIds: [...selected],
          },
        });
      }
      if (sectionId !== startSection) {
        await api(`/api/admin/standards/${standardId}/move`, {
          method: 'POST',
          body: { sectionId, index: 1000 },
        });
      }
    }
    toast(t.saved);
    backToType(id);
  } catch (err) {
    show(err.details?.[0]?.message ?? err.message);
    submit.disabled = false;
  }
});

/* ---------- Clicks ---------- */

page.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, referenceId } = button.dataset;
  if (action === 'view-reference') openReferenceViewer(referenceId);
  if (action === 'unselect') {
    selected.delete(referenceId);
    markDirty();
    renderSelected();
    renderResults();
  }
  if (action === 'duplicate') {
    try {
      await api(`/api/admin/standards/${standardId}/duplicate`, { method: 'POST' });
      dirty = false;
      toast(t.duplicated);
      window.location.reload();
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  }
});

renderSelected();
renderResults();
