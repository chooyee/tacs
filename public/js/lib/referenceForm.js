// Shared behaviour of the reference fields (views/partials/admin/referenceFields.ejs): the file drop
// zone and the guidance editor. Used by the reference page and the standard form's upload panel.
import { $ } from './dom.js';
import { createRichEditor } from './richEditor.js';

/**
 * Wire the fields inside `form` (ids prefixed with `prefix`).
 * @param {HTMLFormElement} form
 * @param {string} prefix  'rf' or 'nr'
 * @returns {{toFormData: () => FormData, reset: () => void, validate: (isNew: boolean) => string}}
 */
export function setupReferenceFields(form, prefix) {
  const fileInput = $(`#${prefix}-file`, form);
  const dropzone = fileInput.closest('.dropzone');
  const fileName = $('.file-name', dropzone);
  const guidance = createRichEditor($(`#${prefix}-guidance`, form));

  const showFile = () => {
    const file = fileInput.files[0];
    fileName.textContent = file
      ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
      : fileName.dataset.empty;
  };
  fileInput.addEventListener('change', showFile);
  for (const type of ['dragenter', 'dragover'])
    dropzone.addEventListener(type, () => dropzone.classList.add('over'));
  for (const type of ['dragleave', 'drop'])
    dropzone.addEventListener(type, () => dropzone.classList.remove('over'));

  return {
    /** The multipart body: type, title, url, guidance (+ file when one was chosen). */
    toFormData() {
      const data = new FormData();
      data.set('type', form.elements.type.value);
      data.set('title', form.elements.title.value.trim());
      data.set('url', form.elements.url.value.trim());
      data.set('guidance', guidance.getHtml());
      if (fileInput.files[0]) data.set('file', fileInput.files[0]);
      return data;
    },
    reset() {
      form.reset();
      guidance.setHtml('');
      showFile();
    },
    /** A user-facing problem, or '' when the form can be sent. */
    validate(isNew) {
      if (!form.elements.title.value.trim()) return 'Give the reference a title.';
      if (isNew && !fileInput.files[0]) return 'Choose a file to upload.';
      return '';
    },
  };
}
