// Full-screen add / edit of a library reference (D-37, D-39): About · File · Reference links, with a
// live summary on the side (how architects see it, what is still missing).
import { api } from '../lib/api.js';
import { $ } from '../lib/dom.js';
import { setupDialogs } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { setupReferenceFields } from '../lib/referenceForm.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';

const page = $('#reference-page');
const form = $('#reference-form');
const referenceId = page.dataset.referenceId;
const t = JSON.parse(page.dataset.strings);
const fields = setupReferenceFields(form, 'rf', JSON.parse(form.dataset.strings));
const saveState = $('.form-bar .save-state');
const formError = $('.form-bar .form-error');

setupDialogs();
setupReferenceViewer();

let dirty = false;
form.addEventListener('input', () => {
  dirty = true;
  showSaveState();
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function showSaveState() {
  saveState.dataset.state = dirty ? 'saving' : 'idle';
  saveState.textContent = dirty ? t.unsaved : '';
}

page.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="view-reference"]');
  if (button) openReferenceViewer(button.dataset.referenceId);
});

// --- Live summary --------------------------------------------------------------------------------

/** The chip and hover card an architect sees next to a standard (FR-REF-01). */
function renderPreview(s) {
  const title = s.title || t.untitled;
  $('#pv-icon').textContent = t.icons[s.type] ?? '';
  $('#pv-chip').textContent = `${s.type} · ${title}`;
  $('#pv-title').textContent = `${t.icons[s.type] ?? ''} ${title}`;
  $('#pv-note').textContent = s.note || t.noDescription;
  // The file opens in the viewer; the first link is the main button, the others are smaller links.
  const file = Object.assign(document.createElement('span'), { className: 'seen-link', textContent: t.viewFile });
  const links = s.links.map((link, i) =>
    Object.assign(document.createElement('a'), {
      className: i === 0 ? 'seen-link main' : 'seen-link',
      textContent: `${link.label} ↗`,
      href: link.url,
      target: '_blank',
      rel: 'noopener noreferrer',
    }),
  );
  $('#pv-links').replaceChildren(...(s.hasFile ? [file] : []), ...links);
}

/** "Ready to save": required items, then optional ones. */
function renderChecklist(s) {
  const items = [
    { done: Boolean(s.title), label: t.checkTitle },
    { done: s.hasFile, label: t.checkFile },
    { done: Boolean(s.note), label: t.checkDescription, optional: true },
    s.linksOk
      ? { done: s.links.length > 0, label: s.links.length ? `${t.checkLinks} (${s.links.length})` : t.checkLinks, optional: true }
      : { done: false, label: t.fixLinks, problem: true },
  ];
  $('#ready-list').replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = item.done ? 'done' : item.problem ? 'problem' : item.optional ? 'optional' : '';
      const dot = document.createElement('span');
      dot.className = 'ready-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = item.done ? '✓' : item.problem ? '!' : '';
      const label = document.createElement('span');
      label.textContent = item.optional && !item.done ? `${item.label} · ${t.optional}` : item.label;
      li.append(dot, label);
      return li;
    }),
  );
}

function renderSummary() {
  const s = fields.snapshot();
  renderPreview(s);
  renderChecklist(s);
}
form.addEventListener('change', renderSummary); // the type cards
fields.onChange(renderSummary);
renderSummary();

// --- Save ----------------------------------------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.hidden = true;
  if (!fields.validate()) {
    formError.textContent = t.fixFields;
    formError.hidden = false;
    renderSummary();
    return;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const saved = await api(referenceId ? `/api/admin/references/${referenceId}` : '/api/admin/references', {
      method: referenceId ? 'PATCH' : 'POST',
      body: fields.toFormData(),
    });
    dirty = false;
    showSaveState();
    if (page.dataset.forStandard === 'true') {
      // D-38: the standard form that opened this tab ticks the new reference (same-origin message).
      const channel = new BroadcastChannel('psc-references');
      channel.postMessage({ type: 'reference-created', reference: saved });
      channel.close();
      toast(t.linkedClose);
      window.close(); // works for a tab opened by the standard form; otherwise we stay and go on below
      setTimeout(() => window.location.assign(saved.url), 1500);
      return;
    }
    toast(t.saved);
    // Reload so "Last edited by" and the file details show the saved state.
    window.location.assign(referenceId ? window.location.pathname : saved.url);
  } catch (err) {
    const placed = fields.showServerErrors(err.details);
    formError.textContent = placed ? t.fixFields : (err.details?.[0]?.message ?? err.message);
    formError.hidden = false;
    submit.disabled = false;
  }
});
