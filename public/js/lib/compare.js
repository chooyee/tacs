// Compare side by side (docs/03 §3.4, FR-AI-11) and the page previews used by the chat's compare
// cards: the paper page and the reference page, rendered in the browser with pdf.js (D-07), each with
// an outline over the area the AI used.
import { api } from './api.js';
import { $ } from './dom.js';
import { openDialog, closeDialog } from './dialog.js';
import { openReferenceViewer } from './referenceViewer.js';

// Where the AI's `area` sits on a page when it gives no bounding box (docs/03 §3.4), in % of the page.
const AREAS = { text: { l: 8, t: 22, w: 84, h: 20 }, diagram: { l: 6, t: 41, w: 88, h: 30 }, table: { l: 6, t: 72, w: 88, h: 20 } };
const referenceCache = new Map();

/** Fill {placeholders} in a string. */
export const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_m, key) => values[key] ?? '');

/**
 * The outline box in % of the page: the AI's bounding box (0–1 fractions) if it gave one, else the area.
 * @returns {{l, t, w, h}|null}
 */
function box(area, bbox) {
  if (bbox && [bbox.x, bbox.y, bbox.w, bbox.h].every((n) => Number.isFinite(n))) {
    return { l: bbox.x * 100, t: bbox.y * 100, w: bbox.w * 100, h: bbox.h * 100 };
  }
  return AREAS[area] ?? null;
}

/**
 * The reference's viewer data (type, title, file URL, MIME type), fetched once per page view.
 * @param {string} referenceId
 */
export function loadReference(referenceId) {
  if (!referenceCache.has(referenceId)) {
    const promise = api(`/api/references/${referenceId}`);
    referenceCache.set(referenceId, promise);
    promise.catch(() => referenceCache.delete(referenceId));
  }
  return referenceCache.get(referenceId);
}

/**
 * Draw one page into `container`, with an outline over the area. Shows `emptyText` instead when
 * there is nothing to draw (no page, PDF removed, load error).
 * @param {HTMLElement} container
 * @param {{url?: string, mimeType?: string, page?: number, area?: string, bbox?: object,
 *   outline: 'solid'|'dashed', verdict?: string, width: number, emptyText: string}} opts
 */
export async function drawPage(container, { url, mimeType = 'application/pdf', page, area, bbox, outline, verdict, width, emptyText }) {
  const empty = () => container.replaceChildren(Object.assign(document.createElement('p'), { className: 'cmp-empty', textContent: emptyText }));
  if (!url || (mimeType === 'application/pdf' && !page)) return empty();
  const frame = Object.assign(document.createElement('div'), { className: 'cmp-frame' });
  try {
    if (mimeType === 'application/pdf') {
      const canvas = document.createElement('canvas');
      frame.append(canvas);
      container.replaceChildren(frame);
      // Loaded on first use only: pages without previews never download pdf.js.
      const { renderPage } = await import('./pdfView.js');
      await renderPage(canvas, url, page, width);
    } else {
      const img = Object.assign(document.createElement('img'), { src: url, alt: '' });
      img.style.width = `${width}px`;
      frame.append(img);
      container.replaceChildren(frame);
      await img.decode().catch(() => {});
    }
  } catch {
    return empty();
  }
  const b = box(area, bbox);
  if (b) {
    const mark = Object.assign(document.createElement('span'), { className: `cmp-mark ${outline}` });
    if (verdict) mark.dataset.verdict = verdict;
    // CSSOM (not a style attribute), so this works under the CSP.
    Object.assign(mark.style, { left: `${b.l}%`, top: `${b.t}%`, width: `${b.w}%`, height: `${b.h}%` });
    frame.append(mark);
  }
}

/**
 * Wire the compare dialog. `store` is the paper page's state (see paper.js).
 * @returns {(standardId: string) => Promise<void>} open the dialog for one standard
 */
export function setupCompare(store) {
  const dialog = $('#compare-dialog');
  const s = store.strings;
  let current = null;

  async function open(standardId) {
    const result = store.resultFor(standardId);
    const standard = store.standard(standardId);
    if (!result || !standard) return;
    current = { standardId, result };
    $('#cmp-title').textContent = `#${standard.number} · ${standard.title}`;
    const verdict = Object.assign(document.createElement('span'), {
      className: 'vd',
      textContent: `✦ ${s.verdicts[result.verdict]}`,
    });
    verdict.dataset.verdict = result.verdict;
    $('#cmp-finding').replaceChildren(verdict, ` ${result.finding}`);
    $('[data-action="cmp-goto"]', dialog).textContent = fill(s.goTo, { n: standard.number });
    const applyButton = $('[data-action="cmp-apply"]', dialog);
    applyButton.hidden = !store.isOwner || store.answerOf(standardId).value === result.suggested;
    applyButton.textContent = fill(s.useAi, { answer: result.suggested === 'yes' ? 'Yes' : 'No' });
    $('[data-action="cmp-open-reference"]', dialog).hidden = !result.referenceId;
    openDialog(dialog);

    const width = Math.min(400, Math.floor(($('#cmp-paper').clientWidth || 380) - 2));
    const latest = store.latest();
    $('#cmp-paper-label').textContent = result.page ? fill(s.yourPage, { n: result.page }) : s.yourPaper;
    const paperDoc = latest.check.documents.find((d) => d.id === result.documentId);
    drawPage($('#cmp-paper'), {
      url: paperDoc && `/files/documents/${paperDoc.id}`,
      page: result.page,
      area: result.area,
      bbox: result.bbox,
      outline: 'solid',
      verdict: result.verdict,
      width,
      emptyText: !latest.check.pdfsAvailable ? s.pdfRemoved : s.notFoundInPaper,
    });

    if (!result.referenceId) {
      $('#cmp-ref-label').textContent = '';
      drawPage($('#cmp-ref'), { width, outline: 'dashed', emptyText: s.noReference });
      return;
    }
    try {
      const ref = await loadReference(result.referenceId);
      const icon = store.icons[ref.type] ?? '📄';
      $('#cmp-ref-label').textContent = result.referencePage
        ? fill(s.refPage, { icon, type: ref.type, title: ref.title, n: result.referencePage })
        : fill(s.refNoPage, { icon, type: ref.type, title: ref.title });
      drawPage($('#cmp-ref'), {
        url: ref.fileUrl,
        mimeType: ref.mimeType,
        page: result.referencePage ?? 1,
        area: result.area,
        outline: 'dashed',
        width,
        emptyText: s.noReference,
      });
    } catch {
      drawPage($('#cmp-ref'), { width, outline: 'dashed', emptyText: s.noReference });
    }
  }

  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !current) return;
    if (button.dataset.action === 'cmp-open-reference') {
      closeDialog(dialog);
      openReferenceViewer(current.result.referenceId);
    } else if (button.dataset.action === 'cmp-goto') {
      closeDialog(dialog);
      store.jump(current.standardId);
    } else if (button.dataset.action === 'cmp-apply') {
      button.disabled = true;
      await store.apply(current.standardId);
      button.disabled = false;
      closeDialog(dialog);
    }
  });

  return open;
}
