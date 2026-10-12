'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = `id, section_id, title, description_html, is_mandatory, position, created_at, updated_at,
  updated_by, deleted_at`;

/**
 * A standard as it is shown: a linked standard (D-38) takes title, description, mandatory flag,
 * references and "last edited" from its source; its own section and position stay local.
 */
const RESOLVED_SELECT = `
  select s.id, s.section_id, s.position, s.source_standard_id,
         coalesce(src.title, s.title) as title,
         coalesce(src.description_html, s.description_html) as description_html,
         coalesce(src.is_mandatory, s.is_mandatory) as is_mandatory,
         coalesce(src.updated_at, s.updated_at) as updated_at,
         coalesce(src.updated_by, s.updated_by) as updated_by,
         src.deleted_at is not null as source_deleted,
         srct.id as source_type_id, srct.name as source_type_name,
         row_number() over (order by sec.position, sec.created_at, s.position, s.created_at)::int as number,
         (select coalesce(array_agg(r.id order by lower(r.title)), '{}')
            from standard_references sr
            join reference_docs r on r.id = sr.reference_id and r.deleted_at is null
           where sr.standard_id = coalesce(s.source_standard_id, s.id)) as reference_ids
    from standards s
    join sections sec on sec.id = s.section_id and sec.deleted_at is null
    left join standards src on src.id = s.source_standard_id
    left join sections srcsec on srcsec.id = src.section_id
    left join paper_types srct on srct.id = srcsec.paper_type_id`;

/**
 * Every visible standard of a paper type in display order, numbered 1…N across the whole type
 * (FR-ANS-02), with the IDs of its non-deleted references. One query (docs/05 §4).
 * @param {string} paperTypeId
 * @returns {Promise<object[]>}
 */
async function listForType(paperTypeId) {
  const { rows } = await query(
    `${RESOLVED_SELECT}
      where sec.paper_type_id = $1 and s.deleted_at is null
      order by sec.position, sec.created_at, s.position, s.created_at`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * A standard with its section's paper type (whose type is not deleted).
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]  true for restore (Undo)
 * @returns {Promise<object|null>}  includes paperTypeId and sectionDeleted
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select s.id, s.section_id, s.title, s.description_html, s.is_mandatory, s.position, s.deleted_at,
            s.source_standard_id, sec.paper_type_id, sec.deleted_at is not null as section_deleted
       from standards s
       join sections sec on sec.id = s.section_id
       join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null
      where s.id = $1 and ($2 or (s.deleted_at is null and sec.deleted_at is null))`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * Add a standard at the end of a section (FR-ADM-16).
 * @param {string} sectionId
 * @param {{title: string, descriptionHtml?: string, isMandatory?: boolean, updatedBy: string|null}} standard
 * @returns {Promise<object>}
 */
async function create(sectionId, { title, descriptionHtml = '', isMandatory = false, updatedBy = null }) {
  const { rows } = await query(
    `insert into standards (section_id, title, description_html, is_mandatory, updated_by, position)
     values ($1, $2, $3, $4, $5, (select coalesce(max(position) + 1, 0) from standards where section_id = $1))
     returning ${COLUMNS}`,
    [sectionId, title, descriptionHtml, isMandatory, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * Change title, description and/or the mandatory flag; undefined fields stay as they are.
 * @param {string} id
 * @param {{title?: string, descriptionHtml?: string, isMandatory?: boolean, updatedBy: string}} changes
 * @returns {Promise<object|null>}
 */
async function update(id, { title, descriptionHtml, isMandatory, updatedBy }) {
  const { rows } = await query(
    `update standards
        set title = coalesce($2, title), description_html = coalesce($3, description_html),
            is_mandatory = coalesce($4, is_mandatory), updated_by = $5, updated_at = now()
      where id = $1 and deleted_at is null
      returning ${COLUMNS}`,
    [id, title ?? null, descriptionHtml ?? null, isMandatory ?? null, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * Replace the whole set of linked references. Call inside withTransaction().
 * @param {string} id
 * @param {string[]} referenceIds  already checked to exist
 * @returns {Promise<void>}
 */
async function setReferences(id, referenceIds) {
  await query('delete from standard_references where standard_id = $1', [id]);
  if (referenceIds.length) {
    await query(
      `insert into standard_references (standard_id, reference_id)
       select $1, unnest($2::uuid[]) on conflict do nothing`,
      [id, referenceIds],
    );
  }
}

/**
 * IDs of the visible standards of a section, in order.
 * @param {string} sectionId
 * @returns {Promise<string[]>}
 */
async function listIdsInSection(sectionId) {
  const { rows } = await query(
    `select id from standards where section_id = $1 and deleted_at is null order by position, created_at`,
    [sectionId],
  );
  return rows.map((r) => r.id);
}

/**
 * Put a list of standards in this order inside a section (positions 0…n-1). Standards from another
 * section are moved into it. Call inside withTransaction().
 * @param {string} sectionId
 * @param {string[]} orderedIds
 * @param {string} updatedBy
 * @returns {Promise<void>}
 */
async function placeInSection(sectionId, orderedIds, updatedBy) {
  await query(
    `update standards s
        set section_id = $1, position = o.pos - 1, updated_at = now(),
            updated_by = case when s.section_id <> $1 then $3 else s.updated_by end
       from unnest($2::uuid[]) with ordinality as o(id, pos)
      where s.id = o.id`,
    [sectionId, orderedIds, updatedBy],
  );
}

/**
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>}
 */
async function softDelete(id, updatedBy) {
  const { rowCount } = await query(
    'update standards set deleted_at = now(), updated_by = $2 where id = $1 and deleted_at is null',
    [id, updatedBy],
  );
  return rowCount === 1;
}

/**
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>}
 */
async function restore(id, updatedBy) {
  const { rowCount } = await query(
    `update standards set deleted_at = null, updated_at = now(), updated_by = $2
      where id = $1 and deleted_at is not null`,
    [id, updatedBy],
  );
  return rowCount === 1;
}

/**
 * One standard as shown (live link resolved), with its paper type — for the full-screen form.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findResolved(id) {
  const { rows } = await query(
    `select x.*, sec.paper_type_id, t.name as paper_type_name
       from (${RESOLVED_SELECT} where s.id = $1 and s.deleted_at is null) x
       join sections sec on sec.id = x.section_id
       join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null`,
    [id],
  );
  return toCamel(rows[0]);
}

/**
 * Source standards already linked into a paper type (to skip duplicates on import, D-38).
 * @param {string} paperTypeId
 * @returns {Promise<Set<string>>}
 */
async function linkedSourceIds(paperTypeId) {
  const { rows } = await query(
    `select s.source_standard_id as id from standards s
       join sections sec on sec.id = s.section_id and sec.deleted_at is null
      where sec.paper_type_id = $1 and s.deleted_at is null and s.source_standard_id is not null`,
    [paperTypeId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Add a live link to another type's standard at the end of a section (import, D-38).
 * @param {string} sectionId
 * @param {string} sourceId  the ORIGINAL standard (never a link)
 * @param {string} updatedBy
 * @returns {Promise<object>}
 */
async function createLink(sectionId, sourceId, updatedBy) {
  const { rows } = await query(
    `insert into standards (section_id, title, description_html, is_mandatory, source_standard_id, updated_by, position)
     select $1, src.title, src.description_html, src.is_mandatory, src.id, $3,
            (select coalesce(max(position) + 1, 0) from standards where section_id = $1)
       from standards src where src.id = $2
     returning ${COLUMNS}`,
    [sectionId, sourceId, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * "Duplicate here": turn a link into an independent copy of the source's current content and
 * references. Call inside withTransaction().
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<void>}
 */
async function detach(id, updatedBy) {
  // 1. Copy the source's reference links while the link still tells us which source it is.
  await query('delete from standard_references where standard_id = $1', [id]);
  await query(
    `insert into standard_references (standard_id, reference_id)
     select $1, sr.reference_id from standard_references sr
      where sr.standard_id = (select source_standard_id from standards where id = $1)
     on conflict do nothing`,
    [id],
  );
  // 2. Copy the content and drop the link.
  await query(
    `update standards s
        set title = src.title, description_html = src.description_html, is_mandatory = src.is_mandatory,
            source_standard_id = null, updated_by = $2, updated_at = now()
       from standards src
      where s.id = $1 and src.id = s.source_standard_id`,
    [id, updatedBy],
  );
}

module.exports = {
  listForType,
  findResolved,
  linkedSourceIds,
  createLink,
  detach,
  findById,
  create,
  update,
  setReferences,
  listIdsInSection,
  placeInSection,
  softDelete,
  restore,
};
