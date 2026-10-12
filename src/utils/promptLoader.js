'use strict';

/**
 * Prompts are Markdown files in src/ai/prompts/ with front matter (docs/07 §3). No prompt text lives
 * in JavaScript. The prompt's `version` is saved on each check, so we know which prompt produced
 * which results.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./errors');

const PROMPTS_DIR = path.join(__dirname, '../ai/prompts');
const cache = new Map();

/**
 * Load a Markdown prompt and fill its {{placeholders}}.
 * @param {string} id  file name without .md, e.g. "compare-section"
 * @param {Record<string, string>} values
 * @returns {{text: string, version: string}}
 * @throws {ConfigError} if the file is missing or a placeholder has no value
 */
function loadPrompt(id, values) {
  if (!cache.has(id)) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(PROMPTS_DIR, `${id}.md`), 'utf8').replace(/\r\n/g, '\n');
    } catch {
      throw new ConfigError(`Prompt ${id} not found`);
    }
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new ConfigError(`Prompt ${id} has no front matter`);
    const version = /version:\s*(.+)/.exec(match[1])?.[1].trim();
    cache.set(id, { body: match[2], version });
  }
  const { body, version } = cache.get(id);
  const text = body.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    if (!(name in values)) throw new ConfigError(`Prompt ${id}: missing value for {{${name}}}`);
    return values[name];
  });
  return { text, version };
}

module.exports = { loadPrompt };
