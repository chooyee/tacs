'use strict';

const config = require('../config');

let instance; // created once, reused (singleton)

/**
 * The AI provider for this environment (docs/07 §1 rule 3): `AI_PROVIDER` = gemini | bedrock | fake.
 * Services call this and never import a provider directly, so switching provider is a config change.
 * Providers are required lazily, so an environment never loads an SDK it does not use.
 *
 * @returns {object} an AiProvider (see providers/ai/aiProvider.js)
 */
function getAiProvider() {
  if (instance) return instance;
  const { provider, timeoutMs, maxRetries } = config.ai;
  if (provider === 'gemini') {
    const { GeminiProvider } = require('../providers/ai/geminiProvider');
    instance = new GeminiProvider({ ...config.ai.gemini, timeoutMs, maxRetries });
  } else if (provider === 'bedrock') {
    const { BedrockProvider } = require('../providers/ai/bedrockProvider');
    instance = new BedrockProvider({ ...config.ai.bedrock, timeoutMs, maxRetries });
  } else {
    const { FakeAiProvider } = require('../providers/ai/fakeAiProvider');
    instance = new FakeAiProvider({ delayMs: config.isTest ? 0 : 1500 });
  }
  return instance;
}

/**
 * Replace the provider (tests only), e.g. with a fake that returns invalid JSON.
 * @param {object|undefined} provider
 */
function setAiProviderForTests(provider) {
  if (!config.isTest) throw new Error('setAiProviderForTests is for tests only');
  instance = provider;
}

module.exports = { getAiProvider, setAiProviderForTests };
