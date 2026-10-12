'use strict';

/**
 * The AI provider "interface" and the helpers every provider shares (docs/07 §2, §6.3).
 * JavaScript has no interfaces, so the contract is written down here:
 *
 * @typedef {object} AiFile
 * @property {string} key        short label used in the prompt, e.g. "P1" (paper) or "R3" (reference)
 * @property {string} name       safe file name (letters, digits, spaces, hyphens only)
 * @property {string} mimeType   "application/pdf" | "image/png" | "image/jpeg"
 * @property {Buffer} bytes
 * @property {number} [pageCount]
 *
 * @typedef {object} CompareInput
 * @property {string} paperTypeName
 * @property {AiFile[]} paperFiles            1–3 PDFs of the architect's paper
 * @property {Array<{key: string, number: number, text: string, mandatory: boolean, referenceKeys: string[]}>} standards
 * @property {Array<AiFile & {type: string, title: string, note: string}>} references
 * @property {string} [repairNote]            set on the one retry after invalid JSON (§6.4)
 *
 * @typedef {object} CompareOutput
 * @property {unknown} raw                    the model's JSON (an object or a string); validated by check.service
 * @property {{inputTokens: number, outputTokens: number}} usage
 * @property {string} model
 * @property {string} promptVersion
 *
 * Every provider has:
 *   compareSection(input: CompareInput): Promise<CompareOutput>
 *   answerQuestion({question, contextMarkdown}): Promise<{text, usage, model, promptVersion}>
 *   healthCheck(): Promise<boolean>
 *   name: 'gemini' | 'bedrock' | 'fake'
 */
const { AiProviderError } = require('../../utils/errors');
const { loadPrompt } = require('../../utils/promptLoader');

/** Wait `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reject when `promise` takes longer than `ms`. `onTimeout` lets the caller abort the request.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new AiProviderError('The AI took too long to answer.', { code: 'AI_TIMEOUT', status: 504 }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Errors worth one more try: rate limits, server errors and timeouts (docs/07 §6.3). */
function isRetryable(err) {
  return ['AI_RATE_LIMITED', 'AI_TIMEOUT', 'AI_UNAVAILABLE'].includes(err?.code);
}

/**
 * Run `fn`, retrying retryable errors with a pause between tries.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{retries?: number, delaysMs?: number[]}} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, { retries = 1, delaysMs = [2000, 5000] } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)]);
    }
  }
}

/**
 * Turn an SDK error into our AiProviderError with a stable code; the original stays as `cause`.
 * @param {unknown} err
 * @param {string} provider  'gemini' | 'bedrock'
 * @returns {AiProviderError}
 */
function toAiError(err, provider) {
  if (err instanceof AiProviderError) return err;
  const status = err?.status ?? err?.$metadata?.httpStatusCode ?? err?.code;
  const name = err?.name ?? '';
  let code = 'AI_UNAVAILABLE';
  if (status === 429 || /Throttling|TooManyRequests|RESOURCE_EXHAUSTED/i.test(`${name} ${err?.message}`)) {
    code = 'AI_RATE_LIMITED';
  } else if (name === 'AbortError' || /timeout/i.test(name)) {
    code = 'AI_TIMEOUT';
  } else if ((status >= 400 && status < 500) || /Validation|AccessDenied/i.test(name)) {
    code = 'AI_BAD_REQUEST';
  }
  return new AiProviderError(`The ${provider} AI request failed.`, { code, cause: err });
}

/** Keep only letters, digits, spaces and hyphens (Bedrock document names; safe in prompts). */
function safeName(name) {
  return (
    String(name)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^A-Za-z0-9 -]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'file'
  );
}

const cell = (text) => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * The values for compare-section.md: file lists and the standards table (docs/07 §3.1).
 * @param {CompareInput} input
 * @returns {Record<string, string>}
 */
function compareValues(input) {
  const refByKey = new Map(input.references.map((r) => [r.key, r]));
  const rows = input.standards.map((s) => {
    const compareWith = s.referenceKeys
      .map((key) => {
        const ref = refByKey.get(key);
        if (!ref) return null;
        return ref.note ? `${key} (${ref.type}: ${cell(ref.title)} — ${cell(ref.note)})` : `${key} (${ref.type}: ${cell(ref.title)})`;
      })
      .filter(Boolean)
      .join(', ');
    return `| ${s.key} | ${s.number} | ${cell(s.text)} | ${s.mandatory ? 'yes' : 'no'} | ${compareWith || '—'} |`;
  });
  return {
    paperTypeName: cell(input.paperTypeName),
    paperFileList: input.paperFiles.map((f) => `${f.key} = "${f.name}"`).join(', '),
    referenceList: input.references.length
      ? input.references.map((r) => `${r.key} = ${r.type} "${cell(r.title)}"`).join(', ')
      : 'none',
    standardsTable: [
      '| key | # | standard | mandatory | compare with |',
      '|-----|---|----------|-----------|--------------|',
      ...rows,
    ].join('\n'),
  };
}

/**
 * The compare prompt text and version, with the repair note on the retry after invalid JSON.
 * @param {CompareInput} input
 * @returns {{text: string, version: string}}
 */
function comparePrompt(input) {
  const { text, version } = loadPrompt('compare-section', compareValues(input));
  return {
    text: input.repairNote
      ? `${text}\n\n# Correction\nYour previous answer did not match the schema: ${input.repairNote}. Return corrected JSON only.`
      : text,
    version,
  };
}

/**
 * The chat prompt (docs/07 §7).
 * @param {{question: string, contextMarkdown: string}} input
 * @returns {{text: string, version: string}}
 */
function questionPrompt({ question, contextMarkdown }) {
  return loadPrompt('answer-question', { question, contextMarkdown });
}

module.exports = { sleep, withTimeout, withRetry, toAiError, safeName, compareValues, comparePrompt, questionPrompt };
