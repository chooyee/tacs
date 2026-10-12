'use strict';

const config = require('../config');
const { S3Storage } = require('../providers/storage/s3Storage');
const { MemoryStorage } = require('../providers/storage/memoryStorage');

let instance; // created once, reused (singleton)

/**
 * The file storage for this environment (docs/04 §3.1): S3 everywhere, in-memory in tests.
 * Services call this instead of creating an S3 client, so tests never touch AWS.
 *
 * @returns {import('../providers/storage/storage').Storage}
 */
function getStorage() {
  if (instance) return instance;
  instance = config.isTest ? new MemoryStorage() : new S3Storage(config.s3);
  return instance;
}

module.exports = { getStorage };
