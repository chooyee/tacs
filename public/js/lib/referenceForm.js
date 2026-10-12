// Behaviour of the reference fields (views/partials/admin/referenceFields.ejs, D-37, D-39): the file
// card + drop zone, the description editor and the ordered list of reference links.
// User text is only ever set with .value / .textContent, never as HTML (NFR-SEC-05).
import { $, $$ } from './dom.js';
import { createRichEditor } from './richEditor.js';
import { toast } from './toast.js';

const MAX_FILE_MB = 15;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const HTTPS = /^https:\/\/[^\s]+$/;

/** Replace {name}-style placeholders in a string from the server. */
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_m, key) => values[key] ?? '');

/**
 * Wire the fields inside `form` (ids prefixed with `prefix`).
 * @param {HTMLFormElement} form
 * @param {string} prefix  'rf'
 * @param {object} t  strings from the form's data-strings
 * @returns {{toFormData: () => FormData, validate: (isNew: boolean) => boolean,
 *   showServerErrors: (details: Array<{field: string, message: string}>) => boolean,
 *   snapshot: () => object, onChange: (fn: Function) => void}}
 */
export function setupReferenceFields(form, prefix, t) {
  const listeners = [];
  const changed = () => listeners.forEach((fn) => fn());
  let tried = false; // after the first Save, problems show while typing

  // --- Title -------------------------------------------------------------------------------------
  const title = $(`#${prefix}-title`, form);
  const titleCount = $(`#${prefix}-title-count`, form);
  const showTitleCount = () => {
    titleCount.textContent = `${title.value.length} / ${title.maxLength}`;
  };
  title.addEventListener('input', () => {
    showTitleCount();
    if (tried) checkTitle();
    changed();
  });
  showTitleCount();

  function checkTitle() {
    const ok = Boolean(title.value.trim());
    setFieldError(title.closest('.field'), ok ? '' : t.titleRequired);
    return ok;
  }

  // --- Description (rich text; its plain text is the hover note) --------------------------------
  const guidance = createRichEditor($(`#${prefix}-guidance`, form));
  const guidanceCount = $(`#${prefix}-guidance-count`, form);
  const showWordCount = () => {
    const text = guidance.getText();
    const n = text ? text.split(/\s+/).length : 0;
    guidanceCount.textContent = fill(n === 1 ? t.wordsOne : t.words, { n });
  };
  guidance.onChange(() => {
    showWordCount();
    form.dispatchEvent(new Event('input', { bubbles: true })); // counts as an unsaved change
    changed();
  });
  showWordCount();

  // --- File --------------------------------------------------------------------------------------
  const fileInput = $(`#${prefix}-file`, form);
  const fileField = fileInput.closest('.field');
  const dropzone = fileInput.closest('.dropzone');
  const card = $(`#${prefix}-file-card`, form);
  const hasSavedFile = !card.hidden; // editing: the current file is shown until a new one is chosen
  const saved = {
    ext: $(`#${prefix}-file-ext`, form).textContent,
    name: $(`#${prefix}-file-name`, form).textContent,
    meta: $(`#${prefix}-file-meta`, form).textContent,
  };
  let chosen = null; // the newly chosen File, if any

  function showFile() {
    const preview = $(`#${prefix}-file-preview`, form);
    if (chosen) {
      $(`#${prefix}-file-ext`, form).textContent = (chosen.name.split('.').pop() || '').toUpperCase();
      $(`#${prefix}-file-name`, form).textContent = chosen.name;
      $(`#${prefix}-file-meta`, form).textContent = `${(chosen.size / 1024 / 1024).toFixed(1)} MB`;
    } else {
      $(`#${prefix}-file-ext`, form).textContent = saved.ext;
      $(`#${prefix}-file-name`, form).textContent = saved.name;
      $(`#${prefix}-file-meta`, form).textContent = saved.meta;
    }
    card.hidden = !chosen && !hasSavedFile;
    $(`#${prefix}-file-new`, form).hidden = !chosen;
    $(`#${prefix}-file-clear`, form).hidden = !chosen;
    if (preview) preview.hidden = Boolean(chosen); // the preview shows the saved file only
    $('.file-name', dropzone).textContent = card.hidden ? t.chooseFile : t.replaceFile;
    dropzone.classList.toggle('compact', !card.hidden);
  }

  function takeFile(file) {
    if (!file) return;
    const mb = file.size / 1024 / 1024;
    if (!FILE_TYPES.includes(file.type)) {
      setFieldError(fileField, fill(t.fileTypeError, { name: file.name }));
      return;
    }
    if (mb > MAX_FILE_MB) {
      setFieldError(fileField, fill(t.fileSizeError, { name: file.name, mb: mb.toFixed(1) }));
      return;
    }
    chosen = file;
    setFieldError(fileField, '');
    showFile();
    changed();
  }

  fileInput.addEventListener('change', () => {
    takeFile(fileInput.files[0]);
    fileInput.value = ''; // the File is kept in `chosen`; clearing lets the same file be picked again
  });
  for (const type of ['dragenter', 'dragover'])
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('over');
    });
  for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    takeFile(event.dataTransfer.files[0]);
    form.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $(`#${prefix}-file-clear`, form).addEventListener('click', () => {
    chosen = null;
    showFile();
    if (tried) checkFile();
    changed();
  });

  function checkFile() {
    const ok = Boolean(chosen) || hasSavedFile;
    if (!ok) setFieldError(fileField, t.fileRequired);
    else if ($('.field-error', fileField).textContent === t.fileRequired) setFieldError(fileField, '');
    return ok;
  }
  showFile();

  // --- Reference links ---------------------------------------------------------------------------
  const list = $(`#${prefix}-links`, form);
  const template = $(`#${prefix}-link-row`, form);
  const addButton = $(`#${prefix}-add-link`, form);
  const max = Number(list.dataset.max);
  let links = JSON.parse(list.dataset.links || '[]').map((l) => ({ label: l.label, url: l.url }));
  let dragFrom = null;

  /** '' when the link is fine; an empty row (both fields blank) is fine too, it is skipped on save. */
  function linkProblems(link) {
    const label = link.label.trim();
    const url = link.url.trim();
    if (!label && !url) return {};
    return {
      label: label ? '' : t.labelRequired,
      url: !url ? t.urlRequired : HTTPS.test(url) ? '' : t.urlInvalid,
    };
  }

  function renderLinks(focus) {
    list.replaceChildren(
      ...links.map((link, i) => {
        const row = template.content.firstElementChild.cloneNode(true);
        row.dataset.index = i;
        $('.link-number', row).textContent = i + 1;
        $('.main-tag', row).hidden = i !== 0;
        for (const part of ['label', 'url']) {
          const input = $(`[data-key="${part}"]`, row);
          input.id = `${prefix}-link-${part}-${i}`;
          input.value = link[part];
          $(`[data-part="${part}"] label`, row).htmlFor = input.id;
        }
        const n = i + 1;
        const up = $('[data-action="link-up"]', row);
        const down = $('[data-action="link-down"]', row);
        up.disabled = i === 0;
        down.disabled = i === links.length - 1;
        up.setAttribute('aria-label', `${t.moveUp}: ${n}`);
        down.setAttribute('aria-label', `${t.moveDown}: ${n}`);
        $('[data-action="link-remove"]', row).setAttribute('aria-label', `${t.remove}: ${n}`);
        const open = $('[data-action="link-open"]', row);
        open.setAttribute('aria-label', `${t.open}: ${n}`);
        open.title = t.open;
        showLinkState(row, link);
        return row;
      }),
    );
    $(`#${prefix}-links-empty`, form).hidden = links.length > 0;
    const count = $(`#${prefix}-links-count`, form);
    count.hidden = !links.length;
    count.textContent = `${links.length} / ${max}`;
    addButton.disabled = links.length >= max;
    if (focus) $(focus, list)?.focus();
  }

  /** Errors (only after a blur or Save) and whether "open" is clickable. */
  function showLinkState(row, link) {
    const problems = linkProblems(link);
    for (const part of ['label', 'url']) {
      setFieldError($(`[data-part="${part}"]`, row), tried || link.touched ? (problems[part] ?? '') : '');
    }
    const open = $('[data-action="link-open"]', row);
    const url = link.url.trim();
    if (HTTPS.test(url)) {
      open.href = url;
      open.removeAttribute('aria-disabled');
    } else {
      open.removeAttribute('href');
      open.setAttribute('aria-disabled', 'true');
    }
  }

  const rowIndex = (el) => Number(el.closest('.link-row').dataset.index);

  addButton.addEventListener('click', () => {
    if (links.length >= max) return;
    links.push({ label: '', url: '' });
    renderLinks(`#${prefix}-link-label-${links.length - 1}`);
    form.dispatchEvent(new Event('input', { bubbles: true }));
    changed();
  });

  list.addEventListener('input', (event) => {
    const key = event.target.dataset.key;
    if (!key) return;
    const i = rowIndex(event.target);
    links[i][key] = event.target.value;
    showLinkState(event.target.closest('.link-row'), links[i]);
    changed();
  });

  // Show a row's errors once the user leaves it, not while they are still typing in it.
  list.addEventListener('focusout', (event) => {
    const row = event.target.closest('.link-row');
    if (!row || row.contains(event.relatedTarget)) return;
    const link = links[Number(row.dataset.index)];
    if (!link) return;
    link.touched = true;
    showLinkState(row, link);
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const i = rowIndex(button);
    const action = button.dataset.action;
    if (action === 'link-open') {
      if (!button.hasAttribute('href')) event.preventDefault();
      return;
    }
    if (action === 'link-remove') {
      const [removed] = links.splice(i, 1);
      renderLinks();
      toast(t.removed, {
        action: {
          label: t.undo,
          onClick: () => {
            links.splice(i, 0, removed);
            renderLinks();
            changed();
          },
        },
      });
    } else {
      const to = action === 'link-up' ? i - 1 : i + 1;
      move(i, to);
      // Keep focus on the same button of the moved row (or its twin when that one is now disabled).
      const row = $(`[data-index="${to}"]`, list);
      const same = $(`[data-action="${action}"]`, row);
      (same.disabled ? $(`[data-action="${action === 'link-up' ? 'link-down' : 'link-up'}"]`, row) : same).focus();
    }
    form.dispatchEvent(new Event('input', { bubbles: true }));
    changed();
  });

  function move(from, to) {
    if (to < 0 || to >= links.length || from === to) return;
    const [link] = links.splice(from, 1);
    links.splice(to, 0, link);
    renderLinks();
  }

  // Drag and drop to reorder (↑ ↓ do the same for keyboard and touch users).
  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.link-row');
    if (!row || event.target.closest('input')) return;
    dragFrom = Number(row.dataset.index);
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(dragFrom));
  });
  list.addEventListener('dragover', (event) => {
    if (dragFrom === null) return;
    const row = event.target.closest('.link-row');
    if (!row) return;
    event.preventDefault();
    for (const r of $$('.link-row', list)) r.classList.toggle('drop-target', r === row && Number(r.dataset.index) !== dragFrom);
  });
  list.addEventListener('drop', (event) => {
    const row = event.target.closest('.link-row');
    if (dragFrom === null || !row) return;
    event.preventDefault();
    move(dragFrom, Number(row.dataset.index));
    dragFrom = null;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    changed();
  });
  list.addEventListener('dragend', () => {
    dragFrom = null;
    for (const r of $$('.link-row', list)) r.classList.remove('dragging', 'drop-target');
  });
  renderLinks();

  /** Links that will be saved: filled rows only, trimmed. */
  const linksToSave = () =>
    links
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.label || l.url);

  const linksOk = () => links.every((l) => !Object.values(linkProblems(l)).some(Boolean));

  return {
    /** The multipart body: type, title, guidance, links (JSON) and the file when one was chosen. */
    toFormData() {
      const data = new FormData();
      data.set('type', form.elements.type.value);
      data.set('title', title.value.trim());
      data.set('guidance', guidance.getHtml());
      data.set('links', JSON.stringify(linksToSave()));
      if (chosen) data.set('file', chosen);
      return data;
    },

    /** Show every problem; true when the form can be sent. Focuses the first problem. */
    validate() {
      tried = true;
      const ok = [checkTitle(), checkFile(), linksOk()].every(Boolean);
      renderLinks();
      if (!ok) $('.field.invalid input, .field.invalid .input', form)?.focus();
      return ok;
    },

    /** Put server-side field errors (e.g. "links.1.url") next to their fields; true if any was shown. */
    showServerErrors(details = []) {
      let shown = false;
      for (const { field, message } of details) {
        const [name, index, part] = field.split('.');
        let target = null;
        if (name === 'title') target = title.closest('.field');
        else if (name === 'file') target = fileField;
        else if (name === 'links' && part) target = $(`[data-index="${index}"] [data-part="${part}"]`, list);
        if (target) {
          setFieldError(target, message);
          shown = true;
        }
      }
      return shown;
    },

    /** What the live summary shows. */
    snapshot() {
      return {
        type: form.elements.type.value,
        title: title.value.trim(),
        note: guidance.getText(),
        hasFile: Boolean(chosen) || hasSavedFile,
        links: linksToSave().filter((l) => l.label && HTTPS.test(l.url)),
        linksOk: linksOk(),
      };
    },

    onChange(fn) {
      listeners.push(fn);
    },
  };
}

/** Mark a .field invalid with a message under it, or clear it (message = ''). */
function setFieldError(field, message) {
  if (!field) return;
  const error = $(':scope > .field-error', field);
  field.classList.toggle('invalid', Boolean(message));
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  $('input, .input', field)?.setAttribute('aria-invalid', message ? 'true' : 'false');
}
