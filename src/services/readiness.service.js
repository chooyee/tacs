'use strict';

/**
 * Readiness on the server (FR-RDY-03): loads what the shared rules need and runs them, so the home
 * page, the paper page and the chat always agree. The rules themselves live in
 * utils/readinessRules.js and run unchanged in the browser.
 */
const standardModel = require('../models/standard.model');
const answerModel = require('../models/answer.model');
const checkModel = require('../models/check.model');
const rules = require('../utils/readinessRules');

/**
 * Only the fields the rules use, in display order.
 * @param {object[]} standards  rows of standardModel.listForType
 * @returns {Array<{id, number, sectionId, isMandatory}>}
 */
function ruleStandards(standards) {
  return standards.map((s) => ({ id: s.id, number: s.number, sectionId: s.sectionId, isMandatory: s.isMandatory }));
}

/**
 * `{ [standardId]: {value, remark} }` from answer rows.
 * @param {Array<{standardId, value, remark}>} rows
 * @returns {object}
 */
function answerMap(rows) {
  return Object.fromEntries(rows.map((a) => [a.standardId, { value: a.value, remark: a.remark }]));
}

/**
 * `results` and `kept` maps for the rules from check_results rows.
 * @param {Array<{standardId, verdict, kept?: boolean, keptByUserAt?: Date}>} rows
 * @returns {{results: object, kept: object}}
 */
function resultMaps(rows) {
  const results = {};
  const kept = {};
  for (const r of rows) {
    results[r.standardId] = { verdict: r.verdict };
    if (r.kept || r.keptByUserAt) kept[r.standardId] = true;
  }
  return { results, kept };
}

/**
 * Readiness of one paper from data the caller already loaded.
 * @param {{standards: object[], answers: object, results?: object, kept?: object, hasCheck?: boolean,
 *   pdfsAvailable?: boolean}} input
 * @returns {object} the readiness object (docs/06 §3) plus `pill`
 */
function compute(input) {
  const result = rules.readiness(input);
  return { ...result, pill: rules.readinessPill(result) };
}

/**
 * Everything about one paper's state: standards (display order), answers, the latest completed check
 * with its results, and the readiness computed from them.
 * @param {{id: string, paperTypeId: string}} paper
 * @param {{standards?: object[]}} [opts]  the type's standards, when the caller already has them
 * @returns {Promise<{standards: object[], ruleStandards: object[], answers: object, latest: object|null,
 *   resultRows: object[], results: object, kept: object, readiness: object}>}
 */
async function forPaper(paper, opts = {}) {
  const [standards, answerRows, latest] = await Promise.all([
    opts.standards ?? standardModel.listForType(paper.paperTypeId),
    answerModel.listForPapers([paper.id]),
    checkModel.findLatestDone(paper.id),
  ]);
  const resultRows = latest ? await checkModel.listResults(latest.id) : [];
  const answers = answerMap(answerRows);
  const { results, kept } = resultMaps(resultRows);
  const rs = ruleStandards(standards);
  const readiness = compute({
    standards: rs,
    answers,
    results,
    kept,
    hasCheck: Boolean(latest),
    pdfsAvailable: Boolean(latest?.documents.length),
  });
  return { standards, ruleStandards: rs, answers, latest, resultRows, results, kept, readiness };
}

/**
 * Readiness of many papers (the cards on the home page): one query for the answers, one for the
 * latest results and one per paper type for its standards.
 * @param {Array<{id, paperTypeId, aiChecked}>} papers
 * @returns {Promise<Map<string, object>>} paper ID → readiness
 */
async function forPapers(papers) {
  const ids = papers.map((p) => p.id);
  const typeIds = [...new Set(papers.map((p) => p.paperTypeId))];
  const [answerRows, resultRows, ...standardLists] = await Promise.all([
    answerModel.listForPapers(ids),
    checkModel.listLatestResultsForPapers(ids),
    ...typeIds.map((id) => standardModel.listForType(id)),
  ]);
  const standardsByType = new Map(typeIds.map((id, i) => [id, ruleStandards(standardLists[i])]));
  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.paperId)) map.set(row.paperId, []);
      map.get(row.paperId).push(row);
    }
    return map;
  };
  const answersByPaper = group(answerRows);
  const resultsByPaper = group(resultRows);
  return new Map(
    papers.map((p) => [
      p.id,
      compute({
        standards: standardsByType.get(p.paperTypeId),
        answers: answerMap(answersByPaper.get(p.id) ?? []),
        ...resultMaps(resultsByPaper.get(p.id) ?? []),
        hasCheck: p.aiChecked,
      }),
    ]),
  );
}

module.exports = { ruleStandards, answerMap, resultMaps, compute, forPaper, forPapers };
