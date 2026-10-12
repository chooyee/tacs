// Reference viewer dialog (FR-REF-02, docs/03 §3.5): preview (pdf.js or image), type, note,
// "Used for" standards and the official link. Shared by the admin editor and (M3) the paper page.
import { api } from './api.js';
import { $ } from './dom.js';
import { openDialog } from './dialog.js';
import { toast } from './toast.js';

const PREVIEW_WIDTH = 520;
const state = { url: null, page: 1, pages: 1 };

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
    const { numPages } = await renderPage(canvas, state.url, state.page, PREVIEW_WIDTH);
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
  const official = $('#rv-official');
  official.hidden = !ref.url;
  if (ref.url) official.href = ref.url; // validated server-side: https:// only

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

/** Wire the pager buttons once per page. */
export function setupReferenceViewer() {
  const dialog = dialogEl();
  if (!dialog) return;
  dialog.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="rv-prev"], [data-action="rv-next"]');
    if (!button) return;
    const next = state.page + (button.dataset.action === 'rv-next' ? 1 : -1);
    if (next < 1 || next > state.pages) return;
    state.page = next;
    showPdfPage();
  });
}
