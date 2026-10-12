'use strict';

/**
 * Sections of a paper type: add, rename, move, delete with Undo (FR-ADM-14, FR-ADM-18, FR-ADM-19).
 */
const sectionModel = require('../models/section.model');
const paperTypeModel = require('../models/paperType.model');
const { withTransaction } = require('../utils/db');
const { ConflictError, NotFoundError } = require('../utils/errors');

/**
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getSectionOrThrow(id, opts) {
  const section = await sectionModel.findById(id, opts);
  if (!section) throw new NotFoundError('Section not found.');
  return section;
}

/**
 * Add a section at the end ("New section" by default, FR-ADM-14).
 * @param {{typeId: string, title: string, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function addSection({ typeId, title, log }) {
  if (!(await paperTypeModel.findById(typeId))) throw new NotFoundError('Paper type not found.');
  const section = await sectionModel.create(typeId, title);
  log.info({ paperTypeId: typeId, sectionId: section.id }, 'Section added');
  return section;
}

/**
 * @param {{sectionId: string, title: string, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function renameSection({ sectionId, title, log }) {
  await getSectionOrThrow(sectionId);
  const section = await sectionModel.updateTitle(sectionId, title);
  log.info({ sectionId }, 'Section renamed');
  return section;
}

/**
 * Swap with the neighbour above / below (FR-ADM-19).
 * @param {{sectionId: string, direction: 'up'|'down', log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} CANNOT_MOVE at the top / bottom
 */
async function moveSection({ sectionId, direction, log }) {
  await withTransaction(async () => {
    const section = await getSectionOrThrow(sectionId);
    const neighbour = await sectionModel.findNeighbour(section, direction);
    if (!neighbour)
      throw new ConflictError(
        `This section is already at the ${direction === 'up' ? 'top' : 'bottom'}.`,
        'CANNOT_MOVE',
      );
    await sectionModel.swapPositions(section, neighbour);
  });
  log.info({ sectionId, direction }, 'Section moved');
}

/**
 * Soft delete a section with its standards (FR-ADM-18).
 * @param {{sectionId: string, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 */
async function deleteSection({ sectionId, log }) {
  await getSectionOrThrow(sectionId);
  await withTransaction(() => sectionModel.softDeleteWithStandards(sectionId));
  log.info({ sectionId }, 'Section deleted');
}

/**
 * Undo deleteSection: the section and the standards deleted with it come back.
 * @param {{sectionId: string, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED
 */
async function restoreSection({ sectionId, log }) {
  const section = await getSectionOrThrow(sectionId, { includeDeleted: true });
  if (!section.deletedAt) throw new ConflictError('This section is not deleted.', 'NOT_DELETED');
  await withTransaction(() => sectionModel.restoreWithStandards(sectionId));
  log.info({ sectionId }, 'Section restored');
}

module.exports = { addSection, renameSection, moveSection, deleteSection, restoreSection };
