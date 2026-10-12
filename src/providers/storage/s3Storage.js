'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { ExternalServiceError } = require('../../utils/errors');
const { assertSafeKey } = require('./storage');

/**
 * AWS S3 storage (D-09, D-30). Objects are private and encrypted at rest (SSE-S3); the app streams
 * them to users itself, so there are never public S3 links (FR-REF-04).
 * Implements the Storage interface in ./storage.js.
 */
class S3Storage {
  /**
   * @param {{region: string, bucket: string, endpoint?: string, forcePathStyle?: boolean,
   *          keyPrefix?: string, credentials?: {accessKeyId: string, secretAccessKey: string}}} options
   */
  constructor({ region, bucket, endpoint, forcePathStyle, keyPrefix = '', credentials }) {
    this.bucket = bucket;
    this.keyPrefix = keyPrefix;
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      // A copy: the SDK writes bookkeeping fields onto this object, and our config is frozen.
      credentials: credentials && { ...credentials },
    });
  }

  /** Full object key: the app's prefix + the relative key. */
  fullKey(key) {
    return this.keyPrefix + assertSafeKey(key);
  }

  /** Wrap an SDK error so the user sees a friendly message and the log keeps the cause. */
  fail(message, err) {
    return new ExternalServiceError(message, { code: 'STORAGE_ERROR', cause: err });
  }

  async put(key, body, { contentType }) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256', // NFR-SEC-07
        }),
      );
    } catch (err) {
      throw this.fail('We could not save the file. Please try again.', err);
    }
  }

  async get(key) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return { stream: out.Body, contentType: out.ContentType, contentLength: out.ContentLength };
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw this.fail('We could not load the file. Please try again.', err);
    }
  }

  async copy(fromKey, toKey) {
    try {
      // CopySource must be URL-encoded "bucket/key".
      const source = encodeURIComponent(`${this.bucket}/${this.fullKey(fromKey)}`).replace(/%2F/g, '/');
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(toKey),
          CopySource: source,
          ServerSideEncryption: 'AES256',
        }),
      );
    } catch (err) {
      throw this.fail('We could not copy the file. Please try again.', err);
    }
  }

  async remove(key) {
    try {
      // S3 answers 204 for a key that does not exist, so deleting twice is fine.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
    } catch (err) {
      throw this.fail('We could not delete the file.', err);
    }
  }

  async ping() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

module.exports = { S3Storage };
