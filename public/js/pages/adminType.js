// Paper type editor (FR-ADM-10…21, docs/03 §3.7, D-36…D-38, D-45).
// Two modes (D-45): a published version is read-only (Edit opens the shared draft, the version
// picker shows older versions); the draft autosaves every change and has Cancel, Save and Publish.
// After each change the affected card is re-fetched as server-rendered HTML, so the markup lives
// only in the EJS partials. Adding / editing a standard happens on its own full page (D-38).
import { api, fetchHtml } from '../lib/api.js';
import { $, $$, debounce } from '../lib/dom.js';
import { openDialog, closeDialog, setupDialogs, setFormError } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { formatTimes } from '../lib/time.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const editor = $('#type-editor');
const typeId = editor.dataset.typeId;
const editable = editor.dataset.editable === 'true';
const t = JSON.parse(editor.dataset.strings);

setupDialogs();
setupReferenceViewer();

function showError(err) {
  toast(err.message, { error: true, ref: err.requestId });
}

/* ---------- One save indicator for every autosave (docs/03 §4) ---------- */

const saveState = $('.save-state');
let savedTimer;
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

// Saves still running, so Save / Publish can wait for them instead of leaving them behind.
const inFlight = new Set();

async function saving(call) {
  setSaveState('saving');
  const run = (async () => {
    try {
      const result = await call();
      setSaveState('saved');
      return result ?? true;
    } catch (err) {
      setSaveState('error');
      showError(err);
      return undefined;
    }
  })();
  inFlight.add(run);
  try {
    return await run;
  } finally {
    inFlight.delete(run);
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
  afterRender();
}

function change(call, cards = ['standards']) {
  return saving(async () => {
    const result = await call();
    await refresh(...cards);
    return result;
  });
}

async function deleteWithUndo(url, message, cards) {
  const ok = await change(() => api(url, { method: 'DELETE' }), cards);
  if (!ok) return;
  toast(message, {
    action: { label: t.undo, onClick: () => change(() => api(`${url}/restore`, { method: 'POST' }), cards) },
  });
}

/* ---------- Collapsible sections (remembered per paper type in this browser) ---------- */

const COLLAPSE_KEY = `psc.collapsed.${typeId}`;
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
const collapsed = loadCollapsed();
function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage blocked: the state lasts until reload.
  }
}

function applyCollapse() {
  for (const section of $$('.admin-section')) {
    const isCollapsed = collapsed.has(section.dataset.sectionId);
    section.classList.toggle('collapsed', isCollapsed);
    $('.collapse-btn', section)?.setAttribute('aria-expanded', String(!isCollapsed));
  }
  const all = $$('.admin-section').every((s) => collapsed.has(s.dataset.sectionId));
  $('[data-action="toggle-all"]').textContent = all ? t.expandAll : t.collapseAll;
}

function setCollapsed(sectionId, value) {
  if (value) collapsed.add(sectionId);
  else collapsed.delete(sectionId);
  saveCollapsed();
  applyCollapse();
}

/* ---------- "Sections" drop-down: a checkbox per section shows / hides it (like the paper page) ---------- */

// Hidden sections (by id) and 'references', remembered for this tab only.
const HIDDEN_KEY = `psc.type.hiddenSections.${typeId}`;
const hiddenSections = (() => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
})();
const sectionMenu = $('#sec-dd');
const sectionOptions = $('#sec-dd-options');

/** The things the drop-down lists, in page order: the sections, then the references used here (D-42). */
const filterTargets = () =>
  [...$$('.admin-section'), $('#references-card')]
    .filter(Boolean)
    .map((el) => ({ el, key: el.dataset.sectionId ?? 'references' }));

/** Show / hide one or more targets, remember it and redraw. */
function setShown(keys, shown) {
  for (const key of [].concat(keys)) {
    if (shown) hiddenSections.delete(key);
    else hiddenSections.add(key);
  }
  try {
    sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSections]));
  } catch {
    // Storage blocked: the state lasts until reload.
  }
  applyShown();
}

function applyShown() {
  const targets = filterTargets();
  for (const { el, key } of targets) {
    el.hidden = hiddenSections.has(key);
    const box = $(`[data-sec-toggle="${key}"]`, sectionOptions);
    if (box) box.checked = !el.hidden;
  }
  const shownCount = targets.filter((x) => !x.el.hidden).length;
  const all = $('[data-sec-toggle="all"]', sectionMenu);
  all.checked = shownCount === targets.length;
  all.indeterminate = shownCount > 0 && shownCount < targets.length;
  $('#sec-dd-label').textContent = all.checked
    ? t.sectionsAll
    : t.sectionsSome.replace('{shown}', shownCount).replace('{total}', targets.length);
}

/** One checkbox row per section (rebuilt after each change, since the cards are re-rendered). */
function buildSectionMenu() {
  sectionOptions.replaceChildren(
    ...filterTargets().map(({ el, key }) => {
      const row = Object.assign(document.createElement('label'), { className: 'sec-opt' });
      row.title = el.dataset.jumpLabel;
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'input' });
      box.dataset.secToggle = key;
      row.append(
        box,
        Object.assign(document.createElement('span'), {
          className: 'chip-key',
          textContent: el.dataset.jumpKey ?? '§',
        }),
        Object.assign(document.createElement('span'), {
          className: 'sec-opt-name',
          textContent: el.dataset.jumpLabel,
        }),
        Object.assign(document.createElement('span'), {
          className: 'chip-count',
          textContent: el.dataset.jumpCount,
        }),
      );
      return row;
    }),
  );
  applyShown();
}

sectionMenu.addEventListener('change', (event) => {
  const box = event.target.closest('[data-sec-toggle]');
  if (!box) return;
  const key = box.dataset.secToggle;
  setShown(key === 'all' ? filterTargets().map((x) => x.key) : key, box.checked);
});
// Close the drop-down on Escape or a click outside it.
document.addEventListener('click', (event) => {
  if (sectionMenu.open && !sectionMenu.contains(event.target)) sectionMenu.open = false;
});
sectionMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !sectionMenu.open) return;
  sectionMenu.open = false;
  $('summary', sectionMenu).focus();
});

function afterRender() {
  applyCollapse();
  buildSectionMenu();
  formatTimes(editor);
  for (const item of $$('[data-drag]')) item.draggable = false; // only while holding the grip
}

/* ---------- Name and description: autosave into the draft (FR-ADM-10) ---------- */

const dirtyFields = new Set(); // typed but not sent yet (the debounce is still waiting)
function saveField(input) {
  dirtyFields.delete(input);
  const value = input.value.trim();
  if (input.dataset.field === 'name' && !value) return undefined;
  return saving(async () => {
    await api(`/api/admin/types/${typeId}`, { method: 'PATCH', body: { [input.dataset.field]: value } });
    if (input.dataset.field === 'name') $('.type-crumb').textContent = value;
  });
}
const saveTypeField = debounce(saveField, 600);
for (const input of $$('[data-field]', editor)) {
  input.addEventListener('input', () => {
    dirtyFields.add(input);
    saveTypeField(input);
  });
}
$('[data-field="description"]')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  }
});

/** Send what is still waiting and wait for every save, before Save / Publish leave the page. */
async function flushSaves() {
  document.activeElement?.blur?.(); // a section title saves on change (blur)
  await Promise.all([...dirtyFields].map(saveField));
  await Promise.all([...inFlight]);
  return saveState?.dataset.state !== 'error';
}

/* ---------- Section titles: save on change (blur / Enter) ---------- */

editor.addEventListener('change', (event) => {
  const input = event.target.closest('.section-title');
  if (!input) return;
  const section = input.closest('[data-section-id]');
  const title = input.value.trim();
  if (!title) {
    input.value = input.defaultValue;
    return;
  }
  saving(async () => {
    await api(`/api/admin/sections/${section.dataset.sectionId}`, { method: 'PATCH', body: { title } });
    input.defaultValue = title;
    section.dataset.jumpLabel = title;
    buildSectionMenu();
  });
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.section-title')) event.target.blur();
});

/* ---------- Drag and drop (grip): sections, and standards within or across sections ---------- */

let dragging = null; // { kind: 'section'|'standard', el }

editor.addEventListener('pointerdown', (event) => {
  const grip = event.target.closest('.grip');
  if (grip && editable) grip.closest('[data-drag]').draggable = true;
});

editor.addEventListener('dragstart', (event) => {
  const item = event.target.closest('[data-drag]');
  if (!item?.draggable) return;
  const el = item.dataset.drag === 'section' ? item.closest('.admin-section') : item;
  dragging = { kind: item.dataset.drag, el };
  el.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', el.dataset.sectionId ?? el.dataset.standardId);
});

function clearMarks() {
  for (const el of $$('.drop-before, .drop-after, .drop-into'))
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
}

/** Where a drop would go: the element to mark and whether it is before / after it. */
function dropTarget(event) {
  if (!dragging) return null;
  if (dragging.kind === 'section') {
    const section = event.target.closest('.admin-section');
    if (!section || section === dragging.el) return null;
    const box = section.getBoundingClientRect();
    return { el: section, after: event.clientY > box.top + box.height / 2 };
  }
  const row = event.target.closest('.std-row');
  if (row && row !== dragging.el) {
    const box = row.getBoundingClientRect();
    return { el: row, after: event.clientY > box.top + box.height / 2 };
  }
  const body = event.target.closest('.admin-section');
  return body ? { el: $('[data-standards]', body), into: true } : null;
}

editor.addEventListener('dragover', (event) => {
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  clearMarks();
  target.el.classList.add(target.into ? 'drop-into' : target.after ? 'drop-after' : 'drop-before');
});

editor.addEventListener('dragleave', (event) => {
  if (!editor.contains(event.relatedTarget)) clearMarks();
});

editor.addEventListener('drop', async (event) => {
  const target = dropTarget(event);
  clearMarks();
  if (!target || !dragging) return;
  event.preventDefault();
  const { kind, el } = dragging;
  if (kind === 'section') {
    const ids = $$('.admin-section')
      .map((s) => s.dataset.sectionId)
      .filter((id) => id !== el.dataset.sectionId);
    const at = ids.indexOf(target.el.dataset.sectionId) + (target.after ? 1 : 0);
    ids.splice(at, 0, el.dataset.sectionId);
    await change(() =>
      api(`/api/admin/types/${typeId}/sections/order`, { method: 'POST', body: { sectionIds: ids } }),
    );
    return;
  }
  const section = target.el.closest('.admin-section');
  const others = $$('.std-row', section).filter((row) => row !== el);
  const index = target.into ? others.length : others.indexOf(target.el) + (target.after ? 1 : 0);
  await change(() =>
    api(`/api/admin/standards/${el.dataset.standardId}/move`, {
      method: 'POST',
      body: { sectionId: section.dataset.sectionId, index },
    }),
  );
});

editor.addEventListener('dragend', () => {
  dragging?.el.classList.remove('dragging');
  dragging = null;
  clearMarks();
  for (const item of $$('[data-drag]')) item.draggable = false;
});

/* ---------- Import standards from another paper type (D-38) ---------- */

// The import dialog is only on the page while editing the draft.
const importDialog = $('#import-dialog');
const importForm = $('#import-form');
const tree = $('#im-tree');
if (importDialog) setupImport();

function setupImport() {
  function updateImportCount() {
    const n = $$('input[name="std"]:checked', tree).length;
    $('.selected-count', importDialog).textContent = t.selected.replace('{n}', n);
    for (const group of $$('.tree-group', tree)) {
      const boxes = $$('input[name="std"]', group);
      const checked = boxes.filter((b) => b.checked).length;
      const all = $('input[name="section"]', group);
      all.checked = checked === boxes.length && checked > 0;
      all.indeterminate = checked > 0 && checked < boxes.length;
    }
  }

  $('#im-type').addEventListener('change', async (event) => {
    const sourceId = event.target.value;
    $('#im-tree-field').hidden = !sourceId;
    $('#im-target').hidden = !sourceId;
    tree.replaceChildren();
    if (!sourceId) return;
    try {
      const sections = await api(`/api/admin/types/${sourceId}/tree`);
      tree.replaceChildren(
        ...sections.map((section, i) => {
          const group = Object.assign(document.createElement('div'), { className: 'tree-group' });
          const head = document.createElement('label');
          head.className = 'tree-section';
          head.append(
            Object.assign(document.createElement('input'), {
              type: 'checkbox',
              className: 'input',
              name: 'section',
            }),
            Object.assign(document.createElement('b'), {
              textContent: `${String.fromCharCode(65 + i)}. ${section.title}`,
            }),
          );
          group.append(head);
          for (const std of section.standards) {
            const row = document.createElement('label');
            row.append(
              Object.assign(document.createElement('input'), {
                type: 'checkbox',
                className: 'input',
                name: 'std',
                value: std.id,
              }),
              Object.assign(document.createElement('span'), { textContent: `#${std.number} ${std.title}` }),
            );
            group.append(row);
          }
          return group;
        }),
      );
      updateImportCount();
    } catch (err) {
      showError(err);
    }
  });

  tree.addEventListener('change', (event) => {
    if (event.target.name === 'section') {
      for (const box of $$('input[name="std"]', event.target.closest('.tree-group')))
        box.checked = event.target.checked;
    }
    updateImportCount();
  });
  $('#im-section').addEventListener('change', () => {
    importForm.querySelector('input[name="mode"][value="into"]').checked = true;
  });

  importForm.addEventListener('submit', onImport);
}

async function onImport(event) {
  event.preventDefault();
  const standardIds = $$('input[name="std"]:checked', tree).map((b) => b.value);
  if (!standardIds.length) return setFormError(importDialog, t.importNone);
  const mode = importForm.elements.mode.value;
  const body = { standardIds, mode, ...(mode === 'into' && { targetSectionId: $('#im-section').value }) };
  const submit = importForm.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const result = await change(
      () => api(`/api/admin/types/${typeId}/import`, { method: 'POST', body }),
      ['standards', 'references'],
    );
    if (result) {
      closeDialog(importDialog);
      const imported = t.importResult.replace('{n}', result.imported);
      const skipped = result.skipped.length
        ? ` ${t.importSkipped.replace('{skipped}', result.skipped.length)} ${result.skipped.join(', ')}`
        : '';
      toast(imported + skipped); // warn and skip duplicates (D-38)
    }
  } finally {
    submit.disabled = false;
  }
}

/* ---------- Click actions ---------- */

const actions = {
  'toggle-section': (_b, section) =>
    setCollapsed(section.dataset.sectionId, !collapsed.has(section.dataset.sectionId)),
  'toggle-all': () => {
    const ids = $$('.admin-section').map((s) => s.dataset.sectionId);
    const collapseAll = !ids.every((id) => collapsed.has(id));
    for (const id of ids) {
      if (collapseAll) collapsed.add(id);
      else collapsed.delete(id);
    }
    saveCollapsed();
    applyCollapse();
  },
  'add-section': async () => {
    const section = await change(() =>
      api(`/api/admin/types/${typeId}/sections`, { method: 'POST', body: { title: t.newSection } }),
    );
    if (!section?.id) return;
    const input = $(`[data-section-id="${section.id}"] .section-title`);
    input.scrollIntoView({ block: 'center' });
    input.focus();
    input.select();
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
  'toggle-mandatory': (_b, _s, row) =>
    change(() =>
      api(`/api/admin/standards/${row.dataset.standardId}`, {
        method: 'PATCH',
        body: { isMandatory: row.dataset.mandatory !== 'true' },
      }),
    ),
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
  'view-reference': (button, _s, row) =>
    openReferenceViewer(button.dataset.referenceId ?? row.dataset.referenceId),
  'open-import': () => {
    importForm.reset();
    $('#im-tree-field').hidden = true;
    $('#im-target').hidden = true;
    tree.replaceChildren();
    setFormError(importDialog, '');
    openDialog(importDialog);
  },
  // ---- Versions (D-45) ----
  'start-draft': async (button) => {
    button.disabled = true;
    try {
      const draft = await api(`/api/admin/types/${typeId}/draft`, { method: 'POST' });
      window.location.assign(draft.url);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  },
  'save-draft': async (button) => {
    // Everything is already autosaved: Save waits for the last saves and leaves edit mode. The
    // draft stays open (for every admin) until it is published or cancelled.
    button.disabled = true;
    if (await flushSaves()) window.location.assign(`/admin/types/${typeId}`);
    else button.disabled = false;
  },
  'cancel-draft': async (button) => {
    if (!window.confirm(t.confirmCancel)) return;
    button.disabled = true;
    await Promise.all([...inFlight]);
    try {
      const result = await api(`/api/admin/types/${typeId}/draft`, { method: 'DELETE' });
      window.location.assign(result.url);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  },
  publish: async (button) => {
    if (!(await flushSaves())) return;
    if (!window.confirm(t.confirmPublish)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/types/${typeId}/publish`, { method: 'POST' });
      window.location.assign(result.url);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  },
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

// The version picker (read-only mode): open that version.
$('#version-select')?.addEventListener('change', (event) => {
  const value = event.target.value;
  window.location.assign(
    value === 'draft' ? `/admin/types/${typeId}/draft` : `/admin/types/${typeId}?version=${value}`,
  );
});

editor.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || !actions[button.dataset.action] || button.tagName === 'SELECT') return;
  const section = button.closest('[data-section-id]');
  const row = button.closest('[data-standard-id], [data-reference-id]');
  actions[button.dataset.action](button, section, row);
});

afterRender();

// Coming back from the standard form (#std-<id>): open its section and show it.
const target =
  window.location.hash.startsWith('#std-') && document.getElementById(window.location.hash.slice(1));
if (target) {
  const sectionId = target.closest('.admin-section').dataset.sectionId;
  if (hiddenSections.has(sectionId)) setShown(sectionId, true); // a hidden section comes back
  setCollapsed(sectionId, false);
  target.classList.add('flash');
  target.scrollIntoView({ block: 'center' });
}
