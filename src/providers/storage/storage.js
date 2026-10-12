'use strict';

/**
 * The storage "interface" (docs/04 §3.1). Every storage provider (S3, memory) has these methods, so
 * services never care which one they use. Keys are relative ("references/<typeId>/<uuid>.pdf"); the
 * provider adds S3_KEY_PREFIX itself.
 *
 * @typedef {object} StoredFile
 * @property {import('node:stream').Readable} stream   the file's bytes
 * @property {string} contentType
 * @property {number} [contentLength]
 *
 * @typedef {object} Storage
 * @property {(key: string, body: Buffer, opts: {contentType: string}) => Promise<void>} put
 * @property {(key: string) => Promise<StoredFile|null>} get        null when the object does not exist
 * @property {(fromKey: string, toKey: string) => Promise<void>} copy
 * @property {(key: string) => Promise<void>} remove               no error if it is already gone
 * @property {() => Promise<void>} ping                             rejects when storage is unreachable
 */

/**
 * Reject keys that could escape the app's folder or confuse S3 ("..", leading "/").
 * @param {string} key
 * @returns {string} the same key
 * @throws {Error} for an unsafe key (a programming error, never user input)
 */
function assertSafeKey(key) {
  if (typeof key !== 'string' || !/^[\w-]+(\/[\w.-]+)*$/.test(key) || key.includes('..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return key;
}

module.exports = { assertSafeKey };
