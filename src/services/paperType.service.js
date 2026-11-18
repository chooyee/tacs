'use strict';

/**
 * Paper types: the list, the editor view model, create (blank or copy), the draft's name and
 * description, delete, and versions (FR-ADM-01…03, FR-ADM-10, D-45).
 *
 * Versions (D-45): a type has numbered PUBLISHED versions, which never change, and at most ONE
 * DRAFT that every admin edits (autosaved). "Edit" opens the draft (a copy of the newest published
 * version); "Publish" freezes it as the next version; "Cancel" throws it away. New papers use the
 * newest published version; existing papers keep theirs until their owner upgrades.
 * Sections and standards have their own services; references are a shared library (D-37).
 */
const paperTypeModel = require('../models/paperType.model');
const versionModel = require('../models/paperTypeVersion.model');
const sectionModel = require('../models/section.model');
const standardModel = require('../models/standard.model');
const referenceModel = require('../models/reference.model');
const paperModel = require('../models/paper.model');
const { withTransaction } = require('../utils/db');
const { actorName } = require('../utils/actor');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

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
 * The open draft of a type (for changes to its name, sections and standards).
 * @param {string} typeId
 * @returns {Promise<object>}
 * @throws {NotFoundError} unknown type
 * @throws {ConflictError} NO_DRAFT when nobody has clicked Edit
 */
async function getDraftOrThrow(typeId) {
  await getTypeOrThrow(typeId);
  const draft = await versionModel.findDraft(typeId);
  if (!draft) {
    throw new ConflictError('This paper type is not being edited. Click Edit to start a draft.', 'NO_DRAFT');
  }
  return draft;
}

/**
 * Only a draft can change; published versions are frozen (D-45).
 * @param {{versionStatus: string}} item  a section or standard from its model's findById
 * @throws {ConflictError} VERSION_PUBLISHED
 */
function assertDraft(item) {
  if (item.versionStatus !== 'draft') {
    throw new ConflictError(
      'This version is published and can’t be changed. Click Edit to change the paper type.',
      'VERSION_PUBLISHED',
    );
  }
}

/** A draft's name must not be used by another type (published name or another draft). */
async function assertNameFree(name, typeId) {
  if (name !== undefined && (await paperTypeModel.nameTakenByOther(name, typeId))) {
    throw new ConflictError('A paper type with this name already exists.', 'NAME_TAKEN');
  }
}

/**
 * Cards for the paper types page (FR-ADM-01): numbers from the draft when one is open.
 * @returns {Promise<object[]>}
 */
function listTypes() {
  return paperTypeModel.listWithStats({ basis: 'head' });
}

/** The fields of a version the pages show. */
function versionView(v) {
  return {
    id: v.id,
    number: v.number,
    status: v.status,
    createdBy: v.createdBy,
    updatedAt: v.updatedAt,
    updatedBy: v.updatedBy,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
  };
}

/**
 * Which version the editor shows: `draft` → the open draft; a number → that published version;
 * nothing → the newest published version (or the draft of a type that was never published).
 * @param {string} typeId
 * @param {'draft'|number|undefined} which
 * @returns {Promise<object|null>}
 */
async function findVersion(typeId, which) {
  if (which === 'draft') return versionModel.findDraft(typeId);
  if (which !== undefined) return versionModel.findByNumber(typeId, which);
  return (await versionModel.findLatestPublished(typeId)) ?? versionModel.findDraft(typeId);
}

/**
 * Everything the editor shows (docs/03 §3.7) for one version of a type: the version and the list of
 * versions, the library references its standards use, all library references (for the link
 * picker), and sections with their numbered standards. Only the draft is `editable`.
 *
 * @param {string} typeId
 * @param {{version?: 'draft'|number}} [opts]
 * @returns {Promise<object>}
 * @throws {NotFoundError} unknown type or version
 */
async function getEditor(typeId, { version: which } = {}) {
  await getTypeOrThrow(typeId);
  const version = await findVersion(typeId, which);
  if (!version) throw new NotFoundError('This version does not exist.');
  const [papersInProgress, versions, used, options, sections, standards, publishedTypes] = await Promise.all([
    paperModel.countActiveByType(typeId),
    versionModel.listForType(typeId),
    referenceModel.listUsedByVersion(version.id),
    referenceModel.listOptions(),
    sectionModel.listForVersion(version.id),
    standardModel.listForVersion(version.id),
    paperTypeModel.listWithStats({ basis: 'published' }),
  ]);
  const refById = new Map(used.map((r) => [r.id, r]));
  const draft = versions.find((v) => v.status === 'draft') ?? null;
  const latest = versions.find((v) => v.status === 'published') ?? null;

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
        // Live link (D-38): content comes from a published version of another paper type.
        link: s.sourceStandardId
          ? {
              sourceId: s.sourceStandardId,
              typeId: s.sourceTypeId,
              typeName: s.sourceTypeName,
              versionNumber: s.sourceVersionNumber,
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
      id: typeId,
      name: version.name,
      description: version.description,
      updatedAt: version.updatedAt,
      updatedBy: version.updatedBy,
    },
    version: versionView(version),
    editable: version.status === 'draft',
    draft: draft && versionView(draft),
    latestPublished: latest && versionView(latest),
    versions: versions.map((v) => ({ ...versionView(v), papersCount: v.papersCount })),
    papersInProgress,
    usedReferences: used,
    referenceOptions: options,
    // Other paper types' newest published versions, for Import (D-38, D-45: never a draft).
    otherTypes: publishedTypes
      .filter((t) => t.id !== typeId && t.standardsCount > 0)
      .map((t) => ({ id: t.id, name: t.name, number: t.publishedNumber })),
    sections: sectionViews,
    totals: {
      sections: sections.length,
      standards: standards.length,
      mandatory: standards.filter((s) => s.isMandatory).length,
    },
  };
}

/**
 * Create a paper type (FR-ADM-02): a draft that is blank (one "General" section) or a copy of the
 * newest PUBLISHED version of another type (D-45: a draft can't be copied). Nothing is shown to
 * architects until it is published.
 *
 * @param {{name: string, description?: string|null, copyFromTypeId?: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, url: string}>}
 * @throws {ConflictError} NAME_TAKEN
 * @throws {ValidationError} the type to copy has no published version
 */
async function createType({ name, description = null, copyFromTypeId, actor, log }) {
  let source = null;
  if (copyFromTypeId) {
    await getTypeOrThrow(copyFromTypeId);
    source = await versionModel.findLatestPublished(copyFromTypeId);
    if (!source) {
      throw new ValidationError('Only a published paper type can be copied.', [
        { field: 'copyFromTypeId', message: 'Not published' },
      ]);
    }
  }
  await assertNameFree(name, null);
  const updatedBy = actorName(actor);
  const type = await withTransaction(async () => {
    const created = await paperTypeModel.create({ name, description, updatedBy });
    const draft = await versionModel.createDraft({
      paperTypeId: created.id,
      name,
      description,
      createdBy: updatedBy,
    });
    if (source) await versionModel.copyStructure(source.id, draft.id);
    else await sectionModel.create(draft.id, 'General', updatedBy);
    return created;
  });
  log.info({ paperTypeId: type.id, copiedFrom: copyFromTypeId ?? null }, 'Paper type created');
  return { id: type.id, url: `/admin/types/${type.id}/draft` };
}

/**
 * Autosave the draft's name / description (FR-ADM-10). Published versions keep theirs.
 * @param {{typeId: string, name?: string, description?: string|null, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 * @throws {ConflictError} NAME_TAKEN, NO_DRAFT
 */
async function updateType({ typeId, name, description, actor, log }) {
  const draft = await getDraftOrThrow(typeId);
  await assertNameFree(name, typeId);
  const updated = await versionModel.updateDetails(draft.id, {
    name,
    description,
    updatedBy: actorName(actor),
  });
  if (!updated) throw new ConflictError('The draft was published or cancelled. Reload the page.', 'NO_DRAFT');
  const fields = [name !== undefined && 'name', description !== undefined && 'description'].filter(Boolean);
  log.info({ paperTypeId: typeId, fields }, 'Paper type updated');
  return {
    id: typeId,
    name: updated.name,
    description: updated.description,
    updatedAt: updated.updatedAt,
    updatedBy: updated.updatedBy,
  };
}

/**
 * "Edit" (D-45): open the type's draft. If nobody is editing yet, the draft starts as a copy of the
 * newest published version. Every admin gets the same draft.
 *
 * @param {{typeId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{id: string, created: boolean, url: string}>}
 * @throws {NotFoundError}
 */
async function startDraft({ typeId, actor, log }) {
  await getTypeOrThrow(typeId);
  const existing = await versionModel.findDraft(typeId);
  if (existing) return { id: existing.id, created: false, url: `/admin/types/${typeId}/draft` };
  const latest = await versionModel.findLatestPublished(typeId);
  if (!latest) throw new NotFoundError('This paper type has no version to edit.');
  const by = actorName(actor);
  try {
    const draft = await withTransaction(async () => {
      const created = await versionModel.createDraft({
        paperTypeId: typeId,
        name: latest.name,
        description: latest.description,
        createdBy: by,
      });
      await versionModel.copyStructure(latest.id, created.id);
      return created;
    });
    log.info({ paperTypeId: typeId, fromVersion: latest.number }, 'Draft started');
    return { id: draft.id, created: true, url: `/admin/types/${typeId}/draft` };
  } catch (err) {
    // Another admin clicked Edit at the same moment: use their draft (one draft per type).
    if (err.code === '23505' && err.constraint === 'paper_type_versions_one_draft_uq') {
      const draft = await versionModel.findDraft(typeId);
      return { id: draft.id, created: false, url: `/admin/types/${typeId}/draft` };
    }
    throw err;
  }
}

/**
 * "Publish" (D-45): freeze the draft as the next version. New papers use it from now on; existing
 * papers keep their version until their owner upgrades.
 *
 * @param {{typeId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{number: number, url: string}>}
 * @throws {ConflictError} NO_DRAFT, NO_STANDARDS, NAME_TAKEN
 */
async function publishDraft({ typeId, actor, log }) {
  const draft = await getDraftOrThrow(typeId);
  const standards = await standardModel.listForVersion(draft.id);
  if (!standards.length) {
    throw new ConflictError('Add at least one standard before you publish.', 'NO_STANDARDS');
  }
  const by = actorName(actor);
  const published = await withTransaction(async () => {
    const version = await versionModel.publish(draft.id, by);
    if (!version)
      throw new ConflictError('The draft was already published or cancelled. Reload the page.', 'NO_DRAFT');
    // The type carries the name of its newest published version (the unique index lives there).
    await paperTypeModel.update(typeId, {
      name: version.name,
      description: version.description,
      updatedBy: by,
    });
    return version;
  });
  log.info({ paperTypeId: typeId, version: published.number }, 'Paper type version published');
  return { number: published.number, url: `/admin/types/${typeId}` };
}

/**
 * "Cancel" (D-45): throw the draft away; the newest published version stays as it is. A type that
 * was never published has nothing to go back to, so cancelling deletes the type.
 *
 * @param {{typeId: string, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<{typeDeleted: boolean, url: string}>}
 * @throws {ConflictError} NO_DRAFT
 */
async function discardDraft({ typeId, actor, log }) {
  const draft = await getDraftOrThrow(typeId);
  const latest = await versionModel.findLatestPublished(typeId);
  if (!latest) {
    await paperTypeModel.softDelete(typeId, actorName(actor));
    log.info({ paperTypeId: typeId }, 'Unpublished paper type cancelled');
    return { typeDeleted: true, url: '/admin/types' };
  }
  await versionModel.deleteDraft(draft.id);
  log.info({ paperTypeId: typeId }, 'Draft cancelled');
  return { typeDeleted: false, url: `/admin/types/${typeId}` };
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

module.exports = {
  letterFor,
  getTypeOrThrow,
  getDraftOrThrow,
  assertDraft,
  listTypes,
  getEditor,
  createType,
  updateType,
  startDraft,
  publishDraft,
  discardDraft,
  deleteType,
};
