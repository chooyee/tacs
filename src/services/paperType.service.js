'use strict';

/**
 * Paper types: the list, the editor view model, create (blank or copy), autosave and delete
 * (FR-ADM-01…03, FR-ADM-10). Sections and standards have their own services; references are a
 * shared library (reference.service, D-37).
 */
const paperTypeModel = require('../models/paperType.model');
const sectionModel = require('../models/section.model');
const standardModel = require('../models/standard.model');
const referenceModel = require('../models/reference.model');
const paperModel = require('../models/paper.model');
const { withTransaction } = require('../utils/db');
const { actorName } = require('../utils/actor');
const { ConflictError, NotFoundError } = require('../utils/errors');

/** "A", "B" … "Z", "AA" … — section letters are computed, never stored (docs/05 §3.3). */
function letterFor(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * @param {string} typeId
 * @returns {Promise<object>} the paper type
 * @throws {NotFoundError}
 */
async function getTypeOrThrow(typeId) {
  const type = await paperTypeModel.findById(typeId);
  if (!type) throw new NotFoundError('Paper type not found.');
  return type;
}

/**
 * Cards for the paper types page (FR-ADM-01).
 * @returns {Promise<object[]>}
 */
function listTypes() {
  return paperTypeModel.listWithStats();
}

/**
 * Everything the editor shows (docs/03 §3.7): the type, the library references its standards use,
 * all library references (for the link picker), and sections with their numbered standards.
 *
 * @param {string} typeId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getEditor(typeId) {
  const type = await getTypeOrThrow(typeId);
  const [papersInProgress, used, options, sections, standards, allTypes] = await Promise.all([
    paperModel.countActiveByType(typeId),
    referenceModel.listUsedByType(typeId),
    referenceModel.listOptions(),
    sectionModel.listForType(typeId),
    standardModel.listForType(typeId),
    paperTypeModel.listWithStats(),
  ]);
  const refById = new Map(used.map((r) => [r.id, r]));

  const sectionViews = sections.map((section, index) => ({
    id: section.id,
    title: section.title,
    letter: letterFor(index),
    updatedAt: section.updatedAt,
    updatedBy: section.updatedBy,
    standards: standards
      .filter((s) => s.sectionId === section.id)
      .map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title,
        descriptionHtml: s.descriptionHtml,
        isMandatory: s.isMandatory,
        updatedAt: s.updatedAt,
        updatedBy: s.updatedBy,
        // Live link (D-38): content comes from another paper type's standard.
        link: s.sourceStandardId
          ? {
              sourceId: s.sourceStandardId,
              typeId: s.sourceTypeId,
              typeName: s.sourceTypeName,
              sourceDeleted: s.sourceDeleted,
            }
          : null,
        references: s.referenceIds
          .map((id) => refById.get(id))
          .filter(Boolean)
          .map((r) => ({ id: r.id, type: r.type, title: r.title, note: r.note })),
      })),
  }));

  return {
    type: {
      id: type.id,
      name: type.name,
      description: type.description,
      updatedAt: type.updatedAt,
      updatedBy: type.updatedBy,
    },
    papersInProgress,
    usedReferences: used,
    referenceOptions: options,
    // Other paper types, for Import (D-38).
    otherTypes: allTypes
      .filter((t) => t.id !== typeId && t.standardsCount > 0)
      .map((t) => ({ id: t.id, name: t.name })),
    sections: sectionViews,
    totals: {
      sections: sections.length,
      standards: standards.length,
      mandatory: standards.filter((s) => s.isMandatory).length,
    },
  };
}

/**
 * Copy sections, standards (title, description, mandatory) and their links to library references
 * into a new type (FR-ADM-02). References are shared (D-37), so nothing is copied in S3.
 * Runs inside the caller's transaction.
 */
async function copyContent(sourceId, target, updatedBy) {
  const [sections, standards] = await Promise.all([
    sectionModel.listForType(sourceId),
    standardModel.listForType(sourceId),
  ]);
  for (const section of sections) {
    const newSection = await sectionModel.create(target.id, section.title, updatedBy);
    for (const std of standards.filter((s) => s.sectionId === section.id)) {
      if (std.sourceStandardId) {
        await standardModel.createLink(newSection.id, std.sourceStandardId, updatedBy); // stays live (D-38)
        continue;
      }
      const created = await standardModel.create(newSection.id, {
        title: std.title,
        descriptionHtml: std.descriptionHtml,
        isMandatory: std.isMandatory,
        updatedBy,
      });
      await standardModel.setReferences(created.id, std.referenceIds);
    }
  }
}

/**
 * Create a paper type: blank (one "General" section) or a copy of another type (FR-ADM-02).
 *
 * @param {{name: string, description?: string|null, copyFromTypeId?: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, url: string}>}
 * @throws {ConflictError} NAME_TAKEN
 * @throws {NotFoundError} when the type to copy does not exist
 */
async function createType({ name, description = null, copyFromTypeId, actor, log }) {
  if (copyFromTypeId) await getTypeOrThrow(copyFromTypeId);
  const updatedBy = actorName(actor);
  const type = await withTransaction(async () => {
    const created = await paperTypeModel.create({ name, description, updatedBy });
    if (copyFromTypeId) await copyContent(copyFromTypeId, created, updatedBy);
    else await sectionModel.create(created.id, 'General', updatedBy);
    return created;
  });
  log.info({ paperTypeId: type.id, copiedFrom: copyFromTypeId ?? null }, 'Paper type created');
  return { id: type.id, url: `/admin/types/${type.id}` };
}

/**
 * Autosave name / description (FR-ADM-10).
 * @param {{typeId: string, name?: string, description?: string|null, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 * @throws {ConflictError} NAME_TAKEN
 */
async function updateType({ typeId, name, description, actor, log }) {
  const updated = await paperTypeModel.update(typeId, { name, description, updatedBy: actorName(actor) });
  if (!updated) throw new NotFoundError('Paper type not found.');
  const fields = [name !== undefined && 'name', description !== undefined && 'description'].filter(Boolean);
  log.info({ paperTypeId: typeId, fields }, 'Paper type updated');
  return {
    id: updated.id,
    name: updated.name,
    description: updated.description,
    updatedAt: updated.updatedAt,
    updatedBy: updated.updatedBy,
  };
}

/**
 * Soft-delete a paper type no paper uses (FR-ADM-03).
 * @param {{typeId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 * @throws {ConflictError} TYPE_IN_USE
 */
async function deleteType({ typeId, actor, log }) {
  await getTypeOrThrow(typeId);
  const inUse = await paperModel.countActiveByType(typeId);
  if (inUse > 0) {
    throw new ConflictError(
      `This paper type is used by ${inUse} paper${inUse === 1 ? '' : 's'}, so it cannot be deleted.`,
      'TYPE_IN_USE',
    );
  }
  await paperTypeModel.softDelete(typeId, actorName(actor));
  log.info({ paperTypeId: typeId }, 'Paper type deleted');
}

module.exports = { letterFor, getTypeOrThrow, listTypes, getEditor, createType, updateType, deleteType };
