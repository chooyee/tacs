'use strict';

/**
 * Gemini, for local development and the dev environment with TEST documents only (docs/07 §6.1,
 * D-13). Files go to the model as PDFs / images; the answer is forced into our JSON schema.
 */
const { GoogleGenAI } = require('@google/genai');
const { compareResponseJsonSchema } = require('../../ai/schemas/compareResult');
const { withRetry, withTimeout, toAiError, comparePrompt, questionPrompt } = require('./aiProvider');

// Inline file data has a request size limit (about 20 MB); above this we use the Files API.
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

class GeminiProvider {
  /**
   * @param {{apiKey: string, model: string, timeoutMs: number, maxRetries: number}} cfg
   */
  constructor(cfg) {
    this.name = 'gemini';
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs;
    this.maxRetries = cfg.maxRetries;
  }

  /** Send one request with a timeout, retrying rate limits / server errors / timeouts once. */
  async generate(parts, config) {
    return withRetry(
      async () => {
        const controller = new AbortController();
        try {
          return await withTimeout(
            this.client.models.generateContent({
              model: this.model,
              contents: [{ role: 'user', parts }],
              config: { ...config, abortSignal: controller.signal },
            }),
            this.timeoutMs,
            () => controller.abort(),
          );
        } catch (err) {
          throw toAiError(err, 'gemini');
        }
      },
      { retries: this.maxRetries },
    );
  }

  /** Inline the files, or upload them with the Files API when they are too big together. */
  async fileParts(files) {
    const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
    if (total <= MAX_INLINE_BYTES) {
      return files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.bytes.toString('base64') } }));
    }
    try {
      return await Promise.all(
        files.map(async (f) => {
          const uploaded = await this.client.files.upload({
            file: new Blob([f.bytes], { type: f.mimeType }),
            config: { mimeType: f.mimeType, displayName: f.name },
          });
          return { fileData: { fileUri: uploaded.uri, mimeType: f.mimeType } };
        }),
      );
    } catch (err) {
      throw toAiError(err, 'gemini');
    }
  }

  /** @param {import('./aiProvider').CompareInput} input */
  async compareSection(input) {
    const { text, version } = comparePrompt(input);
    const files = await this.fileParts([...input.paperFiles, ...input.references]);
    const res = await this.generate([...files, { text }], {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: compareResponseJsonSchema,
    });
    return {
      raw: res.text, // a JSON string; check.service parses and validates it
      usage: { inputTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0 },
      model: this.model,
      promptVersion: version,
    };
  }

  async answerQuestion(input) {
    const { text, version } = questionPrompt(input);
    const res = await this.generate([{ text }], { temperature: 0.2, maxOutputTokens: 400 });
    return {
      text: res.text ?? '',
      usage: { inputTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0 },
      model: this.model,
      promptVersion: version,
    };
  }

  async healthCheck() {
    try {
      await this.client.models.get({ model: this.model });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { GeminiProvider };
