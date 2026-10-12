'use strict';

const { query, toCamel } = require('../utils/db');

/**
 * The AI checker chat (docs/05 §3.13). `content` is JSON whose shape depends on `kind`
 * (text, files, report, compare, gaps, refs, summary, error). Messages are removed after 7 days
 * by the retention job (FR-CHAT-01).
 */

/**
 * A paper's newest messages (at most `limit`), oldest first.
 * @param {string} paperId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{id, role, kind, content, createdAt}>>}
 */
async function listForPaper(paperId, { limit = 200 } = {}) {
  // The newest `limit` messages, returned oldest first.
  const { rows } = await query(
    `select * from (
       select id, role, kind, content, created_at from chat_messages where paper_id = $1
        order by created_at desc, id desc limit $2) newest
      order by created_at, id`,
    [paperId, limit],
  );
  return rows.map(toCamel);
}

/**
 * @param {{paperId: string, role: 'user'|'assistant', kind: string, content: object}} message
 * @returns {Promise<{id, role, kind, content, createdAt}>}
 */
async function insert({ paperId, role, kind, content }) {
  const { rows } = await query(
    `insert into chat_messages (paper_id, role, kind, content) values ($1, $2, $3, $4)
     returning id, role, kind, content, created_at`,
    [paperId, role, kind, JSON.stringify(content)],
  );
  return toCamel(rows[0]);
}

/**
 * How many typed messages and quick actions a user sent since `since`, over all their papers (chat rate limit,
 * FR-CHAT-05, NFR-SEC-08). Counted in the database so several app instances share the limit.
 * @param {string} ownerId
 * @param {Date} since
 * @returns {Promise<number>}
 */
async function countUserMessagesSince(ownerId, since) {
  const { rows } = await query(
    `select count(*)::int as n from chat_messages m join papers p on p.id = m.paper_id
      where p.owner_id = $1 and m.created_at > $2
        and ((m.role = 'user' and m.kind = 'text') or m.content ? 'quick')`,
    [ownerId, since],
  );
  return rows[0].n;
}

module.exports = { listForPaper, insert, countUserMessagesSince };
