'use strict';

/**
 * Paper types: the list, the editor view model, create (blank or copy), autosave and delete
 * (FR-ADM-01…03, FR-ADM-10). Sections, standards and references have their own services.
 */
const { randomUUID } = require('node:crypto');
const paperTypeModel = require('../models/paperType.model');
const sectionModel = require('../models/section.model');
const standardModel = require('../models/standard.model');
const referenceModel = require('../models/reference.model');
const paperModel = require('../models/paper.model');
const { getStorage } = require('../factories/storageFactory');
const { withTransaction } = require('../utils/db');
const { ConflictError, NotFoundError } = require('../utils/errors');
const { referenceKey } = require('./reference.service');

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
 * Everything the editor shows (docs/03 §3.7): the type, references with link counts, and sections
 * with their numbered standards and linked references.
 *
 * @param {string} typeId
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getEditor(typeId) {
  const type = await getTypeOrThrow(typeId);
  const [papersInProgress, references, sections, standards] = await Promise.all([
    paperModel.countActiveByType(typeId),
    referenceModel.listForType(typeId),
    sectionModel.listForType(typeId),
    standardModel.listForType(typeId),
  ]);
  const refById = new Map(references.map((r) => [r.id, r]));
  const view = (r) => ({ id: r.id, type: r.type, title: r.title, note: r.note });

  const sectionViews = sections.map((section, index) => ({
    id: section.id,
    title: section.title,
    letter: letterFor(index),
    standards: standards
      .filter((s) => s.sectionId === section.id)
      .map((s) => ({
        id: s.id,
        number: s.number,
        text: s.text,
        isMandatory: s.isMandatory,
        references: s.referenceIds
          .map((id) => refById.get(id))
          .filter(Boolean)
          .map(view),
      })),
  }));

  return {
    type: { id: type.id, name: type.name, description: type.description },
    papersInProgress,
    references: references.map((r) => ({ ...view(r), url: r.url, linkedCount: r.linkedCount })),
    sections: sectionViews,
    totals: {
      sections: sections.length,
      standards: standards.length,
      mandatory: standards.filter((s) => s.isMandatory).length,
    },
  };
}

/**
 * Copy sections, standards (with mandatory flags), references (S3 files copied) and links into a
 * new type (FR-ADM-02). Runs inside the caller's transaction; S3 copies made before a failure are
 * removed again so no orphans remain.
 */
async function copyContent(sourceId, target, log) {
  const storage = getStorage();
  const [references, sections, standards] = await Promise.all([
    referenceModel.listForType(sourceId),
    sectionModel.listForType(sourceId),
    standardModel.listForType(sourceId),
  ]);

  const copiedKeys = [];
  try {
    const newRefId = new Map();
    for (const ref of references) {
      const id = randomUUID();
      const s3Key = referenceKey(target.id, id, ref.mimeType);
      await storage.copy(ref.s3Key, s3Key);
      copiedKeys.push(s3Key);
      await referenceModel.create({ ...ref, id, paperTypeId: target.id, s3Key });
      newRefId.set(ref.id, id);
    }
    for (const section of sections) {
      const newSection = await sectionModel.create(target.id, section.title);
      for (const std of standards.filter((s) => s.sectionId === section.id)) {
        const created = await standardModel.create(newSection.id, std.text, { isMandatory: std.isMandatory });
        await standardModel.setReferences(
          created.id,
          std.referenceIds.map((id) => newRefId.get(id)).filter(Boolean),
        );
      }
    }
  } catch (err) {
    await Promise.all(
      copiedKeys.map((key) =>
        storage
          .remove(key)
          .catch((cleanupErr) => log.warn({ err: cleanupErr, key }, 'Could not remove copied file')),
      ),
    );
    throw err;
  }
}

/**
 * Create a paper type: blank (one "General" section) or a copy of another type (FR-ADM-02).
 *
 * @param {{name: string, description?: string|null, copyFromTypeId?: string, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, url: string}>}
 * @throws {ConflictError} NAME_TAKEN
 * @throws {NotFoundError} when the type to copy does not exist
 */
async function createType({ name, description = null, copyFromTypeId, log }) {
  if (copyFromTypeId) await getTypeOrThrow(copyFromTypeId);
  const type = await withTransaction(async () => {
    const created = await paperTypeModel.create({ name, description });
    if (copyFromTypeId) await copyContent(copyFromTypeId, created, log);
    else await sectionModel.create(created.id, 'General');
    return created;
  });
  log.info({ paperTypeId: type.id, copiedFrom: copyFromTypeId ?? null }, 'Paper type created');
  return { id: type.id, url: `/admin/types/${type.id}` };
}

/**
 * Autosave name / description (FR-ADM-10).
 * @param {{typeId: string, name?: string, description?: string|null, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, name: string, description: string|null}>}
 * @throws {NotFoundError}
 * @throws {ConflictError} NAME_TAKEN
 */
async function updateType({ typeId, name, description, log }) {
  const updated = await paperTypeModel.update(typeId, { name, description });
  if (!updated) throw new NotFoundError('Paper type not found.');
  const fields = [name !== undefined && 'name', description !== undefined && 'description'].filter(Boolean);
  log.info({ paperTypeId: typeId, fields }, 'Paper type updated');
  return { id: updated.id, name: updated.name, description: updated.description };
}

/**
 * Soft-delete a paper type no paper uses (FR-ADM-03).
 * @param {{typeId: string, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {NotFoundError}
 * @throws {ConflictError} TYPE_IN_USE
 */
async function deleteType({ typeId, log }) {
  await getTypeOrThrow(typeId);
  const inUse = await paperModel.countActiveByType(typeId);
  if (inUse > 0) {
    throw new ConflictError(
      `This paper type is used by ${inUse} paper${inUse === 1 ? '' : 's'}, so it cannot be deleted.`,
      'TYPE_IN_USE',
    );
  }
  await paperTypeModel.softDelete(typeId);
  log.info({ paperTypeId: typeId }, 'Paper type deleted');
}

module.exports = { letterFor, getTypeOrThrow, listTypes, getEditor, createType, updateType, deleteType };
