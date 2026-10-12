'use strict';

/**
 * Readiness rules (FR-ANS-05, FR-ANS-09/10, FR-RDY-01…05, docs/04 §6) as PURE functions: no I/O, no
 * Node or browser APIs. The SAME file runs on the server (require) and in the browser, where
 * `npm run build` copies it to public/js/shared/ and a classic <script> puts it on
 * `window.readinessRules`. The server's result is the source of truth; the browser only uses these
 * rules for instant feedback until the API answers.
 *
 * Shapes used below:
 *   standard = { id, number, sectionId, isMandatory }
 *   answers  = { [standardId]: { value: 'yes'|'no'|'na'|null, remark: string } }
 *   results  = { [standardId]: { verdict: 'comply'|'partial'|'gap'|'none' } }   (latest AI check, M4)
 *   kept     = { [standardId]: true }   ("Keep mine" on an AI issue, FR-AI-10)
 */
(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.readinessRules = rules;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  /** The words shown for each AI issue (FR-AI-08). */
  const ISSUE_MESSAGES = {
    yesButGap: 'Your paper doesn’t back up your “Yes”.',
    yesButNotFound: 'You answered “Yes”, but the AI couldn’t find it in your paper.',
    yesButPartial: 'Only partly shown in your paper.',
    noButComplies: 'The AI thinks your paper already covers this.',
  };

  /** No / N/A must be explained (FR-ANS-05). */
  function needsRemark(answer) {
    return Boolean(answer) && (answer.value === 'no' || answer.value === 'na') && !(answer.remark || '').trim();
  }

  /** The answer the AI's verdict suggests (FR-AI-09): comply / partial → Yes, otherwise No. */
  function aiAnswerFor(verdict) {
    return verdict === 'comply' || verdict === 'partial' ? 'yes' : 'no';
  }

  /**
   * Where the AI's reading of the paper disagrees with the architect's answer. `gap` blocks
   * readiness; `check` is only "worth a second look".
   * @returns {{level: 'gap'|'check', messageKey: string}|null}
   */
  function aiIssue(answer, result, standard, isKept) {
    if (!result || isKept) return null;
    const value = answer && answer.value;
    if (value === 'yes' && result.verdict === 'gap') return { level: 'gap', messageKey: 'yesButGap' };
    if (value === 'yes' && result.verdict === 'none')
      return { level: standard.isMandatory ? 'gap' : 'check', messageKey: 'yesButNotFound' };
    if (value === 'yes' && result.verdict === 'partial') return { level: 'check', messageKey: 'yesButPartial' };
    if (value === 'no' && result.verdict === 'comply') return { level: 'check', messageKey: 'noButComplies' };
    return null;
  }

  function issueFor(standard, answers, results, kept) {
    return aiIssue(answers[standard.id], results[standard.id], standard, Boolean(kept[standard.id]));
  }

  /** Something to fix on one standard (FR-ANS-10). */
  function needsFix(standard, answers, results, kept) {
    const answer = answers[standard.id];
    if (standard.isMandatory && answer && answer.value === 'no') return true;
    if (needsRemark(answer)) return true;
    const issue = issueFor(standard, answers, results, kept);
    return Boolean(issue && issue.level === 'gap');
  }

  /**
   * One section's chip and pills (FR-ANS-08/10): answered count, things to fix, complete.
   * @returns {{done: number, total: number, warn: number, complete: boolean}}
   */
  function sectionStatus(standards, answers, results = {}, kept = {}) {
    const done = standards.filter((s) => answers[s.id] && answers[s.id].value).length;
    const warn = standards.filter((s) => needsFix(s, answers, results, kept)).length;
    return { done, total: standards.length, warn, complete: done === standards.length && warn === 0 };
  }

  /**
   * Does a standard show under a filter (FR-ANS-09)? 'all' | 'todo' | 'attention' | 'mandatory'.
   * @returns {boolean}
   */
  function matchesFilter(filter, standard, answers, results = {}, kept = {}) {
    const answer = answers[standard.id] || {};
    if (filter === 'todo') return !answer.value;
    if (filter === 'mandatory') return Boolean(standard.isMandatory);
    if (filter === 'attention')
      return answer.value === 'no' || needsRemark(answer) || Boolean(issueFor(standard, answers, results, kept));
    return true;
  }

  const numbers = (list) => `#${list.map((s) => s.number).join(', #')}`;

  /**
   * The readiness of a paper (FR-RDY-01…05). Gaps come in the fixed order of the four checks.
   *
   * @param {{standards: object[], answers: object, results?: object, kept?: object, hasCheck?: boolean,
   *   pdfsAvailable?: boolean}} input
   *   hasCheck: the paper has a completed AI check; pdfsAvailable: its PDFs were not removed yet
   * @returns {{ready: boolean, started: boolean, answered: number, total: number, mandatory: number,
   *   mandatoryMet: number, gaps: Array<{code: string, text: string, standardId: string}>,
   *   secondLookCount: number, aiTip: boolean}}
   */
  function readiness({ standards, answers, results = {}, kept = {}, hasCheck = false, pdfsAvailable = hasCheck }) {
    const valueOf = (s) => answers[s.id] && answers[s.id].value;
    const unanswered = standards.filter((s) => !valueOf(s));
    const mandatory = standards.filter((s) => s.isMandatory);
    const mandatoryNo = mandatory.filter((s) => valueOf(s) === 'no');
    const noRemark = standards.filter((s) => needsRemark(answers[s.id]));
    const issues = standards.map((s) => ({ s, issue: issueFor(s, answers, results, kept) }));
    const aiGaps = issues.filter((x) => x.issue && x.issue.level === 'gap').map((x) => x.s);

    const gaps = [];
    if (unanswered.length) {
      const n = unanswered.length;
      gaps.push({ code: 'UNANSWERED', text: `${n} standard${n === 1 ? '' : 's'} not answered`, standardId: unanswered[0].id });
    }
    if (mandatoryNo.length) {
      gaps.push({ code: 'MANDATORY_NO', text: `Mandatory standard not met: ${numbers(mandatoryNo)}`, standardId: mandatoryNo[0].id });
    }
    if (noRemark.length) {
      gaps.push({ code: 'REMARK_MISSING', text: `Explain your “No” / “N/A” on ${numbers(noRemark)}`, standardId: noRemark[0].id });
    }
    // Check 4 only applies when there is a completed AI check (FR-RDY note).
    if (hasCheck && aiGaps.length) {
      gaps.push({ code: 'AI_CONFLICT', text: `Your paper doesn’t support your answer on ${numbers(aiGaps)}`, standardId: aiGaps[0].id });
    }

    const answered = standards.length - unanswered.length;
    return {
      ready: gaps.length === 0,
      started: answered > 0 || hasCheck,
      answered,
      total: standards.length,
      mandatory: mandatory.length,
      mandatoryMet: mandatory.filter((s) => valueOf(s) === 'yes' || valueOf(s) === 'na').length,
      gaps,
      secondLookCount: issues.filter((x) => x.issue && x.issue.level === 'check').length,
      aiTip: !(hasCheck && pdfsAvailable), // FR-RDY-05: a tip, never a gap
    };
  }

  /**
   * The pill on a paper card and in the paper header (FR-PAP-01 table).
   * @returns {{kind: 'ready'|'not-started'|'fix', text: string}}
   */
  function readinessPill(r) {
    if (r.ready) return { kind: 'ready', text: '✓ Ready for committee' };
    if (!r.started) return { kind: 'not-started', text: 'Not started' };
    const n = r.gaps.length;
    return { kind: 'fix', text: `${n} thing${n === 1 ? '' : 's'} to fix` };
  }

  return { ISSUE_MESSAGES, needsRemark, aiAnswerFor, aiIssue, needsFix, sectionStatus, matchesFilter, readiness, readinessPill };
});
