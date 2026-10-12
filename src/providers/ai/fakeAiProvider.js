'use strict';

/**
 * A fake AI for tests and offline development (docs/07 §10): no network, deterministic answers.
 * It never reads the files; it only shapes plausible results from the standard numbers, so the whole
 * check flow (worker, validation, results, readiness, chat) can run without a real model.
 */
const { comparePrompt, questionPrompt } = require('./aiProvider');

/** Verdicts in a fixed rotation: mostly "comply", with some of every other kind. */
const ROTATION = ['comply', 'comply', 'partial', 'comply', 'gap', 'comply', 'none'];
const AREAS = ['text', 'diagram', 'table'];

class FakeAiProvider {
  constructor({ delayMs = 0 } = {}) {
    this.name = 'fake';
    this.model = 'fake-model';
    this.delayMs = delayMs; // > 0 lets the progress steps be seen in the browser
  }

  /** @param {import('./aiProvider').CompareInput} input */
  async compareSection(input) {
    const { version } = comparePrompt(input); // proves the prompt can be built
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const paper = input.paperFiles[0];
    const results = input.standards.map((s) => {
      const verdict = ROTATION[s.number % ROTATION.length];
      const found = verdict !== 'none';
      const referenceKey = s.referenceKeys[0] ?? null;
      return {
        standardKey: s.key,
        verdict,
        fileKey: found ? paper.key : null,
        page: found ? 1 + (s.number % (paper.pageCount || 1)) : null,
        area: found ? AREAS[s.number % AREAS.length] : null,
        finding: {
          comply: `Your paper covers “${s.text}” as the reference expects.`,
          partial: `Your paper mentions “${s.text}” but with less detail than the reference shows.`,
          gap: `Your paper contradicts “${s.text}”: the reference expects a different design.`,
          none: `Nothing in your paper addresses “${s.text}”.`,
        }[verdict].slice(0, 300),
        referenceKey,
        referencePage: referenceKey ? 1 : null,
        confidence: 0.8,
      };
    });
    return {
      raw: { results },
      usage: { inputTokens: 1000, outputTokens: 50 * results.length },
      model: this.model,
      promptVersion: version,
    };
  }

  async answerQuestion(input) {
    const { version } = questionPrompt(input);
    return {
      text: 'This is the fake AI. In a real environment the AI answers from your saved answers and the latest check.',
      usage: { inputTokens: 100, outputTokens: 20 },
      model: this.model,
      promptVersion: version,
    };
  }

  async healthCheck() {
    return true;
  }
}

module.exports = { FakeAiProvider };
