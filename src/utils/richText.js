'use strict';

/**
 * Rich text (Quill output) → safe HTML, with an allow-list (D-37). The browser is never trusted:
 * every rich-text field is cleaned here before it is saved, and again when a view prints it.
 *
 * How it stays safe:
 * - Only the tags in ALLOWED survive, and each is REBUILT from scratch: the original attributes are
 *   thrown away. The only attribute ever written is a checked `href` on <a> (http, https, mailto).
 * - <script>, <style> etc. are removed together with their content; other unknown tags are removed
 *   but their text is kept.
 * - Text between tags is re-escaped, so a stray "<" can never start a tag.
 * - Open tags are tracked and closed at the end, so broken HTML cannot leak out of its container.
 */

const ALLOWED = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'h2',
  'h3',
  'blockquote',
]);
const VOID = new Set(['br']);
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
]);
const SAFE_URL = /^(https?:\/\/|mailto:)[^\s"'<>]+$/i;

const TOKEN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the few entities Quill writes, plus numeric ones. */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Escape text for HTML (after decoding, so nothing is double-escaped). */
function escapeText(text) {
  return decodeEntities(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The href of an <a> tag, if it is a safe URL. */
function safeHref(attrs) {
  const match = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const value = match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '').trim() : '';
  return SAFE_URL.test(value) ? value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : null;
}

/**
 * Clean rich text for storage and display.
 * @param {string} html  untrusted HTML (e.g. from the Quill editor)
 * @returns {string} safe HTML; '' when there is no visible text
 */
function sanitizeRichText(html) {
  const input = String(html ?? '');
  const out = [];
  const open = [];
  let dropping = null; // inside <script> … </script>: skip everything
  let last = 0;

  for (const match of input.matchAll(TOKEN)) {
    if (!dropping) out.push(escapeText(input.slice(last, match.index)));
    last = match.index + match[0].length;
    const tag = match[1]?.toLowerCase();
    if (!tag) continue; // a comment
    const closing = match[0][1] === '/';

    if (dropping) {
      if (closing && tag === dropping) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing) dropping = tag;
      continue;
    }
    if (!ALLOWED.has(tag)) continue;

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue; // a stray closing tag
      while (open.length > at) out.push(`</${open.pop()}>`);
    } else if (VOID.has(tag)) {
      out.push(`<${tag}>`);
    } else if (tag === 'a') {
      const href = safeHref(match[2]);
      out.push(href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">` : '<a>');
      open.push('a');
    } else {
      out.push(`<${tag}>`);
      open.push(tag);
    }
  }
  if (!dropping) out.push(escapeText(input.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);

  const html2 = out.join('');
  return richTextToPlain(html2) ? html2 : '';
}

/**
 * Plain text of (already safe) rich text: for tooltips, search and the AI prompt.
 * @param {string} html
 * @param {number} [max]  cut to this many characters (with "…")
 * @returns {string}
 */
function richTextToPlain(html, max) {
  const text = decodeEntities(
    String(html ?? '')
      .replace(/<(br|\/p|\/li|\/h[23]|\/blockquote)\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return max && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

module.exports = { sanitizeRichText, richTextToPlain };
