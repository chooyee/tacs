// Reference viewer dialog (FR-REF-02, docs/03 §3.5): preview (pdf.js or image), type, note, the file
// (open / download), "Used for" standards, the links (D-39: the first is the main button) and
// "Last edited … by …"; it can be maximised (D-44). Shared by the admin editor and the paper page.
import { api } from './api.js';
import { $, debounce } from './dom.js';
import { openDialog } from './dialog.js';
import { toast } from './toast.js';
import { timeAgo } from './time.js';

const PREVIEW_WIDTH = 520; // normal size; maximised, the PDF page fills the preview's width
const state = { url: null, page: 1, pages: 1, maximized: false, drawnWidth: 0 };
const exactTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function dialogEl() {
  return $('#reference-viewer');
}

function strings() {
  return JSON.parse(dialogEl().dataset.strings);
}

function status(text) {
  const el = $('#rv-status');
  el.textContent = text;
  el.hidden = !text;
}

async function showPdfPage() {
  const s = strings();
  const canvas = $('#rv-canvas');
  try {
    // Loaded on first use only: pages without a PDF preview never download pdf.js.
    const { renderPage } = await import('./pdfView.js');
    state.drawnWidth = previewWidth();
    const { numPages } = await renderPage(canvas, state.url, state.page, state.drawnWidth);
    state.pages = numPages;
    canvas.hidden = false;
    status('');
    $('#rv-pager').hidden = numPages < 2;
    $('#rv-page').textContent = s.pageOf.replace('{n}', state.page).replace('{of}', numPages);
    $('[data-action="rv-prev"]').disabled = state.page <= 1;
    $('[data-action="rv-next"]').disabled = state.page >= numPages;
  } catch {
    status(s.failed);
  }
}

/** How wide to draw the PDF page: the preview box's inner width when maximised. */
function previewWidth() {
  if (!state.maximized) return PREVIEW_WIDTH;
  const box = $('#rv-preview');
  const padding = parseFloat(getComputedStyle(box).paddingLeft) * 2;
  return Math.max(PREVIEW_WIDTH, box.clientWidth - padding);
}

/** Switch between the normal dialog and one that fills the window, and redraw the PDF to fit. */
function setMaximized(value) {
  const s = strings();
  state.maximized = value;
  $('.dlg', dialogEl()).classList.toggle('max', value);
  const button = $('[data-action="rv-maximize"]');
  button.setAttribute('aria-pressed', String(value));
  button.setAttribute('aria-label', value ? s.restore : s.maximize);
  button.title = value ? s.restore : s.maximize;
  $('[data-rv-icon="maximize"]').hidden = value;
  $('[data-rv-icon="minimize"]').hidden = !value;
  redrawIfResized();
}

/** Redraw the PDF page when the space for it changed (maximise / restore, window resize). */
const redrawIfResized = debounce(() => {
  if (!dialogEl().open || !state.url || $('#rv-canvas').hidden) return;
  if (Math.abs(previewWidth() - state.drawnWidth) > 8) showPdfPage();
}, 150);

/** "2.4 MB" / "830 KB" */
function fileSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The file line: name links to the file (new tab), size, and a download button. */
function showFile(ref) {
  const link = $('#rv-file-link');
  link.href = ref.fileUrl;
  $('#rv-file-name').textContent = ref.fileName || ref.title;
  $('#rv-file-size').textContent = fileSize(ref.sizeBytes);
  const download = $('#rv-file-download');
  download.href = ref.fileUrl;
  download.setAttribute('download', ref.fileName || '');
}

/** "Last edited 2 hours ago by Dana Tan", with the exact local time as a tooltip. */
function showEdited(ref) {
  const s = strings();
  const el = $('#rv-edited');
  const date = ref.updatedAt ? new Date(ref.updatedAt) : null;
  el.hidden = !date || Number.isNaN(date.getTime());
  if (el.hidden) return el.replaceChildren();
  const time = Object.assign(document.createElement('time'), {
    dateTime: date.toISOString(),
    textContent: timeAgo(date),
    title: exactTime.format(date),
  });
  const by = ref.updatedBy ? ` ${s.editedBy.replace('{name}', ref.updatedBy)}` : '';
  el.replaceChildren(`${s.editedLabel} `, time, by);
}

/**
 * Open the viewer for one reference.
 * @param {string} referenceId
 */
export async function openReferenceViewer(referenceId) {
  const dialog = dialogEl();
  const s = strings();
  let ref;
  try {
    ref = await api(`/api/references/${referenceId}`);
  } catch (err) {
    toast(err.message, { error: true, ref: err.requestId });
    return;
  }

  $('#rv-title').textContent = ref.title;
  $('#rv-type').textContent = `${s.icons[ref.type] ?? ''} ${ref.type}`;
  $('#rv-note').textContent = ref.note ?? '';
  showLinks(ref.links ?? []);
  showFile(ref);
  showEdited(ref);

  const used = $('#rv-used');
  used.replaceChildren(
    ...(ref.usedFor.length
      ? ref.usedFor.map((std) => {
          const li = document.createElement('li');
          li.textContent = `${std.paperTypeName} · #${std.number} ${std.title}`;
          return li;
        })
      : [
          Object.assign(document.createElement('li'), {
            textContent: s.noStandards,
            className: 'text-muted-foreground',
          }),
        ]),
  );

  const canvas = $('#rv-canvas');
  const image = $('#rv-image');
  canvas.hidden = true;
  image.hidden = true;
  $('#rv-pager').hidden = true;
  openDialog(dialog);

  if (ref.mimeType === 'application/pdf') {
    Object.assign(state, { url: ref.fileUrl, page: 1, pages: ref.pageCount || 1 });
    status(s.loading);
    await showPdfPage();
  } else {
    status('');
    image.src = ref.fileUrl;
    image.alt = ref.title;
    image.hidden = false;
  }
}

/** The reference's links; URLs are validated server-side (https:// only). Text via textContent. */
function showLinks(links) {
  const template = $('#rv-link-tpl');
  $('#rv-links-box').hidden = !links.length;
  $('#rv-links').replaceChildren(
    ...links.map((link, i) => {
      const a = template.content.firstElementChild.cloneNode(true);
      a.href = link.url;
      a.className = i === 0 ? 'btn' : 'link-btn';
      if (i === 0) a.dataset.variant = 'outline';
      a.querySelector('span').textContent = link.label;
      return a;
    }),
  );
}

/** Wire the pager and maximise buttons once per page. */
export function setupReferenceViewer() {
  const dialog = dialogEl();
  if (!dialog) return;
  // The dialog can change size after the class switch (and with the window): redraw once it settles.
  new ResizeObserver(redrawIfResized).observe($('#rv-preview'));
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="rv-maximize"]')) {
      setMaximized(!state.maximized);
      return;
    }
    const button = event.target.closest('[data-action="rv-prev"], [data-action="rv-next"]');
    if (!button) return;
    const next = state.page + (button.dataset.action === 'rv-next' ? 1 : -1);
    if (next < 1 || next > state.pages) return;
    state.page = next;
    showPdfPage();
  });
}
