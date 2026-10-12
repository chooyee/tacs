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

/**
 * Turn an empty <div class="rich-editor basic|full" data-html data-placeholder> into an editor.
 * @param {HTMLElement} el
 * @returns {{getHtml: () => string, setHtml: (html: string) => void, isEmpty: () => boolean, onChange: (fn: Function) => void}}
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
    onChange(fn) {
      quill.on('text-change', fn);
    },
  };
  editor.setHtml(el.dataset.html ?? '');
  return editor;
}
