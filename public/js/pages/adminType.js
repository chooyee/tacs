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
const MAX_REFS = 4; // FR-ADM-21

setupDialogs();
setupReferenceViewer();

/** Show an API error the standard way: friendly message + request reference (docs/03 §4). */
function showError(err) {
  toast(err.message, { error: true, ref: err.requestId });
}

/* ---------- One save indicator for every autosave (docs/03 §4) ---------- */

const saveState = $('.save-state');
let savedTimer;
/** @param {'saving'|'saved'|'error'} state */
function setSaveState(state) {
  clearTimeout(savedTimer);
  saveState.dataset.state = state;
  saveState.textContent = { saving: t.saving, saved: `✓ ${t.saved}`, error: t.notSaved }[state];
  if (state === 'saved') {
    savedTimer = setTimeout(() => {
      saveState.dataset.state = 'idle';
      saveState.textContent = '';
    }, 2500);
  }
}

/** Run a save and reflect it in the indicator. Errors become a toast. */
async function saving(call) {
  setSaveState('saving');
  try {
    const result = await call();
    setSaveState('saved');
    return result;
  } catch (err) {
    setSaveState('error');
    showError(err);
    return undefined;
  }
}

/* ---------- Cards: re-render from the server after a change ---------- */

async function refresh(...cards) {
  for (const card of cards) {
    const html = await fetchHtml(`/admin/types/${typeId}/cards/${card}`);
    const template = document.createElement('template');
    template.innerHTML = html.trim(); // server-rendered with escaped output (<%= %>)
    $(`#${card}-card`).replaceWith(template.content.firstElementChild);
  }
  buildJumpBar();
}

/** Save, then refresh cards. Returns the API result, or undefined on error. */
function change(call, cards = ['standards']) {
  return saving(async () => {
    const result = await call();
    await refresh(...cards);
    return result ?? true;
  });
}

/** Delete with an Undo toast (FR-ADM-13, FR-ADM-18): soft delete now, restore if Undo is clicked. */
async function deleteWithUndo(url, message, cards) {
  const ok = await change(() => api(url, { method: 'DELETE' }), cards);
  if (!ok) return;
  toast(message, {
    action: { label: t.undo, onClick: () => change(() => api(`${url}/restore`, { method: 'POST' }), cards) },
  });
}

/* ---------- Sticky jump bar: References + one chip per section ---------- */

const chips = $('#jump-chips');
let observer;

function buildJumpBar() {
  const targets = [$('#references-card'), ...$$('.admin-section')].filter(Boolean);
  chips.replaceChildren(
    ...targets.map((target) => {
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'chip' });
      chip.dataset.target = target.id;
      const key = Object.assign(document.createElement('span'), {
        className: 'chip-key',
        textContent: target.dataset.jumpKey ?? '§',
      });
      const name = Object.assign(document.createElement('span'), {
        className: 'chip-name',
        textContent: target.dataset.jumpLabel,
      });
      const count = Object.assign(document.createElement('span'), {
        className: 'chip-count',
        textContent: target.dataset.jumpCount,
      });
      chip.setAttribute('aria-label', `${target.dataset.jumpKey ?? ''} ${target.dataset.jumpLabel}`.trim());
      chip.append(key, name, count);
      return chip;
    }),
  );
  // Highlight the chip of the part that is at the top of the screen.
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      for (const chip of $$('.chip', chips)) {
        const current = chip.dataset.target === visible.target.id;
        chip.setAttribute('aria-current', String(current));
        if (current) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    },
    { rootMargin: '-120px 0px -60% 0px' },
  );
  for (const target of targets) observer.observe(target);
}

chips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (chip)
    document.getElementById(chip.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- Name and description: autosave (FR-ADM-10) ---------- */

const saveTypeField = debounce((input) => {
  const value = input.value.trim();
  if (input.dataset.field === 'name' && !value) return; // the name is required; wait for text
  saving(async () => {
    await api(`/api/admin/types/${typeId}`, { method: 'PATCH', body: { [input.dataset.field]: value } });
    if (input.dataset.field === 'name') $('.type-crumb').textContent = value;
  });
}, 600);
for (const input of $$('[data-field]', editor)) input.addEventListener('input', () => saveTypeField(input));
// Enter in the description finishes editing instead of adding a line break.
$('[data-field="description"]').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  }
});

/* ---------- Section titles: save on change (blur / Enter) ---------- */

editor.addEventListener('change', (event) => {
  const input = event.target.closest('.section-title');
  if (!input) return;
  const section = input.closest('[data-section-id]');
  const title = input.value.trim();
  if (!title) {
    input.value = input.defaultValue; // a section needs a title: put the old one back
    return;
  }
  saving(async () => {
    await api(`/api/admin/sections/${section.dataset.sectionId}`, { method: 'PATCH', body: { title } });
    input.defaultValue = title;
    section.dataset.jumpLabel = title;
    buildJumpBar();
  });
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.section-title')) event.target.blur();
});

/* ---------- Inline "add standard" box (FR-ADM-16) ---------- */

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function addLink() {
  const link = el('button', { type: 'button', className: 'add-link', textContent: `＋ ${t.addStandard}` });
  link.dataset.action = 'open-add';
  return link;
}

/** Open the add box at the end of a section and focus it. */
function openAddBox(sectionId) {
  closeAddBox();
  const slot = $(`[data-section-id="${sectionId}"] .add-slot`);
  if (!slot) return;
  const textarea = el('textarea', { rows: 2, maxLength: 500, placeholder: t.addPlaceholder });
  textarea.setAttribute('aria-label', t.addPlaceholder);
  const done = el('button', { type: 'button', className: 'btn', textContent: t.done });
  Object.assign(done.dataset, { variant: 'outline', size: 'sm', action: 'close-add' });
  const box = el(
    'div',
    { className: 'add-box' },
    textarea,
    el(
      'div',
      { className: 'flex items-center justify-between gap-2' },
      el('span', { className: 'hint', textContent: t.addHint }),
      done,
    ),
  );
  box.dataset.sectionId = sectionId;
  slot.replaceChildren(box);
  textarea.focus();
}

function closeAddBox() {
  const box = $('.add-box');
  if (box) box.parentElement.replaceChildren(addLink());
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
  else closeAddBox();
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

/* ---------- Reference dialog (FR-ADM-12): type cards + file drop zone ---------- */

const referenceDialog = $('#reference-dialog');
const referenceForm = $('#reference-form');
const fileInput = $('#rf-file');
const dropzone = $('.dropzone', referenceForm);

function showChosenFile() {
  const file = fileInput.files[0];
  $('.file-name', dropzone).textContent = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
    : t.chooseFile;
}
fileInput.addEventListener('change', showChosenFile);
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, () => dropzone.classList.add('over'));
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}

function openReferenceDialog(row) {
  referenceForm.reset();
  showChosenFile();
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
  referenceForm.elements.title.focus();
}

referenceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = referenceForm.dataset.referenceId;
  const data = new FormData(referenceForm);
  if (!data.get('file')?.size) data.delete('file'); // editing without a new file keeps the old one
  if (!String(data.get('title')).trim()) return setFormError(referenceDialog, 'Give the reference a title.');
  if (!id && !data.has('file')) return setFormError(referenceDialog, 'Choose a file to upload.');
  const submit = referenceForm.querySelector('[type=submit]');
  submit.disabled = true;
  setSaveState('saving');
  try {
    await api(id ? `/api/admin/references/${id}` : `/api/admin/types/${typeId}/references`, {
      method: id ? 'PATCH' : 'POST',
      body: data,
    });
    closeDialog(referenceDialog);
    await refresh('references', 'standards');
    setSaveState('saved');
  } catch (err) {
    setSaveState('error');
    setFormError(referenceDialog, err.details?.[0]?.message ?? err.message);
  } finally {
    submit.disabled = false;
  }
});

/* ---------- Standard dialog (FR-ADM-17, FR-ADM-21): grouped, filterable picker ---------- */

const standardDialog = $('#standard-dialog');
const standardForm = $('#standard-form');
const picker = $('#sf-references');

function updatePickerState() {
  const checked = $$('input[name="referenceIds"]:checked', standardForm).length;
  $('.selected-count', standardForm).textContent = t.selected.replace('{n}', checked);
  $('.too-many', standardForm).hidden = checked <= MAX_REFS;
}

function buildPicker(linked) {
  const options = JSON.parse($('#reference-options').dataset.json);
  const groups = Map.groupBy(options, (ref) => ref.type);
  picker.replaceChildren(
    ...[...groups].map(([type, refs]) =>
      el(
        'div',
        { className: 'picker-group' },
        el('h4', { textContent: `${refs[0].icon} ${type}` }),
        ...refs.map((ref) => {
          const box = el('input', {
            type: 'checkbox',
            className: 'input',
            name: 'referenceIds',
            value: ref.id,
            checked: linked.has(ref.id),
          });
          const label = el('label', {}, box, el('span', { textContent: ref.title }));
          label.dataset.search = ref.title.toLowerCase();
          return label;
        }),
      ),
    ),
    el('p', { className: 'picker-empty hint', textContent: t.noMatch, hidden: true }),
  );
  if (!options.length) picker.replaceChildren(el('p', { className: 'hint', textContent: t.noMatch }));
}

$('#sf-filter').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  let shown = 0;
  for (const group of $$('.picker-group', picker)) {
    let groupShown = 0;
    for (const label of $$('label', group)) {
      const match = !query || label.dataset.search.includes(query);
      label.hidden = !match;
      if (match) groupShown += 1;
    }
    group.hidden = groupShown === 0;
    shown += groupShown;
  }
  const empty = $('.picker-empty', picker);
  if (empty) empty.hidden = shown > 0;
});

function openStandardDialog(row) {
  setFormError(standardDialog, '');
  standardForm.dataset.standardId = row.dataset.standardId;
  standardForm.elements.text.value = row.dataset.text;
  standardForm.elements.isMandatory.checked = row.dataset.mandatory === 'true';
  $('#sf-filter').value = '';
  buildPicker(new Set(row.dataset.referenceIds.split(',').filter(Boolean)));
  updatePickerState();
  openDialog(standardDialog);
}

standardForm.addEventListener('change', updatePickerState);
standardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = standardForm.elements.text.value.trim();
  if (!text) return setFormError(standardDialog, 'The standard needs some text.');
  const body = {
    text,
    isMandatory: standardForm.elements.isMandatory.checked,
    referenceIds: $$('input[name="referenceIds"]:checked', standardForm).map((box) => box.value),
  };
  setSaveState('saving');
  try {
    const saved = await api(`/api/admin/standards/${standardForm.dataset.standardId}`, {
      method: 'PATCH',
      body,
    });
    closeDialog(standardDialog);
    await refresh('standards', 'references');
    setSaveState('saved');
    for (const warning of saved.warnings ?? []) toast(warning);
  } catch (err) {
    setSaveState('error');
    setFormError(standardDialog, err.details?.[0]?.message ?? err.message);
  }
});

/* ---------- Click actions ---------- */

const actions = {
  'add-section': async () => {
    const section = await change(() =>
      api(`/api/admin/types/${typeId}/sections`, { method: 'POST', body: { title: t.newSection } }),
    );
    if (!section?.id) return;
    // FR-ADM-14: select the new title for editing; its add box opens when the title is done.
    const input = $(`[data-section-id="${section.id}"] .section-title`);
    input.scrollIntoView({ block: 'center' });
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

buildJumpBar();

// FR-ADM-02: a new blank type opens with the add box of its first section ready.
if (window.location.hash === '#add') {
  history.replaceState(null, '', window.location.pathname);
  const first = $('[data-section-id]');
  if (first) openAddBox(first.dataset.sectionId);
}
