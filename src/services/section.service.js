'use strict';

/**
 * Sections of a paper type: add, rename, move (buttons or drag and drop), delete with Undo
 * (FR-ADM-14, FR-ADM-18, FR-ADM-19). Every change records who made it (D-37).
 */
const sectionModel = require('../models/section.model');
const paperTypeModel = require('../models/paperType.model');
const { withTransaction } = require('../utils/db');
const { actorName } = require('../utils/actor');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

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
 * @param {{typeId: string, title: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function addSection({ typeId, title, actor, log }) {
  if (!(await paperTypeModel.findById(typeId))) throw new NotFoundError('Paper type not found.');
  const by = actorName(actor);
  const section = await withTransaction(async () => {
    const created = await sectionModel.create(typeId, title, by);
    await paperTypeModel.touch(typeId, by);
    return created;
  });
  log.info({ paperTypeId: typeId, sectionId: section.id }, 'Section added');
  return section;
}

/**
 * @param {{sectionId: string, title: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function renameSection({ sectionId, title, actor, log }) {
  const current = await getSectionOrThrow(sectionId);
  const by = actorName(actor);
  const section = await sectionModel.updateTitle(sectionId, title, by);
  await paperTypeModel.touch(current.paperTypeId, by);
  log.info({ sectionId }, 'Section renamed');
  return section;
}

/**
 * Put all sections of a type in a new order (drag and drop, or up / down). `orderedIds` must list
 * every visible section of the type exactly once.
 * @param {{typeId: string, orderedIds: string[], actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ValidationError} when the list does not match the type's sections
 */
async function reorderSections({ typeId, orderedIds, actor, log }) {
  await withTransaction(async () => {
    const current = await sectionModel.listIds(typeId);
    const same =
      current.length === orderedIds.length &&
      new Set(orderedIds).size === current.length &&
      orderedIds.every((id) => current.includes(id));
    if (!same) throw new ValidationError('The section list changed. Reload the page and try again.');
    await sectionModel.reorder(orderedIds);
    await paperTypeModel.touch(typeId, actorName(actor));
  });
  log.info({ paperTypeId: typeId }, 'Sections reordered');
}

/**
 * Swap with the neighbour above / below (FR-ADM-19, the buttons next to the letter).
 * @param {{sectionId: string, direction: 'up'|'down', actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} CANNOT_MOVE at the top / bottom
 */
async function moveSection({ sectionId, direction, actor, log }) {
  const section = await getSectionOrThrow(sectionId);
  const ids = await sectionModel.listIds(section.paperTypeId);
  const at = ids.indexOf(sectionId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= ids.length) {
    throw new ConflictError(
      `This section is already at the ${direction === 'up' ? 'top' : 'bottom'}.`,
      'CANNOT_MOVE',
    );
  }
  [ids[at], ids[to]] = [ids[to], ids[at]];
  await reorderSections({ typeId: section.paperTypeId, orderedIds: ids, actor, log });
}

/**
 * Soft delete a section with its standards (FR-ADM-18).
 * @param {{sectionId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 */
async function deleteSection({ sectionId, actor, log }) {
  const section = await getSectionOrThrow(sectionId);
  const by = actorName(actor);
  await withTransaction(async () => {
    await sectionModel.softDeleteWithStandards(sectionId, by);
    await paperTypeModel.touch(section.paperTypeId, by);
  });
  log.info({ sectionId }, 'Section deleted');
}

/**
 * Undo deleteSection: the section and the standards deleted with it come back.
 * @param {{sectionId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED
 */
async function restoreSection({ sectionId, actor, log }) {
  const section = await getSectionOrThrow(sectionId, { includeDeleted: true });
  if (!section.deletedAt) throw new ConflictError('This section is not deleted.', 'NOT_DELETED');
  const by = actorName(actor);
  await withTransaction(async () => {
    await sectionModel.restoreWithStandards(sectionId, by);
    await paperTypeModel.touch(section.paperTypeId, by);
  });
  log.info({ sectionId }, 'Section restored');
}

module.exports = { addSection, renameSection, reorderSections, moveSection, deleteSection, restoreSection };
