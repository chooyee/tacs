'use strict';

/**
 * AWS Bedrock, used in UAT and production (docs/07 §6.2, D-13): the data stays in our AWS account.
 * Uses the Converse API with document / image blocks and forces our JSON through a "tool": the
 * model calls `record_results`, and the tool input is the JSON we validate.
 * Credentials come from the task's IAM role (no keys).
 */
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { compareResponseJsonSchema } = require('../../ai/schemas/compareResult');
const { withRetry, withTimeout, toAiError, safeName, comparePrompt, questionPrompt } = require('./aiProvider');

const IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg' };

/** A Converse content block for one file: PDFs as documents, PNG / JPG as images. */
function fileBlock(file) {
  if (IMAGE_FORMATS[file.mimeType]) {
    return { image: { format: IMAGE_FORMATS[file.mimeType], source: { bytes: file.bytes } } };
  }
  // Document names must be unique in a request; the short key makes them so.
  return { document: { format: 'pdf', name: `${file.key} ${safeName(file.name)}`, source: { bytes: file.bytes } } };
}

class BedrockProvider {
  /**
   * @param {{region: string, modelId: string, timeoutMs: number, maxRetries: number}} cfg
   */
  constructor(cfg) {
    this.name = 'bedrock';
    this.client = new BedrockRuntimeClient({ region: cfg.region });
    this.model = cfg.modelId;
    this.timeoutMs = cfg.timeoutMs;
    this.maxRetries = cfg.maxRetries;
  }

  async send(input) {
    return withRetry(
      async () => {
        const controller = new AbortController();
        try {
          return await withTimeout(
            this.client.send(new ConverseCommand({ modelId: this.model, ...input }), {
              abortSignal: controller.signal,
            }),
            this.timeoutMs,
            () => controller.abort(),
          );
        } catch (err) {
          throw toAiError(err, 'bedrock');
        }
      },
      { retries: this.maxRetries },
    );
  }

  /** @param {import('./aiProvider').CompareInput} input */
  async compareSection(input) {
    const { text, version } = comparePrompt(input);
    const res = await this.send({
      messages: [
        { role: 'user', content: [...[...input.paperFiles, ...input.references].map(fileBlock), { text }] },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'record_results',
              description: 'Save one verdict per standard.',
              inputSchema: { json: compareResponseJsonSchema },
            },
          },
        ],
        toolChoice: { tool: { name: 'record_results' } },
      },
      inferenceConfig: { temperature: 0.1, maxTokens: 8000 },
    });
    const toolUse = res.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
    return {
      raw: toolUse?.input ?? null, // validated by check.service
      usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
      model: this.model,
      promptVersion: version,
    };
  }

  async answerQuestion(input) {
    const { text, version } = questionPrompt(input);
    const res = await this.send({
      messages: [{ role: 'user', content: [{ text }] }],
      inferenceConfig: { temperature: 0.2, maxTokens: 400 },
    });
    const answer = (res.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
    return {
      text: answer,
      usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
      model: this.model,
      promptVersion: version,
    };
  }

  async healthCheck() {
    try {
      await this.send({ messages: [{ role: 'user', content: [{ text: 'ping' }] }], inferenceConfig: { maxTokens: 5 } });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { BedrockProvider };
