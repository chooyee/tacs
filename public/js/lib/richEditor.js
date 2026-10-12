// Rich-text editor (D-37): Quill 2, as in survey-app-poc, loaded from /vendor by the layout on pages
// that set usesRichEditor. The HTML it produces is ALWAYS cleaned again on the server; this module
// only makes editing pleasant.

const TOOLBARS = {
  // Standard description: the basics.
  basic: [
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link', 'clean'],
  ],
  // Reference guidance: a little more structure.
  full: [
    [{ header: [2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }, 'blockquote'],
    ['link', 'clean'],
  ],
};

const PICKER_NAMES = { 2: 'Heading 2', 3: 'Heading 3', '': 'Normal text' };

/** Quill's heading picker has no accessible names; add them (WCAG 4.1.2, docs/03 §5). */
function nameToolbar(el) {
  const toolbar = el.previousElementSibling;
  if (!toolbar?.classList.contains('ql-toolbar')) return;
  for (const label of toolbar.querySelectorAll('.ql-picker-label')) label.setAttribute('aria-label', 'Text style');
  for (const item of toolbar.querySelectorAll('.ql-picker-item')) {
    item.setAttribute('aria-label', PICKER_NAMES[item.dataset.value ?? ''] ?? 'Text style');
  }
  for (const select of toolbar.querySelectorAll('select')) select.setAttribute('aria-hidden', 'true');
}

/**
 * Turn an empty <div class="rich-editor basic|full" data-html data-placeholder> into an editor.
 * @param {HTMLElement} el
 * @returns {{getHtml: () => string, setHtml: (html: string) => void, isEmpty: () => boolean, getText: () => string, onChange: (fn: Function) => void}}
 */
export function createRichEditor(el) {
  if (!window.Quill) throw new Error('Quill is not loaded on this page (usesRichEditor).');
  const quill = new window.Quill(el, {
    theme: 'snow',
    placeholder: el.dataset.placeholder ?? '',
    modules: { toolbar: TOOLBARS[el.classList.contains('full') ? 'full' : 'basic'] },
  });

  const editor = {
    /** Semantic HTML (real <ul>/<ol>, no Quill internals), or '' when there is no text. */
    getHtml: () => (quill.getText().trim() ? quill.getSemanticHTML() : ''),
    setHtml(html) {
      quill.setContents(quill.clipboard.convert({ html: html || '' }), 'silent');
    },
    isEmpty: () => !quill.getText().trim(),
    /** The plain text, e.g. for a live preview or a word count. */
    getText: () => quill.getText().trim(),
    onChange(fn) {
      quill.on('text-change', fn);
    },
  };
  editor.setHtml(el.dataset.html ?? '');
  nameToolbar(el);
  return editor;
}
