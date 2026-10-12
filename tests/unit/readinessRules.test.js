'use strict';

/**
 * The shared readiness rules (docs/04 §6): every row of the readiness table (FR-RDY-01…05), the AI
 * issue table (FR-AI-08), section status (FR-ANS-10), filters (FR-ANS-09) and the pill (FR-PAP-01).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../src/utils/readinessRules');

const std = (number, isMandatory = false, sectionId = 'A') => ({ id: `s${number}`, number, sectionId, isMandatory });
const standards = [std(1, true), std(2), std(3, true, 'B'), std(4, false, 'B')];
const yes = { value: 'yes', remark: '' };
const allYes = () => Object.fromEntries(standards.map((s) => [s.id, { ...yes }]));

describe('FR-ANS-05: remark rules', () => {
  test('No / N/A without a remark needs one; spaces do not count', () => {
    assert.equal(rules.needsRemark({ value: 'no', remark: '' }), true);
    assert.equal(rules.needsRemark({ value: 'na', remark: '   ' }), true);
    assert.equal(rules.needsRemark({ value: 'no', remark: 'Plan: Q1' }), false);
    assert.equal(rules.needsRemark({ value: 'yes', remark: '' }), false);
    assert.equal(rules.needsRemark(undefined), false);
  });
});

describe('FR-RDY-01…05: readiness', () => {
  test('all four checks pass → Ready for committee', () => {
    const r = rules.readiness({ standards, answers: allYes() });
    assert.deepEqual([r.ready, r.gaps, r.answered, r.total], [true, [], 4, 4]);
    assert.deepEqual(rules.readinessPill(r), { kind: 'ready', text: '✓ Ready for committee' });
  });

  test('check 1: unanswered standards, pointing at the first one', () => {
    const answers = allYes();
    delete answers.s2;
    delete answers.s4;
    const r = rules.readiness({ standards, answers });
    assert.deepEqual(r.gaps, [{ code: 'UNANSWERED', text: '2 standards not answered', standardId: 's2' }]);
    delete answers.s1;
    delete answers.s3;
    answers.s4 = yes;
    assert.equal(rules.readiness({ standards, answers }).gaps[0].text, '3 standards not answered');
  });

  test('check 2: a mandatory standard answered No', () => {
    const answers = { ...allYes(), s1: { value: 'no', remark: 'later' }, s3: { value: 'no', remark: 'later' } };
    const r = rules.readiness({ standards, answers });
    assert.deepEqual(r.gaps, [{ code: 'MANDATORY_NO', text: 'Mandatory standard not met: #1, #3', standardId: 's1' }]);
    assert.equal(r.mandatoryMet, 0);
  });

  test('D-15: N/A on a mandatory standard is allowed (with a remark) and counts as met', () => {
    const r = rules.readiness({ standards, answers: { ...allYes(), s1: { value: 'na', remark: 'Not hosted by us' } } });
    assert.deepEqual([r.ready, r.mandatoryMet, r.mandatory], [true, 2, 2]);
  });

  test('check 3: No / N/A without a remark', () => {
    const r = rules.readiness({ standards, answers: { ...allYes(), s2: { value: 'na', remark: '' }, s4: { value: 'no', remark: '' } } });
    assert.deepEqual(r.gaps, [{ code: 'REMARK_MISSING', text: 'Explain your “No” / “N/A” on #2, #4', standardId: 's2' }]);
  });

  test('check 4: an AI gap issue blocks only when there is a completed check', () => {
    const results = { s2: { verdict: 'gap' } };
    const without = rules.readiness({ standards, answers: allYes(), results, hasCheck: false });
    assert.equal(without.ready, true);
    const withCheck = rules.readiness({ standards, answers: allYes(), results, hasCheck: true });
    assert.deepEqual(withCheck.gaps, [{ code: 'AI_CONFLICT', text: 'Your paper doesn’t support your answer on #2', standardId: 's2' }]);
    const kept = rules.readiness({ standards, answers: allYes(), results, kept: { s2: true }, hasCheck: true });
    assert.equal(kept.ready, true, 'Keep mine resolves it (FR-AI-10)');
  });

  test('gaps come in the fixed order of the four checks', () => {
    const answers = { s1: { value: 'no', remark: '' }, s2: yes };
    const r = rules.readiness({ standards, answers, results: { s2: { verdict: 'gap' } }, hasCheck: true });
    assert.deepEqual(
      r.gaps.map((g) => g.code),
      ['UNANSWERED', 'MANDATORY_NO', 'REMARK_MISSING', 'AI_CONFLICT'],
    );
    assert.deepEqual(rules.readinessPill(r), { kind: 'fix', text: '4 things to fix' });
  });

  test('FR-RDY-05: the AI tip shows until a check with PDFs still available exists; it is never a gap', () => {
    assert.equal(rules.readiness({ standards, answers: allYes() }).aiTip, true);
    assert.equal(rules.readiness({ standards, answers: allYes(), hasCheck: true }).aiTip, false);
    assert.equal(rules.readiness({ standards, answers: allYes(), hasCheck: true, pdfsAvailable: false }).aiTip, true);
  });

  test('FR-PAP-01: nothing answered and never checked → "Not started"', () => {
    const r = rules.readiness({ standards, answers: {} });
    assert.deepEqual(rules.readinessPill(r), { kind: 'not-started', text: 'Not started' });
    assert.equal(rules.readinessPill(rules.readiness({ standards, answers: {}, hasCheck: true })).kind, 'fix');
  });

  test('"worth a second look" counts check-level issues', () => {
    const r = rules.readiness({ standards, answers: allYes(), results: { s2: { verdict: 'partial' } }, hasCheck: true });
    assert.deepEqual([r.ready, r.secondLookCount], [true, 1]);
  });
});

describe('FR-AI-08: AI issue rules (exact table)', () => {
  const issue = (value, verdict, mandatory = false, kept = false) =>
    rules.aiIssue(value ? { value, remark: '' } : undefined, { verdict }, { isMandatory: mandatory }, kept);
  const rows = [
    ['yes', 'gap', false, 'gap', 'yesButGap'],
    ['yes', 'none', true, 'gap', 'yesButNotFound'],
    ['yes', 'none', false, 'check', 'yesButNotFound'],
    ['yes', 'partial', false, 'check', 'yesButPartial'],
    ['no', 'comply', false, 'check', 'noButComplies'],
  ];
  for (const [value, verdict, mandatory, level, key] of rows) {
    test(`${value} + ${verdict}${mandatory ? ' (mandatory)' : ''} → ${level}`, () => {
      assert.deepEqual(issue(value, verdict, mandatory), { level, messageKey: key });
      assert.ok(rules.ISSUE_MESSAGES[key]);
    });
  }
  test('any other combination, no result, or Keep mine → no issue', () => {
    for (const [value, verdict] of [['yes', 'comply'], ['no', 'gap'], ['no', 'none'], ['na', 'gap'], [null, 'gap'], ['no', 'partial']]) {
      assert.equal(issue(value, verdict), null, `${value} + ${verdict}`);
    }
    assert.equal(issue('yes', 'gap', false, true), null);
    assert.equal(rules.aiIssue(yes, undefined, { isMandatory: false }, false), null);
  });
  test('FR-AI-09: the AI answer is Yes for comply / partial, No otherwise', () => {
    assert.deepEqual(['comply', 'partial', 'gap', 'none'].map(rules.aiAnswerFor), ['yes', 'yes', 'no', 'no']);
  });
});

describe('FR-ANS-09/10: sections and filters', () => {
  const inA = standards.filter((s) => s.sectionId === 'A');

  test('a section is complete when all are answered and nothing needs fixing', () => {
    assert.deepEqual(rules.sectionStatus(inA, allYes()), { done: 2, total: 2, warn: 0, complete: true });
    assert.deepEqual(rules.sectionStatus(inA, { s1: yes }), { done: 1, total: 2, warn: 0, complete: false });
  });

  test('"to fix": mandatory No, a missing remark, or an AI gap issue', () => {
    assert.equal(rules.sectionStatus(inA, { s1: { value: 'no', remark: 'x' }, s2: yes }).warn, 1);
    assert.equal(rules.sectionStatus(inA, { s1: yes, s2: { value: 'na', remark: '' } }).warn, 1);
    assert.equal(rules.sectionStatus(inA, allYes(), { s2: { verdict: 'gap' } }).warn, 1);
    assert.equal(rules.sectionStatus(inA, allYes(), { s2: { verdict: 'partial' } }).complete, true);
  });

  test('filters: To do, Needs attention, Mandatory', () => {
    const answers = { s1: yes, s2: { value: 'no', remark: 'x' } };
    const pick = (filter, results) => standards.filter((s) => rules.matchesFilter(filter, s, answers, results)).map((s) => s.number);
    assert.deepEqual(pick('all'), [1, 2, 3, 4]);
    assert.deepEqual(pick('todo'), [3, 4]);
    assert.deepEqual(pick('attention'), [2]);
    assert.deepEqual(pick('attention', { s1: { verdict: 'gap' } }), [1, 2]);
    assert.deepEqual(pick('mandatory'), [1, 3]);
  });
});
