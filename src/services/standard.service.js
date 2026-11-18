'use strict';

/**
 * Standards: add, edit (title, rich-text description, mandatory, linked references), move with the
 * buttons or by drag and drop (also into another section), delete with Undo (FR-ADM-15…19,
 * FR-ADM-21, D-37). Only the type's draft can change; papers see the changes once the draft is
 * published and they upgrade (D-45, replaces D-12).
 */
const standardModel = require('../models/standard.model');
const sectionModel = require('../models/section.model');
const referenceModel = require('../models/reference.model');
const versionModel = require('../models/paperTypeVersion.model');
const { getDraftOrThrow, assertDraft, getTypeOrThrow } = require('./paperType.service');
const { withTransaction } = require('../utils/db');
const { actorName } = require('../utils/actor');
const { sanitizeRichText } = require('../utils/richText');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

/** AI providers limit documents per request (docs/07 §5), so warn above this (FR-ADM-21). */
const MAX_REFERENCES_BEFORE_WARNING = 4;
const MAX_DESCRIPTION_HTML = 20_000;

/**
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getStandardOrThrow(id, opts) {
  const standard = await standardModel.findById(id, opts);
  if (!standard) throw new NotFoundError('Standard not found.');
  assertDraft(standard); // every caller changes the standard
  return standard;
}

/** Clean a description; '' when empty. */
function cleanDescription(html) {
  if (html === undefined) return undefined;
  const clean = sanitizeRichText(html);
  if (clean.length > MAX_DESCRIPTION_HTML) {
    throw new ValidationError('The description is too long.', [
      { field: 'description', message: 'Too long' },
    ]);
  }
  return clean;
}

/** De-duplicate and check reference IDs against the library. */
async function checkReferenceIds(referenceIds) {
  const ids = referenceIds ? [...new Set(referenceIds)] : undefined;
  if (ids?.length && (await referenceModel.countExisting(ids)) !== ids.length) {
    throw new ValidationError('One of the references no longer exists. Reload the page.', [
      { field: 'referenceIds', message: 'Unknown reference' },
    ]);
  }
  return ids;
}

/**
 * Add a standard at the end of a section (FR-ADM-16; full form, D-38).
 * @param {{sectionId: string, title: string, description?: string, isMandatory?: boolean,
 *          referenceIds?: string[], actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function addStandard({
  sectionId,
  title,
  description,
  isMandatory = false,
  referenceIds = [],
  actor,
  log,
}) {
  const section = await sectionModel.findById(sectionId);
  if (!section) throw new NotFoundError('Section not found.');
  assertDraft(section);
  const ids = (await checkReferenceIds(referenceIds)) ?? [];
  const by = actorName(actor);
  const standard = await withTransaction(async () => {
    const created = await standardModel.create(sectionId, {
      title,
      descriptionHtml: cleanDescription(description) ?? '',
      isMandatory,
      updatedBy: by,
    });
    if (ids.length) await standardModel.setReferences(created.id, ids);
    await versionModel.touch(section.versionId, by);
    return created;
  });
  log.info({ sectionId, standardId: standard.id }, 'Standard added');
  return standard;
}

/**
 * Edit a standard (FR-ADM-15 toggle, FR-ADM-17 dialog). `referenceIds` replaces the whole link set;
 * every ID must be a library reference.
 *
 * @param {{standardId: string, title?: string, description?: string, isMandatory?: boolean,
 *          referenceIds?: string[], actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{standard: object, warnings: string[]}>}
 * @throws {ValidationError} an unknown reference
 */
async function updateStandard({ standardId, title, description, isMandatory, referenceIds, actor, log }) {
  const current = await getStandardOrThrow(standardId);
  if (current.sourceStandardId) {
    // D-38: the content of a live link belongs to the source paper type.
    throw new ConflictError(
      'This standard is linked from another paper type. Edit it there, or duplicate it here first.',
      'LINKED_STANDARD',
    );
  }
  const ids = await checkReferenceIds(referenceIds);
  const by = actorName(actor);
  const standard = await withTransaction(async () => {
    const updated = await standardModel.update(standardId, {
      title,
      descriptionHtml: cleanDescription(description),
      isMandatory,
      updatedBy: by,
    });
    if (ids) await standardModel.setReferences(standardId, ids);
    await versionModel.touch(current.versionId, by);
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
 * Move a standard to a position in a section of the same paper type (drag and drop), or one step
 * up / down inside its section (the buttons).
 *
 * @param {{standardId: string, direction?: 'up'|'down', sectionId?: string, index?: number,
 *          actor: object, log: import('pino').Logger}} params
 * @returns {Promise<void>}
 * @throws {ConflictError} CANNOT_MOVE at the top / bottom
 * @throws {ValidationError} target section of another paper type
 */
async function moveStandard({ standardId, direction, sectionId, index, actor, log }) {
  const by = actorName(actor);
  await withTransaction(async () => {
    const standard = await getStandardOrThrow(standardId);
    const targetId = sectionId ?? standard.sectionId;
    if (targetId !== standard.sectionId) {
      const target = await sectionModel.findById(targetId);
      if (!target || target.versionId !== standard.versionId) {
        throw new ValidationError('A standard can only move within its paper type.');
      }
    }
    const ids = (await standardModel.listIdsInSection(targetId)).filter((id) => id !== standardId);
    let to;
    if (direction) {
      const from = (await standardModel.listIdsInSection(standard.sectionId)).indexOf(standardId);
      to = direction === 'up' ? from - 1 : from + 1;
      if (to < 0 || to > ids.length) {
        throw new ConflictError(
          `This standard is already at the ${direction === 'up' ? 'top' : 'bottom'}.`,
          'CANNOT_MOVE',
        );
      }
    } else {
      to = Math.min(Math.max(index ?? ids.length, 0), ids.length);
    }
    ids.splice(to, 0, standardId);
    await standardModel.placeInSection(targetId, ids, by);
    if (targetId !== standard.sectionId) {
      // Close the gap left in the old section.
      await standardModel.placeInSection(
        standard.sectionId,
        await standardModel.listIdsInSection(standard.sectionId),
        by,
      );
    }
    await versionModel.touch(standard.versionId, by);
  });
  log.info({ standardId, direction, sectionId, index }, 'Standard moved');
}

/**
 * Soft delete (FR-ADM-18). Answers to it are kept but hidden on papers (FR-ANS-15).
 * @returns {Promise<void>}
 */
async function deleteStandard({ standardId, actor, log }) {
  const standard = await getStandardOrThrow(standardId);
  const by = actorName(actor);
  await standardModel.softDelete(standardId, by);
  await versionModel.touch(standard.versionId, by);
  log.info({ standardId }, 'Standard deleted');
}

/**
 * Undo deleteStandard.
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED, or SECTION_DELETED when its section is gone (restore that first)
 */
async function restoreStandard({ standardId, actor, log }) {
  const standard = await getStandardOrThrow(standardId, { includeDeleted: true });
  if (!standard.deletedAt) throw new ConflictError('This standard is not deleted.', 'NOT_DELETED');
  if (standard.sectionDeleted) {
    throw new ConflictError('Its section was deleted. Restore the section first.', 'SECTION_DELETED');
  }
  const by = actorName(actor);
  await standardModel.restore(standardId, by);
  await versionModel.touch(standard.versionId, by);
  log.info({ standardId }, 'Standard restored');
}

/**
 * The full-screen standard form (D-38): the standard (live link resolved) or a blank one, the
 * sections it can go in, and the reference library for the picker. A new standard always goes into
 * the draft; a standard of a published version is shown read-only (`editable: false`, D-45).
 * @param {{typeId?: string, standardId?: string, sectionId?: string}} params
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 * @throws {ConflictError} NO_DRAFT (new standard while nobody is editing), NO_SECTION
 */
async function getStandardForm({ typeId, standardId, sectionId }) {
  let standard = null;
  let version;
  if (standardId) {
    standard = await standardModel.findResolved(standardId);
    if (!standard) throw new NotFoundError('Standard not found.');
    version = await versionModel.findById(standard.versionId);
  } else {
    version = await getDraftOrThrow(typeId);
  }
  if (!version) throw new NotFoundError('Paper type not found.');
  const [sections, options] = await Promise.all([
    sectionModel.listForVersion(version.id),
    referenceModel.listAllForPicker(),
  ]);
  if (!sections.length) throw new ConflictError('Add a section first.', 'NO_SECTION');
  const preferred = sections.some((sec) => sec.id === sectionId) ? sectionId : sections[0].id;
  if (standard) {
    // Number and references as shown in the version (numbering runs across all sections).
    const shown = (await standardModel.listForVersion(version.id)).find((st) => st.id === standard.id);
    standard.number = shown?.number;
    standard.referenceIds = shown?.referenceIds ?? [];
  }
  const editable = version.status === 'draft';
  return {
    type: { id: version.paperTypeId, name: version.name },
    version: { id: version.id, number: version.number, status: version.status },
    editable,
    // Where Cancel / Back goes: the draft editor, or the published version the standard is in.
    backUrl: editable
      ? `/admin/types/${version.paperTypeId}/draft`
      : `/admin/types/${version.paperTypeId}?version=${version.number}`,
    sections: sections.map((sec) => ({ id: sec.id, title: sec.title })),
    standard,
    selectedSectionId: standard?.sectionId ?? preferred,
    referenceOptions: options,
  };
}

/**
 * "Duplicate here" (D-38): a linked standard becomes an independent copy this type can edit.
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_LINKED
 */
async function detachStandard({ standardId, actor, log }) {
  const standard = await getStandardOrThrow(standardId);
  if (!standard.sourceStandardId) throw new ConflictError('This standard is not linked.', 'NOT_LINKED');
  const by = actorName(actor);
  await withTransaction(async () => {
    await standardModel.detach(standardId, by);
    await versionModel.touch(standard.versionId, by);
  });
  log.info({ standardId }, 'Linked standard duplicated');
}

/**
 * Import standards of other paper types into the draft as live links (D-38). Only standards of a
 * PUBLISHED version can be imported (D-45). "sections" mode recreates each source section (same
 * title) in the draft; "into" puts everything into one chosen section. A standard already linked
 * into the draft (any version of it) is skipped and reported (warn and skip).
 *
 * @param {{typeId: string, standardIds: string[], mode: 'sections'|'into', targetSectionId?: string,
 *          actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{imported: number, skipped: string[]}>}
 * @throws {ConflictError} NO_DRAFT
 */
async function importStandards({ typeId, standardIds, mode, targetSectionId, actor, log }) {
  const draft = await getDraftOrThrow(typeId);
  if (mode === 'into') {
    const target = await sectionModel.findById(targetSectionId);
    if (!target || target.versionId !== draft.id)
      throw new ValidationError('Choose a section of this paper type.');
  }
  const by = actorName(actor);
  return withTransaction(async () => {
    const already = await standardModel.linkedSourceLineages(draft.id);
    const sectionFor = new Map(); // source section → its new copy (sections mode)
    let imported = 0;
    const skipped = [];
    for (const id of [...new Set(standardIds)]) {
      const std = await standardModel.findResolved(id);
      if (!std || std.versionStatus !== 'published') continue; // never from a draft (D-45)
      // Always link to the ORIGINAL standard, never to a link of a link.
      const sourceId = std.sourceStandardId ?? std.id;
      const lineage = std.sourceStandardId
        ? (await standardModel.findById(std.sourceStandardId))?.lineageId
        : std.lineageId;
      if (std.paperTypeId === typeId || already.has(lineage)) {
        skipped.push(std.title);
        continue;
      }
      let sectionId = targetSectionId;
      if (mode === 'sections') {
        if (!sectionFor.has(std.sectionId)) {
          const sourceSection = await sectionModel.findById(std.sectionId);
          const created = await sectionModel.create(draft.id, sourceSection.title, by);
          sectionFor.set(std.sectionId, created.id);
        }
        sectionId = sectionFor.get(std.sectionId);
      }
      await standardModel.createLink(sectionId, sourceId, by);
      already.add(lineage);
      imported += 1;
    }
    if (imported) await versionModel.touch(draft.id, by);
    log.info({ paperTypeId: typeId, imported, skipped: skipped.length }, 'Standards imported');
    return { imported, skipped };
  });
}

/**
 * Sections and standards of a type's newest PUBLISHED version for the Import picker (titles
 * resolved). A draft is never offered (D-45).
 * @param {string} typeId
 * @returns {Promise<object[]>}
 * @throws {NotFoundError} unknown type, or never published
 */
async function getImportTree(typeId) {
  await getTypeOrThrow(typeId);
  const version = await versionModel.findLatestPublished(typeId);
  if (!version) throw new NotFoundError('This paper type has no published version.');
  const [sections, standards] = await Promise.all([
    sectionModel.listForVersion(version.id),
    standardModel.listForVersion(version.id),
  ]);
  return sections.map((sec) => ({
    id: sec.id,
    title: sec.title,
    standards: standards
      .filter((st) => st.sectionId === sec.id)
      .map((st) => ({ id: st.id, number: st.number, title: st.title, isMandatory: st.isMandatory })),
  }));
}

module.exports = {
  getStandardForm,
  detachStandard,
  importStandards,
  getImportTree,
  MAX_REFERENCES_BEFORE_WARNING,
  addStandard,
  updateStandard,
  moveStandard,
  deleteStandard,
  restoreStandard,
};
