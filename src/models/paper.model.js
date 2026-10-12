'use strict';

const { query } = require('../utils/db');

/**
 * Number of non-deleted papers of a paper type (FR-ADM-03: a type in use cannot be deleted;
 * FR-ADM-10: "N in progress"). The rest of this model arrives in M3.
 * @param {string} paperTypeId
 * @returns {Promise<number>}
 */
async function countActiveByType(paperTypeId) {
  const { rows } = await query(
    'select count(*)::int as n from papers where paper_type_id = $1 and deleted_at is null',
    [paperTypeId],
  );
  return rows[0].n;
}

module.exports = { countActiveByType };
