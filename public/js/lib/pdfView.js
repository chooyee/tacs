// Render a PDF page into a <canvas> with pdf.js (docs/04 §1). pdf.js is copied into /vendor by
// `npm run build`. Settings keep it inside our CSP: no eval, worker from our own origin.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const documents = new Map(); // url → loading task promise, so paging does not download again

/**
 * Load a PDF once per page view.
 * @param {string} url
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
export function loadPdf(url) {
  if (!documents.has(url)) {
    const task = pdfjsLib.getDocument({
      url,
      isEvalSupported: false, // CSP: script-src 'self' (NFR-SEC-02)
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      withCredentials: true,
    });
    documents.set(url, task.promise);
    task.promise.catch(() => documents.delete(url)); // allow a retry
  }
  return documents.get(url);
}

/**
 * Draw one page so it fits `maxWidth` CSS pixels (sharp on high-DPI screens).
 * @param {HTMLCanvasElement} canvas
 * @param {string} url
 * @param {number} pageNumber  1-based
 * @param {number} maxWidth
 * @returns {Promise<{numPages: number}>}
 */
export async function renderPage(canvas, url, pageNumber, maxWidth) {
  const pdf = await loadPdf(url);
  const page = await pdf.getPage(Math.min(Math.max(pageNumber, 1), pdf.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = maxWidth / base.width;
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width / ratio}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  return { numPages: pdf.numPages };
}
