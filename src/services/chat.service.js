'use strict';

/**
 * The AI checker chat (FR-CHAT-01…06). Quick actions and "#N" questions are answered from the
 * database without the AI; other questions go to the AI with the paper's answers and latest results
 * as context (no PDF). Everything is stored and shown as plain text.
 */
const config = require('../config');
const chatModel = require('../models/chat.model');
const referenceModel = require('../models/reference.model');
const paperService = require('./paper.service');
const readinessService = require('./readiness.service');
const checkService = require('./check.service');
const { getAiProvider } = require('../factories/aiProviderFactory');
const { AppError } = require('../utils/errors');

const CHAT_LIMIT = 20; // messages per user …
const CHAT_WINDOW_MS = 10 * 60 * 1000; // … per 10 minutes (FR-CHAT-05, NFR-SEC-08)
const MAX_ANSWER_CHARS = 1500;

/**
 * A paper's chat history (anyone may read it, FR-PAP-08).
 * @param {{paperId: string}} params
 * @returns {Promise<{messages: object[], retentionDays: number}>}
 */
async function listMessages({ paperId }) {
  await paperService.getPaperOrThrow(paperId);
  return { messages: await chatModel.listForPaper(paperId), retentionDays: config.retention.days };
}

async function say(paperId, kind, content) {
  return chatModel.insert({ paperId, role: 'assistant', kind, content });
}

/**
 * 20 messages per user per 10 minutes, typed or quick (FR-CHAT-05, NFR-SEC-08).
 * @throws {AppError} 429 RATE_LIMITED
 */
async function assertChatLimit(user) {
  const since = new Date(Date.now() - CHAT_WINDOW_MS);
  if ((await chatModel.countUserMessagesSince(user.id, since)) >= CHAT_LIMIT) {
    throw new AppError('You have sent many messages in the last few minutes. Please wait a little.', {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
}

/** "4", "#4", "standard 4" → 4 (FR-CHAT-03); null for anything else. */
function standardNumberIn(text) {
  const match = /^\s*(?:#\s*|standard\s+|std\s+)?(\d{1,4})\s*\??\s*$/i.exec(text) ?? /#\s*(\d{1,4})\b/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * A quick action, answered from the database (FR-CHAT-02): gaps, refs, summary, compare.
 * @param {{user: object, paperId: string, action: string, standardId?: string, log: object}} params
 * @returns {Promise<{messages: object[]}>}
 */
async function quickAction({ user, paperId, action, standardId, log }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  await assertChatLimit(user);
  const state = await readinessService.forPaper(paper);
  let reply;
  if (action === 'gaps') {
    reply = await say(paperId, 'gaps', { quick: true, ready: state.readiness.ready, gaps: state.readiness.gaps });
  } else if (action === 'refs') {
    const refs = await referenceModel.listUsedByVersion(paper.paperTypeVersionId);
    reply = await say(paperId, 'refs', { quick: true, references: refs.map((r) => ({ id: r.id, type: r.type, title: r.title, note: r.note })) });
  } else if (action === 'summary') {
    const view = checkService.latestView(state);
    reply = await say(paperId, 'summary', {
      quick: true,
      readiness: { answered: state.readiness.answered, total: state.readiness.total, ready: state.readiness.ready, gaps: state.readiness.gaps.length },
      counts: view?.counts ?? null,
    });
  } else {
    const target = standardId ?? state.readiness.gaps.find((g) => g.standardId)?.standardId ?? state.standards[0]?.id;
    reply = await say(paperId, 'compare', { quick: true, standardId: target });
  }
  log.info({ paperId, action }, 'Chat quick action');
  return { messages: [reply] };
}

/** The context for an AI question (docs/07 §7): answers and latest results, as Markdown. */
function contextMarkdown(paper, state) {
  const results = new Map(state.resultRows.map((r) => [r.standardId, r]));
  const cell = (t) => String(t ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const rows = state.standards.map((s) => {
    const a = state.answers[s.id];
    const r = results.get(s.id);
    return `| #${s.number} | ${cell(s.title)} | ${s.isMandatory ? 'yes' : 'no'} | ${a?.value ?? '—'} | ${cell(a?.remark) || '—'} | ${r ? `${r.verdict}: ${cell(r.finding)}` : '—'} |`;
  });
  return [
    `Paper: ${cell(paper.title)} (${cell(paper.paperTypeName)} standards)`,
    `Readiness: ${state.readiness.ready ? 'ready for committee' : `not ready — ${state.readiness.gaps.map((g) => g.text).join('; ')}`}`,
    '',
    '| # | standard | mandatory | answer | remark | AI verdict and finding |',
    '|---|----------|-----------|--------|--------|------------------------|',
    ...rows,
  ].join('\n');
}

/**
 * A typed message (FR-CHAT-03/04/05): "#N" → compare card; else the AI answers from the context.
 * @param {{user: object, paperId: string, text: string, log: import('pino').Logger}} params
 * @returns {Promise<{messages: object[]}>}
 * @throws {AppError} 429 RATE_LIMITED
 */
async function postMessage({ user, paperId, text, log }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  await assertChatLimit(user);
  const question = await chatModel.insert({ paperId, role: 'user', kind: 'text', content: { text } });
  const state = await readinessService.forPaper(paper);

  const number = standardNumberIn(text);
  if (number !== null) {
    const standard = state.standards.find((s) => s.number === number);
    const reply = standard
      ? await say(paperId, 'compare', { standardId: standard.id })
      : await say(paperId, 'text', { text: `There’s no standard #${number} — this paper type has ${state.standards.length}.` });
    return { messages: [question, reply] };
  }
  if (!state.latest) {
    const reply = await say(paperId, 'text', {
      text: 'Upload your paper PDF first (📎 or drag and drop). Then I can answer questions about it.',
    });
    return { messages: [question, reply] };
  }

  const provider = getAiProvider();
  let answer;
  try {
    const out = await provider.answerQuestion({ question: text, contextMarkdown: contextMarkdown(paper, state) });
    log.info({ paperId, provider: provider.name, model: out.model, ...out.usage }, 'Chat question answered');
    // Plain text only (FR-CHAT-06): drop anything that looks like HTML, and keep it short.
    answer = out.text.replace(/<[^>]*>/g, '').trim().slice(0, MAX_ANSWER_CHARS) || 'I could not find an answer in your paper’s data.';
  } catch (err) {
    log.error({ err, paperId, provider: provider.name }, 'Chat question failed');
    answer = 'Sorry, I could not answer that right now. Try again in a moment.';
  }
  const reply = await say(paperId, 'text', { text: answer });
  return { messages: [question, reply] };
}

module.exports = { standardNumberIn, listMessages, quickAction, postMessage, contextMarkdown };
