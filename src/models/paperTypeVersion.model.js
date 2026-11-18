'use strict';

const { query, toCamel } = require('../utils/db');

/**
 * Paper type versions (D-45): numbered, read-only PUBLISHED versions and at most one DRAFT per type
 * that every admin edits. Sections (and so standards) belong to one version.
 */
const COLUMNS = `v.id, v.paper_type_id, v.number, v.status, v.name, v.description, v.created_at, v.created_by,
  v.updated_at, v.updated_by, v.published_at, v.published_by`;

/** Only versions of paper types that are not deleted. */
const FROM =
  'from paper_type_versions v join paper_types t on t.id = v.paper_type_id and t.deleted_at is null';

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} ${FROM} where v.id = $1`, [id]);
  return toCamel(rows[0]);
}

/**
 * The type's draft, if one is open.
 * @param {string} paperTypeId
 * @returns {Promise<object|null>}
 */
async function findDraft(paperTypeId) {
  const { rows } = await query(
    `select ${COLUMNS} ${FROM} where v.paper_type_id = $1 and v.status = 'draft'`,
    [paperTypeId],
  );
  return toCamel(rows[0]);
}

/**
 * The newest published version of a type (what new papers use).
 * @param {string} paperTypeId
 * @returns {Promise<object|null>}
 */
async function findLatestPublished(paperTypeId) {
  const { rows } = await query(
    `select ${COLUMNS} ${FROM} where v.paper_type_id = $1 and v.status = 'published' order by v.number desc limit 1`,
    [paperTypeId],
  );
  return toCamel(rows[0]);
}

/**
 * A published version by its number (v1, v2 …).
 * @param {string} paperTypeId
 * @param {number} number
 * @returns {Promise<object|null>}
 */
async function findByNumber(paperTypeId, number) {
  const { rows } = await query(`select ${COLUMNS} ${FROM} where v.paper_type_id = $1 and v.number = $2`, [
    paperTypeId,
    number,
  ]);
  return toCamel(rows[0]);
}

/**
 * Every version of a type: the draft first, then the newest published version down to v1, with the
 * number of papers pinned to each.
 * @param {string} paperTypeId
 * @returns {Promise<object[]>}
 */
async function listForType(paperTypeId) {
  const { rows } = await query(
    `select ${COLUMNS},
            (select count(*)::int from papers p where p.paper_type_version_id = v.id and p.deleted_at is null) as papers_count
       ${FROM}
      where v.paper_type_id = $1
      order by v.status = 'draft' desc, v.number desc`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * Open a new, empty draft. Fails on the one-draft-per-type index if a draft already exists.
 * @param {{paperTypeId: string, name: string, description: string|null, createdBy: string|null}} draft
 * @returns {Promise<object>}
 */
async function createDraft({ paperTypeId, name, description, createdBy }) {
  const { rows } = await query(
    `insert into paper_type_versions as v (paper_type_id, status, name, description, created_by, updated_by)
     values ($1, 'draft', $2, $3, $4, $4)
     returning ${COLUMNS}`,
    [paperTypeId, name, description, createdBy],
  );
  return toCamel(rows[0]);
}

/**
 * Copy the visible sections, standards and reference links of one version into another (a new
 * draft). Each copied standard keeps its lineage. A standard linked from another type (D-38) is
 * pointed at the newest published copy of its source, so a new draft picks up the source's latest
 * published content. Call inside withTransaction().
 *
 * @param {string} fromVersionId
 * @param {string} toVersionId
 * @returns {Promise<void>}
 */
async function copyStructure(fromVersionId, toVersionId) {
  // 1. Sections, with new IDs chosen up front so we know which new section belongs to which old one.
  const sections = await query(
    `with m as (
       select id as old_id, gen_random_uuid() as new_id, paper_type_id, title, position, created_at, updated_at, updated_by
         from sections where version_id = $1 and deleted_at is null),
     ins as (
       insert into sections (id, paper_type_id, version_id, title, position, created_at, updated_at, updated_by)
       select new_id, paper_type_id, $2, title, position, created_at, updated_at, updated_by from m)
     select old_id, new_id from m`,
    [fromVersionId, toVersionId],
  );
  if (!sections.rows.length) return;

  // 2. Standards of those sections.
  const standards = await query(
    `with secmap as (select * from unnest($1::uuid[], $2::uuid[]) as x(old_id, new_id)),
     m as (
       select st.id as old_id, gen_random_uuid() as new_id, sm.new_id as section_id, st.title, st.description_html,
              st.is_mandatory, st.position, st.lineage_id, st.created_at, st.updated_at, st.updated_by,
              case when st.source_standard_id is null then null else coalesce(
                (select x.id from standards src
                   join standards x on x.lineage_id = src.lineage_id and x.deleted_at is null
                   join sections xs on xs.id = x.section_id and xs.deleted_at is null
                   join paper_type_versions xv on xv.id = xs.version_id and xv.status = 'published'
                  where src.id = st.source_standard_id
                  order by xv.number desc limit 1),
                st.source_standard_id) end as source_standard_id
         from standards st join secmap sm on sm.old_id = st.section_id
        where st.deleted_at is null),
     ins as (
       insert into standards (id, section_id, title, description_html, is_mandatory, position, lineage_id,
                              source_standard_id, created_at, updated_at, updated_by)
       select new_id, section_id, title, description_html, is_mandatory, position, lineage_id,
              source_standard_id, created_at, updated_at, updated_by from m)
     select old_id, new_id from m`,
    [sections.rows.map((r) => r.old_id), sections.rows.map((r) => r.new_id)],
  );
  if (!standards.rows.length) return;

  // 3. Their links to library references (references themselves are shared, D-37).
  await query(
    `insert into standard_references (standard_id, reference_id)
     select x.new_id, sr.reference_id
       from unnest($1::uuid[], $2::uuid[]) as x(old_id, new_id)
       join standard_references sr on sr.standard_id = x.old_id
     on conflict do nothing`,
    [standards.rows.map((r) => r.old_id), standards.rows.map((r) => r.new_id)],
  );
}

/**
 * Change the draft's name and/or description; undefined fields stay as they are.
 * @param {string} id
 * @param {{name?: string, description?: string|null, updatedBy: string}} changes
 * @returns {Promise<object|null>} null when the version is not a draft
 */
async function updateDetails(id, { name, description, updatedBy }) {
  const { rows } = await query(
    `update paper_type_versions as v
        set name = coalesce($2, name),
            description = case when $4 then $3 else description end,
            updated_by = $5, updated_at = now()
      where id = $1 and status = 'draft'
      returning ${COLUMNS}`,
    [id, name ?? null, description ?? null, description !== undefined, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * Record that something in the draft changed ("Last edited … by …").
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<void>}
 */
async function touch(id, updatedBy) {
  await query('update paper_type_versions set updated_at = now(), updated_by = $2 where id = $1', [
    id,
    updatedBy,
  ]);
}

/**
 * Freeze the draft as the next version number. Sections and standards deleted in the draft are
 * removed for good first (nothing can point to them: papers only use published versions).
 * Call inside withTransaction().
 *
 * @param {string} id  the draft
 * @param {string} publishedBy
 * @returns {Promise<object|null>} the published version, or null when it was not a draft
 */
async function publish(id, publishedBy) {
  await query(
    `delete from standards where deleted_at is not null
        and section_id in (select id from sections where version_id = $1)`,
    [id],
  );
  await query('delete from sections where version_id = $1 and deleted_at is not null', [id]);
  const { rows } = await query(
    `update paper_type_versions as v
        set status = 'published', published_at = now(), published_by = $2,
            number = (select coalesce(max(number), 0) + 1 from paper_type_versions where paper_type_id = v.paper_type_id)
      where id = $1 and status = 'draft'
      returning ${COLUMNS}`,
    [id, publishedBy],
  );
  return toCamel(rows[0]);
}

/**
 * Throw a draft away with its sections and standards (Cancel, D-45).
 * @param {string} id
 * @returns {Promise<boolean>} false when it was not a draft
 */
async function deleteDraft(id) {
  const { rowCount } = await query(`delete from paper_type_versions where id = $1 and status = 'draft'`, [
    id,
  ]);
  return rowCount === 1;
}

module.exports = {
  findById,
  findDraft,
  findLatestPublished,
  findByNumber,
  listForType,
  createDraft,
  copyStructure,
  updateDetails,
  touch,
  publish,
  deleteDraft,
};
