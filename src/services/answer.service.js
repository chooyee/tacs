'use strict';

/**
 * Saving one answer (FR-ANS-04…07, docs/04 §5.2). The browser always sends the whole answer
 * (value + remark), so the PUT is idempotent. The response carries the new readiness and the
 * section's status, which overwrite the browser's own guess.
 */
const answerModel = require('../models/answer.model');
const paperModel = require('../models/paper.model');
const standardModel = require('../models/standard.model');
const paperService = require('./paper.service');
const readinessService = require('./readiness.service');
const rules = require('../utils/readinessRules');
const { withTransaction } = require('../utils/db');
const { NotFoundError } = require('../utils/errors');

/**
 * Save the whole answer of one standard. Used by the PUT and by "Use AI answer" / "Fill".
 * @param {{paper: object, standardId: string, value: string|null, remark: string}} params
 * @returns {Promise<object>} the saved answer
 */
async function writeAnswer({ paper, standardId, value, remark }) {
  return withTransaction(async () => {
    const saved = await answerModel.upsert({ paperId: paper.id, standardId, value, remark });
    await paperModel.touch(paper.id); // "newest change first" on the home page
    return saved;
  });
}

/**
 * The paper's readiness and one section's status after a change.
 * @param {object} paper
 * @param {string|null} sectionId
 * @param {object[]} [standards]  the type's standards, when already loaded
 * @returns {Promise<{readiness: object, sectionStatus: object|null}>}
 */
async function stateAfterChange(paper, sectionId, standards) {
  const state = await readinessService.forPaper(paper, { standards });
  const inSection = state.ruleStandards.filter((s) => s.sectionId === sectionId);
  return {
    readiness: state.readiness,
    sectionStatus: sectionId
      ? { sectionId, ...rules.sectionStatus(inSection, state.answers, state.results, state.kept) }
      : null,
  };
}

/**
 * @param {{user: object, paperId: string, standardId: string, value: 'yes'|'no'|'na'|null,
 *   remark: string, log: import('pino').Logger}} params
 * @returns {Promise<{answer: object, sectionStatus: object, readiness: object}>}
 * @throws {NotFoundError} the standard is not (or no longer) part of this paper's type
 * @throws {NotOwnerError}
 */
async function saveAnswer({ user, paperId, standardId, value, remark, log }) {
  const paper = await paperService.getOwnedPaperOrThrow(paperId, user);
  const standards = await standardModel.listForType(paper.paperTypeId);
  const standard = standards.find((s) => s.id === standardId);
  if (!standard) throw new NotFoundError('This standard is not part of the paper type.', 'STANDARD_NOT_FOUND');

  const answer = await writeAnswer({ paper, standardId, value, remark });
  // Never log the remark (docs/09: no user text in logs).
  log.info({ paperId, standardId, value, hasRemark: Boolean(remark.trim()) }, 'Answer saved');
  return { answer, ...(await stateAfterChange(paper, standard.sectionId, standards)) };
}

module.exports = { writeAnswer, stateAfterChange, saveAnswer };
