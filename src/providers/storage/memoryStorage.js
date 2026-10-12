'use strict';

const { Readable } = require('node:stream');
const { assertSafeKey } = require('./storage');

/**
 * In-memory storage for tests (docs/04 §4). Same methods as S3Storage; nothing leaves the process.
 * `objects` is public so tests can check what was stored.
 */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, {body: Buffer, contentType: string}>} */
    this.objects = new Map();
  }

  async put(key, body, { contentType }) {
    this.objects.set(assertSafeKey(key), { body: Buffer.from(body), contentType });
  }

  async get(key) {
    const obj = this.objects.get(assertSafeKey(key));
    if (!obj) return null;
    return {
      stream: Readable.from([obj.body]),
      contentType: obj.contentType,
      contentLength: obj.body.length,
    };
  }

  async copy(fromKey, toKey) {
    const obj = this.objects.get(assertSafeKey(fromKey));
    if (!obj) throw new Error(`MemoryStorage: no object ${fromKey}`);
    this.objects.set(assertSafeKey(toKey), { ...obj });
  }

  async remove(key) {
    this.objects.delete(assertSafeKey(key));
  }

  async ping() {}

  /** Tests: forget everything. */
  clear() {
    this.objects.clear();
  }
}

module.exports = { MemoryStorage };
