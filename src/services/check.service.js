'use strict';

/**
 * AI paper checks (FR-AI-02…18, docs/04 §7, docs/07): upload → queued check → the worker runs it
 * section by section → validated results. Plus the actions on results: Use AI answer, Keep mine,
 * Fill unanswered. Only the paper's owner may start or act (FR-AI-18); everyone may read.
 */
const { randomUUID } = require('node:crypto');
const config = require('../config');
const checkModel = require('../models/check.model');
const chatModel = require('../models/chat.model');
const paperModel = require('../models/paper.model');
const sectionModel = require('../models/section.model');
const standardModel = require('../models/standard.model');
const referenceModel = require('../models/reference.model');
const paperService = require('./paper.service');
const answerService = require('./answer.service');
const readinessService = require('./readiness.service');
const rules = require('../utils/readinessRules');
const { getStorage } = require('../factories/storageFactory');
const { getAiProvider } = require('../factories/aiProviderFactory');
const { compareResponseSchema } = require('../ai/schemas/compareResult');
const { detectFileType, inspectPdf } = require('../utils/pdfInfo');
const { withTransaction } = require('../utils/db');
const {
  AppError,
  ConflictError,
  FileRejectedError,
  NotFoundError,
  ValidationError,
} = require('../utils/errors');

const TOTAL_STEPS = 4;
const MAX_FILES = 3;
// Priority when a standard links more references than one request can carry (docs/07 §5).
const TYPE_PRIORITY = { Sample: 0, Policy: 1, Template: 2, Guide: 3 };

/** What the user reads when a check fails (FR-AI-14); the technical error is only logged. */
const FRIENDLY_FAILURES = {
  AI_TIMEOUT: 'the AI took too long to answer',
  AI_RATE_LIMITED: 'the AI service is busy right now',
  AI_UNAVAILABLE: 'the AI service is not available right now',
  AI_BAD_REQUEST: 'the AI service could not read the files',
  AI_INVALID_RESPONSE: 'the AI gave an answer we could not use',
  CHECK_TIMEOUT: 'the check took too long',
  FILE_MISSING: 'an uploaded file is no longer available — upload it again',
  INTERNAL_ERROR: 'something went wrong on our side',
};

/* ---------- Upload and queue ---------- */

/** Keep only the base name, without path parts or control characters, for display. */
function displayName(name) {
  const base = String(name || 'paper.pdf').split(/[\\/]/).pop();
  return [...base].filter((ch) => ch.charCodeAt(0) >= 32).join('').slice(0, 200) || 'paper.pdf';
}

/**
 * Reject a new check while one runs, and more than RATE_LIMIT_CHECKS_PER_HOUR per user (docs/07 §9).
 * @throws {ConflictError} CHECK_RUNNING
 * @throws {AppError} 429 RATE_LIMITED
 */
async function assertCanStart(paperId, user) {
  if (await checkModel.findActiveCheck(paperId)) {
    throw new ConflictError('A check is already running.', 'CHECK_RUNNING');
  }
  const since = new Date(Date.now() - 60 * 60 * 1000);
  if ((await checkModel.countByUserSince(user.id, since)) >= config.checks.rateLimitPerHour) {
    throw new AppError('You have started many checks in the last hour. Please wait a little and try again.', {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
}

/**
 * Upload 1–3 PDFs and start a check (FR-AI-02/03/05). Non-PDF files are skipped and named in the
 * chat; encrypted or damaged PDFs stop the upload with a clear message.
 *
 * @param {{user: object, paperId: string, files: Array<{buffer: Buffer, originalname: string, size: number}>,
 *   log: import('pino').Logger}} params
 * @returns {Promise<{checkId: string, status: string, skipped: string[]}>}
 */
async function uploadAndCheck({ user, paperId, files = [], log }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  if (!files.length) throw new ValidationError('Attach your paper as a PDF.', [{ field: 'files', message: 'Required' }]);
  if (files.length > MAX_FILES) {
    throw new ValidationError(`Attach at most ${MAX_FILES} PDF files.`, [{ field: 'files', message: 'Too many' }]);
  }
  await assertCanStart(paperId, user);

  const pdfs = files.filter((f) => detectFileType(f.buffer) === 'application/pdf');
  const skipped = files.filter((f) => !pdfs.includes(f)).map((f) => displayName(f.originalname));
  if (!pdfs.length) {
    throw new FileRejectedError(`Only PDF files can be checked. Skipped: ${skipped.join(', ')}.`, 415, 'FILE_TYPE');
  }
  const inspected = [];
  for (const file of pdfs) {
    try {
      inspected.push({ file, ...(await inspectPdf(file.buffer)) });
    } catch (err) {
      err.message = `${displayName(file.originalname)}: ${err.message}`;
      throw err;
    }
  }
  const pages = inspected.reduce((sum, d) => sum + d.pageCount, 0);
  if (pages > config.uploads.maxPages) {
    throw new FileRejectedError(
      `Your files have ${pages} pages together. The limit is ${config.uploads.maxPages}.`,
      413,
      'TOO_MANY_PAGES',
    );
  }

  // Files first, then the rows; a failed save removes what was uploaded.
  const docs = inspected.map(({ file, pageCount }) => {
    const id = randomUUID();
    return {
      id,
      s3Key: `papers/${paperId}/${id}.pdf`,
      fileName: displayName(file.originalname),
      sizeBytes: file.size,
      pageCount,
      buffer: file.buffer,
    };
  });
  await Promise.all(docs.map((d) => getStorage().put(d.s3Key, d.buffer, { contentType: 'application/pdf' })));
  let check;
  try {
    check = await withTransaction(async () => {
      await checkModel.replaceCurrentDocuments(paperId, docs);
      const created = await checkModel.createCheck({ paperId, requestedBy: user.id, documentIds: docs.map((d) => d.id) });
      await chatModel.insert({
        paperId,
        role: 'user',
        kind: 'files',
        content: { files: docs.map((d) => ({ name: d.fileName, pageCount: d.pageCount })), skipped },
      });
      await paperModel.touch(paper.id);
      return created;
    });
  } catch (err) {
    await Promise.all(docs.map((d) => getStorage().remove(d.s3Key).catch(() => {})));
    throw err;
  }
  log.info({ paperId, checkId: check.id, files: docs.length, pages, skipped: skipped.length }, 'Check queued');
  return { checkId: check.id, status: check.status, skipped };
}

/**
 * Re-check the current documents (FR-AI-13).
 * @returns {Promise<{checkId: string, status: string}>}
 * @throws {ConflictError} NO_DOCUMENTS when the PDFs were removed (FR-AI-17)
 */
async function recheck({ user, paperId, log }) {
  await paperService.getOwnedPaperOrThrow(paperId, user);
  const docs = await checkModel.listCurrentDocuments(paperId);
  if (!docs.length) {
    throw new ConflictError('Your PDF was removed after 7 days. Upload it again to check it.', 'NO_DOCUMENTS');
  }
  await assertCanStart(paperId, user);
  const check = await checkModel.createCheck({ paperId, requestedBy: user.id, documentIds: docs.map((d) => d.id) });
  log.info({ paperId, checkId: check.id }, 'Re-check queued');
  return { checkId: check.id, status: check.status };
}

/* ---------- Status (polled by the chat every 2 s) ---------- */

/**
 * The step labels with real numbers (FR-AI-3).
 * @returns {Promise<string[]>}
 */
async function stepLabels(check) {
  const [docs, paper] = await Promise.all([checkModel.listCheckDocuments(check.id), paperModel.findById(check.paperId)]);
  const standards = paper ? await standardModel.listForType(paper.paperTypeId) : [];
  const refIds = new Set(standards.flatMap((s) => s.referenceIds));
  const pages = docs.reduce((sum, d) => sum + d.pageCount, 0);
  return [
    `Reading your PDF (${pages} page${pages === 1 ? '' : 's'})`,
    'Reading text, diagrams and tables',
    `Comparing with ${refIds.size} polic${refIds.size === 1 ? 'y' : 'ies'} & samples`,
    `Checking ${standards.length} standards`,
  ];
}

/**
 * GET /api/checks/:checkId — cheap status for polling.
 * @param {string} checkId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getStatus(checkId) {
  const check = await checkModel.findCheck(checkId);
  if (!check) throw new NotFoundError('Check not found.');
  return {
    id: check.id,
    paperId: check.paperId,
    status: check.status,
    step: check.step,
    totalSteps: TOTAL_STEPS,
    stepLabels: await stepLabels(check),
    ...(check.status === 'failed' && { errorMessage: friendlyFailure(check.errorCode) }),
  };
}

/** "The check couldn't finish: <reason>. Try again." (FR-AI-14) */
function friendlyFailure(code) {
  return `The check couldn’t finish: ${FRIENDLY_FAILURES[code] ?? FRIENDLY_FAILURES.INTERNAL_ERROR}. Try again.`;
}

/* ---------- Latest results (drive the AI lines and readiness) ---------- */

/**
 * The latest completed check with its results and the current issues (docs/06 §3), or null.
 * Also says whether the standards changed since (FR-AI-15) and whether the PDFs still exist (FR-AI-17).
 * @param {{paperId: string}} params
 * @returns {Promise<object|null>}
 */
async function getLatest({ paperId }) {
  const paper = await paperService.getPaperOrThrow(paperId);
  const state = await readinessService.forPaper(paper);
  return latestView(state);
}

/** Build the latest-check view from a readinessService.forPaper() state. */
function latestView(state) {
  const { latest, resultRows, answers, standards } = state;
  if (!latest) return null;
  const byId = new Map(standards.map((s) => [s.id, s]));
  const counts = { comply: 0, partial: 0, gap: 0, none: 0 };
  const results = resultRows
    .filter((r) => byId.has(r.standardId)) // standards deleted since are hidden (FR-ANS-15)
    .map((r) => {
      counts[r.verdict] += 1;
      const standard = byId.get(r.standardId);
      const issue = rules.aiIssue(answers[r.standardId], r, standard, Boolean(r.keptByUserAt));
      return {
        standardId: r.standardId,
        verdict: r.verdict,
        page: r.page,
        documentId: r.documentId,
        area: r.area,
        bbox: r.bbox,
        finding: r.finding,
        referenceId: r.referenceId,
        referencePage: r.referencePage,
        issue: issue && { level: issue.level, message: rules.ISSUE_MESSAGES[issue.messageKey] },
        kept: Boolean(r.keptByUserAt),
        suggested: rules.aiAnswerFor(r.verdict),
      };
    });
  const snapshotIds = new Set((latest.standardsSnapshot ?? []).map((s) => s.id));
  return {
    check: {
      id: latest.id,
      finishedAt: latest.finishedAt,
      provider: latest.provider,
      model: latest.model,
      documents: latest.documents,
      pdfsAvailable: latest.documents.length > 0,
    },
    counts,
    results,
    standardsChanged: standards.some((s) => !snapshotIds.has(s.id)) || snapshotIds.size !== standards.length,
  };
}

/* ---------- Actions on results (owner only) ---------- */

/** The citation "[Paper p.N vs <reference title>]" (FR-AI-09). */
async function citation(result) {
  const ref = result.referenceId ? await referenceModel.findById(result.referenceId) : null;
  const page = result.page ? `Paper p.${result.page}` : 'Paper';
  return ref ? `[${page} vs ${ref.title}]` : `[${page}]`;
}

/** The answer "Use AI answer" writes (FR-AI-09). */
async function aiAnswer(result) {
  const cite = await citation(result);
  return {
    value: rules.aiAnswerFor(result.verdict),
    remark: (result.verdict === 'comply' ? cite : `${result.finding} ${cite}`).slice(0, 2000),
  };
}

async function ownedStateWithResult({ user, paperId, standardId }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  const state = await readinessService.forPaper(paper);
  const result = state.resultRows.find((r) => r.standardId === standardId);
  const standard = state.standards.find((s) => s.id === standardId);
  if (!state.latest || !result || !standard) throw new NotFoundError('There is no AI result for this standard.', 'NO_RESULT');
  return { paper, state, result, standard };
}

/**
 * Use AI answer (FR-AI-09): set the answer to the AI's suggestion and fill the remark.
 * @returns {Promise<{answer: object, readiness: object, sectionStatus: object, latest: object}>}
 */
async function applyResult({ user, paperId, standardId, log }) {
  const { paper, result, standard } = await ownedStateWithResult({ user, paperId, standardId });
  const answer = await answerService.writeAnswer({ paper, standardId, ...(await aiAnswer(result)) });
  log.info({ paperId, standardId, verdict: result.verdict }, 'AI answer applied');
  const after = await answerService.stateAfterChange(paper, standard.sectionId);
  return { answer, ...after, latest: await getLatest({ paperId }) };
}

/**
 * Keep mine (FR-AI-10): resolve the issue for this check.
 * @returns {Promise<{readiness: object, sectionStatus: object, latest: object}>}
 */
async function keepAnswer({ user, paperId, standardId, log }) {
  const { paper, state, standard } = await ownedStateWithResult({ user, paperId, standardId });
  await checkModel.keep(state.latest.id, standardId);
  log.info({ paperId, standardId }, 'AI issue kept');
  const after = await answerService.stateAfterChange(paper, standard.sectionId);
  return { ...after, latest: await getLatest({ paperId }) };
}

/**
 * Fill my unanswered standards from this check (FR-AI-12): Use AI answer on unanswered ones only.
 * @returns {Promise<{filled: number, answers: object, readiness: object, latest: object}>}
 */
async function applyUnanswered({ user, paperId, log }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  const state = await readinessService.forPaper(paper);
  if (!state.latest) throw new NotFoundError('There is no completed check yet.', 'NO_RESULT');
  const visible = new Set(state.standards.map((s) => s.id));
  const todo = state.resultRows.filter((r) => visible.has(r.standardId) && !state.answers[r.standardId]?.value);
  for (const result of todo) {
    await answerService.writeAnswer({ paper, standardId: result.standardId, ...(await aiAnswer(result)) });
  }
  log.info({ paperId, filled: todo.length }, 'Unanswered standards filled from the AI check');
  const after = await readinessService.forPaper(paper);
  return { filled: todo.length, answers: after.answers, readiness: after.readiness, latest: latestView(after) };
}

/* ---------- Running a check (the worker) ---------- */

async function readFile(key) {
  const file = await getStorage().get(key);
  if (!file) throw new AppError('A file of this check is missing.', { code: 'FILE_MISSING' });
  const chunks = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Split one section's standards into requests that carry at most `maxRefs` reference files each
 * (docs/07 §5). A standard with too many references keeps the most useful ones.
 * @returns {Array<{standards: object[], referenceIds: string[]}>}
 */
function batchesFor(standards, refById, maxRefs, log) {
  const batches = [];
  let current = { standards: [], referenceIds: new Set() };
  for (const s of standards) {
    let refs = s.referenceIds.filter((id) => refById.has(id));
    if (refs.length > maxRefs) {
      refs = refs.sort((a, b) => TYPE_PRIORITY[refById.get(a).type] - TYPE_PRIORITY[refById.get(b).type]).slice(0, maxRefs);
      log.warn({ standardId: s.id, kept: maxRefs }, 'Standard links more references than one AI request can carry');
    }
    const union = new Set([...current.referenceIds, ...refs]);
    if (current.standards.length && union.size > maxRefs) {
      batches.push(current);
      current = { standards: [], referenceIds: new Set() };
    }
    current.standards.push({ ...s, usedReferenceIds: refs });
    for (const id of refs) current.referenceIds.add(id);
  }
  if (current.standards.length) batches.push(current);
  return batches.map((b) => ({ standards: b.standards, referenceIds: [...b.referenceIds] }));
}

/** Parse and validate the AI's JSON; one repair attempt with the errors (docs/07 §6.4). */
async function compareWithRepair(provider, input) {
  const tryParse = (raw) => {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return { error: 'the answer was not valid JSON' };
      }
    }
    const parsed = compareResponseSchema.safeParse(data);
    return parsed.success
      ? { data: parsed.data }
      : { error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  };
  const first = await provider.compareSection(input);
  let outcome = tryParse(first.raw);
  let usage = first.usage;
  if (outcome.error) {
    const second = await provider.compareSection({ ...input, repairNote: outcome.error });
    outcome = tryParse(second.raw);
    usage = { inputTokens: usage.inputTokens + second.usage.inputTokens, outputTokens: usage.outputTokens + second.usage.outputTokens };
    if (outcome.error) throw new AppError('The AI returned invalid results twice.', { code: 'AI_INVALID_RESPONSE' });
  }
  return { results: outcome.data.results, usage, model: first.model, promptVersion: first.promptVersion };
}

/** Plain text: no HTML tags, at most 300 characters (docs/07 §4 post-processing). */
const cleanFinding = (text) => text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || '—';

/**
 * Run one claimed check from start to finish. Never throws: a failure is saved on the check and
 * posted in the chat (FR-AI-14).
 * @param {{id: string, paperId: string}} claimed
 * @param {import('pino').Logger} parentLog
 * @returns {Promise<void>}
 */
async function runCheck(claimed, parentLog) {
  const log = parentLog.child({ checkId: claimed.id, paperId: claimed.paperId });
  const provider = getAiProvider();
  const started = Date.now();
  try {
    const paper = await paperModel.findById(claimed.paperId);
    if (!paper) throw new AppError('The paper was deleted.', { code: 'INTERNAL_ERROR' });

    // Step 1: read the PDFs
    const docs = await checkModel.listCheckDocuments(claimed.id);
    if (!docs.length) throw new AppError('No documents.', { code: 'FILE_MISSING' });
    const paperFiles = await Promise.all(
      docs.map(async (d, i) => ({
        key: `P${i + 1}`,
        id: d.id,
        name: d.fileName,
        mimeType: 'application/pdf',
        pageCount: d.pageCount,
        bytes: await readFile(d.s3Key),
      })),
    );

    // Step 2: what to compare — standards by section and the references they link
    await checkModel.setStep(claimed.id, 2);
    const [sections, standards] = await Promise.all([
      sectionModel.listForType(paper.paperTypeId),
      standardModel.listForType(paper.paperTypeId),
    ]);
    const refIds = [...new Set(standards.flatMap((s) => s.referenceIds))];
    const refs = (await Promise.all(refIds.map((id) => referenceModel.findById(id)))).filter(Boolean);
    const refById = new Map(refs.map((r) => [r.id, r]));
    const refKey = new Map(refs.map((r, i) => [r.id, `R${i + 1}`]));
    const refBytes = new Map();

    // Step 3: one request per section (or smaller batches), in order
    await checkModel.setStep(claimed.id, 3);
    const maxRefs = Math.max(1, config.ai.maxDocsPerRequest - paperFiles.length);
    const raw = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let model = provider.model;
    let promptVersion = null;
    let batchNo = 0;
    for (const section of sections) {
      const own = standards.filter((s) => s.sectionId === section.id);
      for (const batch of batchesFor(own, refById, maxRefs, log)) {
        batchNo += 1;
        for (const id of batch.referenceIds) {
          if (!refBytes.has(id)) refBytes.set(id, await readFile(refById.get(id).s3Key));
        }
        const input = {
          paperTypeName: paper.paperTypeName,
          paperFiles,
          standards: batch.standards.map((s) => ({
            key: `S${s.number}`,
            number: s.number,
            text: s.title,
            mandatory: s.isMandatory,
            referenceKeys: s.usedReferenceIds.map((id) => refKey.get(id)),
          })),
          references: batch.referenceIds.map((id) => {
            const r = refById.get(id);
            return { key: refKey.get(id), name: r.fileName, mimeType: r.mimeType, bytes: refBytes.get(id), type: r.type, title: r.title, note: r.note ?? '' };
          }),
        };
        const batchStart = Date.now();
        const out = await compareWithRepair(provider, input);
        usage = { inputTokens: usage.inputTokens + out.usage.inputTokens, outputTokens: usage.outputTokens + out.usage.outputTokens };
        model = out.model;
        promptVersion = out.promptVersion;
        log.info(
          { batch: batchNo, standards: input.standards.length, references: input.references.length, ms: Date.now() - batchStart, ...out.usage },
          'AI batch done',
        );
        raw.push({ keys: new Set(input.standards.map((s) => s.key)), results: out.results });
      }
    }

    // Step 4: post-process, map keys back to IDs and save (docs/07 §4)
    await checkModel.setStep(claimed.id, 4);
    const byKey = new Map(standards.map((s) => [`S${s.number}`, s]));
    const docByKey = new Map(paperFiles.map((f) => [f.key, f]));
    const refByKey = new Map(refs.map((r) => [refKey.get(r.id), r]));
    const rows = new Map();
    for (const { keys, results } of raw) {
      for (const r of results) {
        if (!keys.has(r.standardKey) || rows.has(r.standardKey)) {
          log.warn({ standardKey: r.standardKey }, 'AI returned a result for a standard it was not asked about');
          continue;
        }
        const doc = r.fileKey ? docByKey.get(r.fileKey) : paperFiles.length === 1 && r.page ? paperFiles[0] : null;
        const page = doc && r.page && r.page <= doc.pageCount ? r.page : null;
        const ref = r.referenceKey ? refByKey.get(r.referenceKey) : null;
        rows.set(r.standardKey, {
          standardId: byKey.get(r.standardKey).id,
          verdict: r.verdict,
          page,
          documentId: page ? doc.id : null,
          area: page ? r.area : null,
          bbox: page ? (r.bbox ?? null) : null,
          finding: cleanFinding(r.finding),
          referenceId: ref?.id ?? null,
          referencePage: ref && r.referencePage && (!ref.pageCount || r.referencePage <= ref.pageCount) ? r.referencePage : null,
          confidence: r.confidence ?? null,
        });
      }
    }
    for (const s of standards) {
      if (!rows.has(`S${s.number}`)) {
        log.warn({ standardId: s.id }, 'AI returned no result for a standard');
        rows.set(`S${s.number}`, {
          standardId: s.id,
          verdict: 'none',
          page: null,
          documentId: null,
          area: null,
          bbox: null,
          finding: 'The AI did not return a result for this standard.',
          referenceId: null,
          referencePage: null,
          confidence: null,
        });
      }
    }
    const counts = { comply: 0, partial: 0, gap: 0, none: 0 };
    for (const r of rows.values()) counts[r.verdict] += 1;
    await withTransaction(async () => {
      await checkModel.complete(
        claimed.id,
        {
          provider: provider.name,
          model,
          promptVersion,
          snapshot: standards.map((s) => ({ id: s.id, number: s.number })),
          ...usage,
        },
        [...rows.values()],
      );
      await chatModel.insert({ paperId: paper.id, role: 'assistant', kind: 'report', content: { checkId: claimed.id, counts } });
    });
    log.info({ provider: provider.name, model, ms: Date.now() - started, ...usage, ...counts }, 'Check done');
  } catch (err) {
    const code = FRIENDLY_FAILURES[err.code] ? err.code : 'INTERNAL_ERROR';
    log.error({ err, code, provider: provider.name, ms: Date.now() - started }, 'Check failed');
    await checkModel.fail(claimed.id, { code, message: friendlyFailure(code), provider: provider.name, model: provider.model }).catch((e) =>
      log.error({ err: e }, 'Could not mark the check failed'),
    );
    await chatModel
      .insert({ paperId: claimed.paperId, role: 'assistant', kind: 'error', content: { checkId: claimed.id, message: friendlyFailure(code) } })
      .catch((e) => log.error({ err: e }, 'Could not post the failure in the chat'));
  }
}

/**
 * Mark checks of a crashed instance failed and tell the user (docs/04 §7 rule 4).
 * @param {import('pino').Logger} log
 * @returns {Promise<number>}
 */
async function failStuckChecks(log) {
  const stuck = await checkModel.failStuck(config.checks.timeoutMs);
  for (const c of stuck) {
    log.warn({ checkId: c.id, paperId: c.paperId }, 'Check timed out and was marked failed');
    await chatModel
      .insert({ paperId: c.paperId, role: 'assistant', kind: 'error', content: { checkId: c.id, message: friendlyFailure('CHECK_TIMEOUT') } })
      .catch(() => {});
  }
  return stuck.length;
}

/**
 * The active (queued / running) check of a paper, for the page to resume polling (FR-AI-04).
 * @param {string} paperId
 * @returns {Promise<{id: string, status: string}|null>}
 */
async function getActive(paperId) {
  const check = await checkModel.findActiveCheck(paperId);
  return check ? { id: check.id, status: check.status } : null;
}

module.exports = {
  TOTAL_STEPS,
  friendlyFailure,
  uploadAndCheck,
  recheck,
  getStatus,
  getLatest,
  latestView,
  getActive,
  applyResult,
  keepAnswer,
  applyUnanswered,
  runCheck,
  failStuckChecks,
  batchesFor,
};
