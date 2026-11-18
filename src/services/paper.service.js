'use strict';

/**
 * Papers for architects (FR-PAP-01…08, FR-ANS-01…15): the home page cards, create, inline edit,
 * delete, and the paper page view model. Everyone with a role may read every paper; only the owner
 * may change it (FR-ACC-08 → 403 NOT_OWNER).
 */
const paperModel = require('../models/paper.model');
const paperTypeModel = require('../models/paperType.model');
const versionModel = require('../models/paperTypeVersion.model');
const sectionModel = require('../models/section.model');
const standardModel = require('../models/standard.model');
const referenceModel = require('../models/reference.model');
const answerModel = require('../models/answer.model');
const checkModel = require('../models/check.model');
const readinessService = require('./readiness.service');
const { letterFor } = require('./paperType.service');
const { withTransaction } = require('../utils/db');
const { ConflictError, NotFoundError, NotOwnerError, ValidationError } = require('../utils/errors');

/** Cards per page on "All papers" (FR-PAP-07). */
const PAGE_SIZE = 24;

/**
 * @param {string} paperId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getPaperOrThrow(paperId) {
  const paper = await paperModel.findById(paperId);
  if (!paper) throw new NotFoundError('Paper not found.');
  return paper;
}

/**
 * The paper, if `user` owns it.
 * @returns {Promise<object>}
 * @throws {NotFoundError|NotOwnerError}
 */
async function getOwnedPaperOrThrow(paperId, user) {
  const paper = await getPaperOrThrow(paperId);
  if (paper.ownerId !== user.id) throw new NotOwnerError();
  return paper;
}

/** What a paper card shows (FR-PAP-01): the paper, its readiness and pill. */
function toCard(paper, readiness) {
  return {
    id: paper.id,
    title: paper.title,
    vendor: paper.vendor,
    paperTypeName: paper.paperTypeName,
    ownerName: paper.ownerName,
    aiChecked: paper.aiChecked,
    updatedAt: paper.updatedAt,
    readiness,
    percent: Math.round((readiness.answered / Math.max(1, readiness.total)) * 100),
  };
}

async function withReadiness(papers) {
  const readiness = await readinessService.forPapers(papers);
  return papers.map((p) => toCard(p, readiness.get(p.id)));
}

/**
 * "My papers" (FR-PAP-01): the user's papers as cards, newest change first.
 * @param {{id: string}} user
 * @returns {Promise<object[]>}
 */
async function listMine(user) {
  return withReadiness(await paperModel.listByOwner(user.id));
}

/**
 * "All papers" (FR-PAP-07): one page of cards with the owner's name.
 * @param {{search?: string, paperTypeId?: string|null, page?: number}} opts
 * @returns {Promise<{papers: object[], total: number, page: number, pages: number}>}
 */
async function listAll({ search = '', paperTypeId = null, page = 1 }) {
  const { papers, total } = await paperModel.listAll({
    search,
    paperTypeId,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return {
    papers: await withReadiness(papers),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/**
 * The paper types a new paper can use (FR-PAP-02): the newest PUBLISHED version of each type with at
 * least one standard (D-45: drafts are never offered).
 * @returns {Promise<Array<{id, versionId, versionNumber, name, description, standardsCount, mandatoryCount}>>}
 */
async function listPaperTypeOptions() {
  const types = await paperTypeModel.listWithStats({ basis: 'published' });
  return types
    .filter((t) => t.standardsCount > 0)
    .map((t) => ({
      id: t.id,
      versionId: t.versionId,
      versionNumber: t.publishedNumber,
      name: t.name,
      description: t.description,
      standardsCount: t.standardsCount,
      mandatoryCount: t.mandatoryCount,
    }));
}

/**
 * Create a paper (FR-PAP-02). The paper type is fixed from now on (FR-PAP-05); the paper is pinned
 * to the type's newest published version (D-45).
 * @param {{user: object, title: string, vendor?: string|null, paperTypeId: string, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, url: string}>}
 * @throws {ValidationError} unknown paper type or one without standards
 */
async function createPaper({ user, title, vendor = null, paperTypeId, log }) {
  const types = await listPaperTypeOptions();
  const type = types.find((t) => t.id === paperTypeId);
  if (!type) {
    throw new ValidationError('Choose a paper type.', [{ field: 'paperTypeId', message: 'Unknown paper type' }]);
  }
  const { id } = await paperModel.create({ ownerId: user.id, paperTypeId, versionId: type.versionId, title, vendor });
  log.info({ paperId: id, paperTypeId, version: type.versionNumber, userId: user.id }, 'Paper created');
  return { id, url: `/papers/${id}` };
}

/**
 * Inline edit of title / vendor (FR-PAP-03). Owner only.
 * @returns {Promise<{id, title, vendor}>}
 */
async function updatePaper({ user, paperId, title, vendor, log }) {
  await getOwnedPaperOrThrow(paperId, user);
  const updated = await paperModel.update(paperId, { title, vendor });
  log.info({ paperId, userId: user.id }, 'Paper updated');
  return updated;
}

/**
 * Soft delete (FR-PAP-04). Owner only.
 * @returns {Promise<void>}
 */
async function deletePaper({ user, paperId, log }) {
  await getOwnedPaperOrThrow(paperId, user);
  await paperModel.softDelete(paperId);
  log.info({ paperId, userId: user.id }, 'Paper deleted');
}

/**
 * Everything the paper page shows (docs/03 §3.2, docs/04 §5.1): the paper, its sections with
 * numbered standards, their references and answers, the type's references and the readiness.
 * `client` is the small state the page script needs for instant feedback (docs/04 §6).
 *
 * @param {{user: object, paperId: string}} params
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getPaperPage({ user, paperId }) {
  const paper = await getPaperOrThrow(paperId);
  const [sections, references, state] = await Promise.all([
    sectionModel.listForVersion(paper.paperTypeVersionId),
    referenceModel.listUsedByVersion(paper.paperTypeVersionId),
    readinessService.forPaper(paper),
  ]);
  const { standards, answers, readiness } = state;
  const refById = new Map(references.map((r) => [r.id, r]));

  // A section without standards has nothing to answer, so it is left out and the letters stay A, B, C…
  const sectionViews = sections
    .filter((section) => standards.some((s) => s.sectionId === section.id))
    .map((section, index) => {
      const own = standards.filter((s) => s.sectionId === section.id);
      return {
        id: section.id,
        letter: letterFor(index),
        title: section.title,
        mandatoryCount: own.filter((s) => s.isMandatory).length,
        standards: own.map((s) => ({
          id: s.id,
          number: s.number,
          title: s.title,
          descriptionHtml: s.descriptionHtml,
          isMandatory: s.isMandatory,
          references: s.referenceIds
            .map((id) => refById.get(id))
            .filter(Boolean)
            .map((r) => ({ id: r.id, type: r.type, title: r.title, note: r.note })),
          answer: answers[s.id] ?? { value: null, remark: '' },
        })),
      };
    });

  const isOwner = paper.ownerId === user.id;
  return {
    paper: {
      id: paper.id,
      title: paper.title,
      vendor: paper.vendor,
      paperTypeName: paper.paperTypeName,
      ownerName: paper.ownerName,
      updatedAt: paper.updatedAt,
      // D-45: the version the paper uses, and the newest one if it can be upgraded.
      versionNumber: paper.versionNumber,
      newerVersion: paper.latestVersionNumber > paper.versionNumber ? paper.latestVersionNumber : null,
    },
    isOwner,
    sections: sectionViews,
    references,
    readiness,
    state, // for the controller (the AI view is built from it); not passed to the template
    // The small state the page script needs; the controller adds the AI check data (check.service).
    client: {
      paperId: paper.id,
      isOwner,
      sections: sectionViews.map((s) => ({ id: s.id, letter: s.letter, title: s.title })),
      standards: state.ruleStandards,
      answers,
    },
  };
}

/** Same content as far as the architect's answer is concerned (D-45). */
const sameContent = (a, b) =>
  a.title === b.title && a.descriptionHtml === b.descriptionHtml && a.isMandatory === b.isMandatory;
/** Same content AND the same references: the AI result still holds. */
const sameForAi = (a, b) =>
  sameContent(a, b) && [...a.referenceIds].sort().join() === [...b.referenceIds].sort().join();

/**
 * Upgrade a paper to its type's newest published version (D-45, owner only). Answers to standards
 * that did not change (same title, description and mandatory flag) carry over; changed and new
 * standards start unanswered. The latest AI results carry over where the references are also the
 * same. Answers to the old version stay stored but are no longer shown (like FR-ANS-15).
 *
 * @param {{user: object, paperId: string, log: import('pino').Logger}} params
 * @returns {Promise<{version: number, carried: number, unanswered: number}>}
 * @throws {ConflictError} UP_TO_DATE, CHECK_RUNNING
 */
async function upgradePaper({ user, paperId, log }) {
  const paper = await getOwnedPaperOrThrow(paperId, user);
  const latest = await versionModel.findLatestPublished(paper.paperTypeId);
  if (!latest || latest.id === paper.paperTypeVersionId || latest.number < paper.versionNumber) {
    throw new ConflictError('This paper already uses the newest version.', 'UP_TO_DATE');
  }
  if (await checkModel.findActiveCheck(paperId)) {
    throw new ConflictError('Wait for the AI check to finish, then upgrade.', 'CHECK_RUNNING');
  }
  const [oldStandards, newStandards, lastCheck] = await Promise.all([
    standardModel.listForVersion(paper.paperTypeVersionId),
    standardModel.listForVersion(latest.id),
    checkModel.findLatestDone(paperId),
  ]);
  const oldByLineage = new Map(oldStandards.map((s) => [s.lineageId, s]));
  const answerPairs = [];
  const resultPairs = [];
  for (const s of newStandards) {
    const old = oldByLineage.get(s.lineageId);
    if (!old || !sameContent(old, s)) continue;
    answerPairs.push({ oldId: old.id, newId: s.id });
    if (sameForAi(old, s)) resultPairs.push({ oldId: old.id, newId: s.id });
  }
  const carried = await withTransaction(async () => {
    const n = await answerModel.copyToStandards(paperId, answerPairs);
    if (lastCheck) await checkModel.copyResultsToStandards(lastCheck.id, resultPairs);
    await paperModel.setVersion(paperId, latest.id);
    return n;
  });
  log.info(
    { paperId, from: paper.versionNumber, to: latest.number, carried, unchanged: answerPairs.length },
    'Paper upgraded',
  );
  return { version: latest.number, carried, unanswered: newStandards.length - carried };
}

module.exports = {
  PAGE_SIZE,
  upgradePaper,
  getPaperOrThrow,
  getOwnedPaperOrThrow,
  listMine,
  listAll,
  listPaperTypeOptions,
  createPaper,
  updatePaper,
  deletePaper,
  getPaperPage,
};
