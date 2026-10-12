'use strict';

/**
 * Standards: add, edit (text, mandatory, linked references), move, delete with Undo
 * (FR-ADM-15…19, FR-ADM-21). Changes apply immediately to every paper of the type (D-12).
 */
const standardModel = require('../models/standard.model');
const sectionModel = require('../models/section.model');
const referenceModel = require('../models/reference.model');
const { withTransaction } = require('../utils/db');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

/** AI providers limit documents per request (docs/07 §5), so warn above this (FR-ADM-21). */
const MAX_REFERENCES_BEFORE_WARNING = 4;

/**
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getStandardOrThrow(id, opts) {
  const standard = await standardModel.findById(id, opts);
  if (!standard) throw new NotFoundError('Standard not found.');
  return standard;
}

/**
 * Add an optional standard without references at the end of a section (FR-ADM-16).
 * @param {{sectionId: string, text: string, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function addStandard({ sectionId, text, log }) {
  if (!(await sectionModel.findById(sectionId))) throw new NotFoundError('Section not found.');
  const standard = await standardModel.create(sectionId, text);
  log.info({ sectionId, standardId: standard.id }, 'Standard added');
  return standard;
}

/**
 * Edit a standard (FR-ADM-15 toggle, FR-ADM-17 dialog). `referenceIds` replaces the whole link set;
 * every ID must be a reference of the same paper type (docs/06 §4).
 *
 * @param {{standardId: string, text?: string, isMandatory?: boolean, referenceIds?: string[],
 *          log: import('pino').Logger}} params
 * @returns {Promise<{standard: object, warnings: string[]}>}
 * @throws {ValidationError} a reference from another type
 */
async function updateStandard({ standardId, text, isMandatory, referenceIds, log }) {
  const current = await getStandardOrThrow(standardId);
  const ids = referenceIds && [...new Set(referenceIds)];
  if (ids?.length) {
    const valid = await referenceModel.countInType(current.paperTypeId, ids);
    if (valid !== ids.length) {
      throw new ValidationError('Link only references of this paper type.', [
        { field: 'referenceIds', message: 'Unknown reference' },
      ]);
    }
  }
  const standard = await withTransaction(async () => {
    const updated = await standardModel.update(standardId, { text, isMandatory });
    if (ids) await standardModel.setReferences(standardId, ids);
    return updated;
  });
  const warnings =
    ids && ids.length > MAX_REFERENCES_BEFORE_WARNING
      ? [
          `This standard links ${ids.length} references. The AI checker reads at most ${MAX_REFERENCES_BEFORE_WARNING} per standard well; consider fewer.`,
        ]
      : [];
  log.info({ standardId, isMandatory: standard.isMandatory, references: ids?.length }, 'Standard updated');
  return { standard, warnings };
}

/**
 * @param {{standardId: string, direction: 'up'|'down', log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} CANNOT_MOVE
 */
async function moveStandard({ standardId, direction, log }) {
  await withTransaction(async () => {
    const standard = await getStandardOrThrow(standardId);
    const neighbour = await standardModel.findNeighbour(standard, direction);
    if (!neighbour) {
      throw new ConflictError(
        `This standard is already at the ${direction === 'up' ? 'top' : 'bottom'}.`,
        'CANNOT_MOVE',
      );
    }
    await standardModel.swapPositions(standard, neighbour);
  });
  log.info({ standardId, direction }, 'Standard moved');
}

/**
 * Soft delete (FR-ADM-18). Answers to it are kept but hidden on papers (FR-ANS-15).
 * @returns {Promise<void>}
 */
async function deleteStandard({ standardId, log }) {
  await getStandardOrThrow(standardId);
  await standardModel.softDelete(standardId);
  log.info({ standardId }, 'Standard deleted');
}

/**
 * Undo deleteStandard.
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED, or SECTION_DELETED when its section is gone (restore that first)
 */
async function restoreStandard({ standardId, log }) {
  const standard = await getStandardOrThrow(standardId, { includeDeleted: true });
  if (!standard.deletedAt) throw new ConflictError('This standard is not deleted.', 'NOT_DELETED');
  if (standard.sectionDeleted) {
    throw new ConflictError('Its section was deleted. Restore the section first.', 'SECTION_DELETED');
  }
  await standardModel.restore(standardId);
  log.info({ standardId }, 'Standard restored');
}

module.exports = {
  MAX_REFERENCES_BEFORE_WARNING,
  addStandard,
  updateStandard,
  moveStandard,
  deleteStandard,
  restoreStandard,
};
