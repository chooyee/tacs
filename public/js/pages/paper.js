// The paper page (docs/03 §3.2, FR-PAP-03/04/08, FR-ANS-01…14, FR-RDY-01…05, FR-AI-01/07…12).
// The server renders every row; this script keeps the live parts in step with the answers using the
// readiness rules shared with the server (window.readinessRules, docs/04 §6). Answers update the UI
// at once (optimistic) and are saved in the background; a failed save rolls back with a toast.
import { api } from '../lib/api.js';
import { $, $$, debounce } from '../lib/dom.js';
import { setupDialogs } from '../lib/dialog.js';
import { toast } from '../lib/toast.js';
import { openReferenceViewer, setupReferenceViewer } from '../lib/referenceViewer.js';
import { setupCompare } from '../lib/compare.js';
import { setupChecker } from '../lib/checker.js';

const rules = window.readinessRules;
const page = $('#paper-page');
const state = JSON.parse(page.dataset.state);
const t = JSON.parse(page.dataset.strings);
const { paperId, isOwner, standards, ai } = state;
const answers = state.answers; // { [standardId]: {value, remark} } — the browser's current view
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_m, key) => values[key] ?? '');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

setupDialogs();
setupReferenceViewer();

const rowOf = (id) => document.getElementById(`std-${id}`);
const standardById = new Map(standards.map((s) => [s.id, s]));
const cs = JSON.parse($('#checker').dataset.strings); // the AI checker's strings
const icons = JSON.parse($('#checker').dataset.icons);

/* ---------- The latest AI check (FR-AI-07/13): drives the AI lines and readiness check 4 ---------- */

let latest = null; // { check, counts, results[], standardsChanged } or null
let resultById = new Map();
let aiMaps = { results: {}, kept: {} };
function setLatest(next) {
  latest = next;
  resultById = new Map((latest?.results ?? []).map((r) => [r.standardId, r]));
  aiMaps = { results: {}, kept: {} };
  for (const r of latest?.results ?? []) {
    aiMaps.results[r.standardId] = { verdict: r.verdict };
    if (r.kept) aiMaps.kept[r.standardId] = true;
  }
}
setLatest(ai.latest);

/** A result with its issue worked out from the CURRENT answer (the answer may have changed). */
function resultFor(id) {
  const r = resultById.get(id);
  if (!r) return null;
  const issue = rules.aiIssue(answers[id], r, standardById.get(id), r.kept);
  return { ...r, issue: issue && { level: issue.level, message: rules.ISSUE_MESSAGES[issue.messageKey] } };
}
const answerOf = (id) => answers[id] ?? { value: null, remark: '' };

/* ---------- Filters (FR-ANS-09/11/12) ---------- */

let filter = 'all';
// Rows the user changed while a filter is on stay visible until the filter changes (FR-ANS-11).
const keep = new Set();

function setFilter(next) {
  filter = next;
  keep.clear();
  for (const button of $$('[data-action="filter"]'))
    button.setAttribute('aria-pressed', String(button.dataset.filter === next));
  render();
}

/* ---------- Collapsed sections: remembered for this tab only (FR-ANS-14) ---------- */

const COLLAPSE_KEY = `psc.paper.collapsed.${paperId}`;
const collapsed = (() => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(COLLAPSE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
})();

/** Collapse or expand one or more sections, remember it and redraw. */
function setCollapsed(sectionIds, value) {
  for (const sectionId of [].concat(sectionIds)) {
    if (value) collapsed.add(sectionId);
    else collapsed.delete(sectionId);
  }
  try {
    sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage blocked: the state lasts until reload.
  }
  applyCollapse();
}

function applyCollapse() {
  for (const section of $$('.paper-section')) {
    const isCollapsed = collapsed.has(section.dataset.sectionId);
    section.classList.toggle('collapsed', isCollapsed);
    const button = $('.collapse-btn', section);
    button.setAttribute('aria-expanded', String(!isCollapsed));
    const title = $('.psec-title', section).textContent;
    button.setAttribute('aria-label', `${isCollapsed ? t.expand : t.collapse} ${title}`);
  }
  // The one Collapse all / Expand all button says what a click will do.
  const allCollapsed = state.sections.every((s) => collapsed.has(s.id));
  $('[data-action="toggle-all"]').textContent = allCollapsed ? t.expandAll : t.collapseAll;
}

/** Collapse all / Expand all in the section bar (D-43): one button, like the admin editor. */
const setAllCollapsed = (value) =>
  setCollapsed(
    state.sections.map((s) => s.id),
    value,
  );

/* ---------- Shown sections: the "Sections" drop-down, remembered for this tab only (D-43) ---------- */

const HIDDEN_KEY = `psc.paper.hiddenSections.${paperId}`;
const hiddenSections = (() => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
})();

/** Show or hide one or more sections (the checkboxes), remember it and redraw. */
function setSectionShown(sectionIds, shown) {
  for (const sectionId of [].concat(sectionIds)) {
    if (shown) hiddenSections.delete(sectionId);
    else hiddenSections.add(sectionId);
  }
  try {
    sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSections]));
  } catch {
    // Storage blocked: the state lasts until reload.
  }
  applyShownSections();
}

function applyShownSections() {
  for (const section of state.sections) {
    const shown = !hiddenSections.has(section.id);
    document.getElementById(`sec-${section.id}`).hidden = !shown;
    $(`[data-sec-toggle="${section.id}"]`).checked = shown;
  }
  const shownCount = state.sections.filter((s) => !hiddenSections.has(s.id)).length;
  const all = $('[data-sec-toggle="all"]');
  all.checked = shownCount === state.sections.length;
  all.indeterminate = shownCount > 0 && shownCount < state.sections.length;
  $('#sec-dd-label').textContent = all.checked
    ? t.sectionsAll
    : fill(t.sectionsSome, { shown: shownCount, total: state.sections.length });
}

const sectionMenu = $('#sec-dd');
sectionMenu.addEventListener('change', (event) => {
  const box = event.target.closest('[data-sec-toggle]');
  if (!box) return;
  const id = box.dataset.secToggle;
  setSectionShown(id === 'all' ? state.sections.map((s) => s.id) : id, box.checked);
});
// Close the drop-down on Escape or a click outside it.
document.addEventListener('click', (event) => {
  if (sectionMenu.open && !sectionMenu.contains(event.target)) sectionMenu.open = false;
});
sectionMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !sectionMenu.open) return;
  sectionMenu.open = false;
  $('summary', sectionMenu).focus();
});

/* ---------- Side panel: hide / show, remembered in this browser (D-43) ---------- */

const SIDE_KEY = 'psc.paper.sideHidden';
function setSideHidden(hidden, remember = true) {
  $('.paper-layout').classList.toggle('side-hidden', hidden);
  const button = $('#side-toggle');
  button.textContent = hidden ? t.showSide : t.hideSide;
  button.setAttribute('aria-expanded', String(!hidden));
  if (!remember) return;
  try {
    localStorage.setItem(SIDE_KEY, hidden ? '1' : '0');
  } catch {
    // Storage blocked: the state lasts until reload.
  }
}
const sideHiddenAtStart = (() => {
  try {
    return localStorage.getItem(SIDE_KEY) === '1';
  } catch {
    return false;
  }
})();

/* ---------- Rendering the live parts ---------- */

let serverReadiness = null; // the server's answer wins while nothing newer is pending (docs/04 §6)

/** Row colours and remark placeholder / message for one standard. */
function renderRow(id) {
  const row = rowOf(id);
  const answer = answerOf(id);
  row.dataset.value = answer.value ?? '';
  row.classList.toggle('need-remark', rules.needsRemark(answer));
  for (const button of $$('[data-action="answer"]', row)) {
    button.setAttribute('aria-pressed', String(button.dataset.value === answer.value));
  }
  const remark = $('[data-remark]', row);
  if (remark) {
    remark.placeholder =
      answer.value === 'no' ? t.remarkNo : answer.value === 'na' ? t.remarkNa : t.remarkYes;
    remark.setAttribute('aria-invalid', String(rules.needsRemark(answer)));
    $('.remark-error', row).textContent = answer.value === 'na' ? t.errorNa : t.errorNo;
  }
}

function renderSections() {
  for (const section of state.sections) {
    const list = standards.filter((s) => s.sectionId === section.id);
    const status = rules.sectionStatus(list, answers, aiMaps.results, aiMaps.kept);
    const card = document.getElementById(`sec-${section.id}`);
    const warn = $('[data-role="warn"]', card);
    warn.hidden = !status.warn;
    warn.textContent = fill(t.toFix, { n: status.warn });
    const done = $('[data-role="done"]', card);
    done.dataset.kind = status.complete ? 'ready' : '';
    done.textContent = status.complete ? t.complete : fill(t.doneOf, status);

    const chip = $(`.sec-opt[data-section-id="${section.id}"]`);
    chip.dataset.state = status.complete ? 'done' : status.warn ? 'warn' : '';
    $('.chip-count', chip).textContent = status.complete ? '✓' : `${status.done}/${status.total}`;

    // Filter visibility (FR-ANS-11/12)
    let shown = 0;
    for (const s of list) {
      const visible =
        filter === 'all' ||
        keep.has(s.id) ||
        rules.matchesFilter(filter, s, answers, aiMaps.results, aiMaps.kept);
      rowOf(s.id).hidden = !visible;
      if (visible) shown += 1;
    }
    $('.filter-note', card).hidden = shown > 0;
  }
  for (const button of $$('[data-action="filter"]')) {
    const n = standards.filter((s) =>
      rules.matchesFilter(button.dataset.filter, s, answers, aiMaps.results, aiMaps.kept),
    ).length;
    $('.filter-count', button).textContent = n;
  }
}

function renderReadiness() {
  const local = rules.readiness({
    standards,
    answers,
    ...aiMaps,
    hasCheck: Boolean(latest),
    pdfsAvailable: Boolean(latest?.check.pdfsAvailable),
  });
  const r = serverReadiness ?? { ...local, pill: rules.readinessPill(local) };

  const pill = $('#head-pill');
  pill.dataset.kind = r.pill.kind;
  pill.textContent = r.pill.text;

  const card = $('#ready-card');
  card.dataset.ready = String(r.ready);
  const big = Object.assign(document.createElement('div'), {
    className: 'ready-big',
    textContent: r.ready ? t.readyTitle : t.notReadyTitle,
  });
  const text = Object.assign(document.createElement('p'), {
    className: 'text-[13px] text-muted-foreground',
    textContent: r.ready
      ? t.readyText
      : r.gaps.length === 1
        ? t.notReadyOne
        : fill(t.notReadyMany, { n: r.gaps.length }),
  });
  const parts = [big, text];
  if (!r.ready) {
    const list = Object.assign(document.createElement('ul'), { className: 'gap-list' });
    for (const gap of r.gaps) {
      const button = Object.assign(document.createElement('button'), {
        type: 'button',
        textContent: gap.text,
      });
      button.dataset.action = 'goto-standard';
      button.dataset.standardId = gap.standardId;
      const li = document.createElement('li');
      li.append(button);
      list.append(li);
    }
    parts.push(list);
  }
  // FR-RDY-05: the AI check is optional — a tip, never a gap. The floating ✦ button opens it (D-43).
  if (r.aiTip)
    parts.push(Object.assign(document.createElement('div'), { className: 'ai-tip', textContent: t.aiTip }));
  card.replaceChildren(...parts);

  const bar = $('#progress-bar');
  bar.max = Math.max(1, r.total);
  bar.value = r.answered;
  bar.dataset.full = String(r.total > 0 && r.answered === r.total);
  const stat = (strong, label) => {
    const span = document.createElement('span');
    span.append(Object.assign(document.createElement('b'), { textContent: strong }), ` ${label}`);
    return span;
  };
  $('#progress-stats').replaceChildren(
    stat(`${r.answered}/${r.total}`, t.answered),
    stat(`${r.mandatoryMet}/${r.mandatory}`, t.mandatoryMet),
  );
}

/* ---------- AI lines and the checker badge (FR-AI-01/07) ---------- */

function aiButton(text, action, data = {}) {
  const b = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'btn',
    textContent: text,
  });
  b.dataset.size = 'sm';
  b.dataset.variant = 'outline';
  b.dataset.action = action;
  Object.assign(b.dataset, data);
  return b;
}

/** "✦ Complies · page 3 — finding", the issue, and Compare / Use AI answer / Keep mine. */
function renderAiLine(id) {
  const line = $('.ai-line', rowOf(id));
  const r = resultFor(id);
  line.hidden = !r;
  if (!r) return line.replaceChildren();
  line.dataset.verdict = r.verdict;
  const msg = Object.assign(document.createElement('div'), { className: 'ai-msg' });
  const vd = Object.assign(document.createElement('span'), {
    className: 'vd',
    textContent: `✦ ${cs.verdicts[r.verdict]}`,
  });
  vd.dataset.verdict = r.verdict;
  msg.append(vd, r.page ? ` · ${fill(cs.page, { n: r.page })} — ${r.finding}` : ` — ${r.finding}`);
  if (r.issue) {
    msg.append(
      Object.assign(document.createElement('span'), {
        className: `issue ${r.issue.level}`,
        textContent: `${r.issue.level === 'gap' ? '⚠' : '•'} ${r.issue.message}`,
      }),
    );
  }
  if (r.kept)
    msg.append(
      Object.assign(document.createElement('span'), { className: 'issue kept', textContent: cs.kept }),
    );
  const actions = Object.assign(document.createElement('div'), { className: 'ai-actions' });
  actions.append(aiButton(cs.compare, 'compare', { standardId: id }));
  if (isOwner && answerOf(id).value !== r.suggested) {
    actions.append(
      aiButton(fill(cs.useAi, { answer: r.suggested === 'yes' ? 'Yes' : 'No' }), 'apply-ai', {
        standardId: id,
      }),
    );
  }
  if (isOwner && r.issue) actions.append(aiButton(cs.keepMine, 'keep-mine', { standardId: id }));
  line.replaceChildren(msg, actions);
}

/** How many standards have an AI "gap" issue (the badge's "N to fix"). */
const aiGapCount = () => standards.filter((s) => resultFor(s.id)?.issue?.level === 'gap').length;

/** The floating button's badge (FR-AI-01): "Not checked", "N to fix" (AI gap issues) or ✓. */
function updateBadge() {
  const badge = $('#checker-badge');
  if (!latest) {
    badge.textContent = cs.badgeNone;
    badge.dataset.kind = 'none';
    return;
  }
  const gap = aiGapCount();
  badge.textContent = gap ? fill(cs.badgeFix, { n: gap }) : '✓';
  badge.dataset.kind = gap ? 'fix' : 'ok';
}

function render() {
  renderSections();
  renderReadiness();
  for (const s of standards) renderAiLine(s.id);
  updateBadge();
}

/* ---------- Saving answers (FR-ANS-04…07) ---------- */

const pending = new Map(); // standardId → promise chain, so saves of one row never overtake each other
let inFlight = 0;

function setRemarkState(id, value) {
  const el = $('.remark-state', rowOf(id));
  if (!el) return;
  el.dataset.state = value;
  el.textContent = { saving: t.saving, saved: t.saved, error: t.notSaved, idle: '' }[value];
  el.title = value === 'error' ? t.notSaved : '';
}

/**
 * Send the whole answer (value + remark) of one standard. Saves of the same standard run one after
 * the other; the body is read when it is sent, so the newest text always goes last.
 * @param {string} id
 * @param {{rollback?: object}} [opts]  the answer to go back to if this save fails
 */
function save(id, { rollback } = {}) {
  const run = async () => {
    const body = { ...answerOf(id) };
    inFlight += 1;
    setRemarkState(id, 'saving');
    try {
      const data = await api(`/api/papers/${paperId}/answers/${id}`, { method: 'PUT', body });
      inFlight -= 1;
      setRemarkState(id, 'saved');
      // The server is the source of truth, but only while nothing newer is waiting to be sent.
      serverReadiness = inFlight === 0 && sameAnswer(answerOf(id), body) ? data.readiness : null;
    } catch (err) {
      inFlight -= 1;
      setRemarkState(id, 'error');
      if (rollback) {
        answers[id] = rollback;
        const remark = $('[data-remark]', rowOf(id));
        if (remark) remark.value = rollback.remark;
        renderRow(id);
      }
      serverReadiness = null;
      toast(`${t.answerFailed} ${err.message}`, { error: true, ref: err.requestId });
    }
    render();
  };
  const chain = (pending.get(id) ?? Promise.resolve()).then(run);
  pending.set(id, chain);
  return chain;
}

const sameAnswer = (a, b) => (a.value ?? null) === (b.value ?? null) && (a.remark ?? '') === (b.remark ?? '');

function answer(id, value) {
  const before = { ...answerOf(id) };
  // Clicking the selected button again clears the answer (FR-ANS-04).
  const next = before.value === value ? null : value;
  answers[id] = { ...before, value: next };
  if (filter !== 'all') keep.add(id);
  serverReadiness = null;
  renderRow(id);
  render();
  // No / N/A need a remark: move focus there (FR-ANS-05).
  if (next === 'no' || next === 'na') $('[data-remark]', rowOf(id))?.focus();
  save(id, { rollback: before });
}

// One debounced save per row: typing in one remark never delays another.
const remarkSavers = new Map();
function remarkSaver(id) {
  if (!remarkSavers.has(id))
    remarkSavers.set(
      id,
      debounce(() => save(id), 600),
    );
  return remarkSavers.get(id);
}
const dirtyRemarks = new Set();

if (isOwner) {
  page.addEventListener('input', (event) => {
    const input = event.target.closest('[data-remark]');
    if (!input) return;
    const id = input.closest('.answer-row').dataset.standardId;
    answers[id] = { ...answerOf(id), remark: input.value };
    if (filter !== 'all') keep.add(id);
    serverReadiness = null;
    dirtyRemarks.add(id);
    renderRow(id);
    render(); // the red highlight and the gap go away while typing (FR-ANS-05 acceptance)
    remarkSaver(id)();
  });
  // Also save on blur (FR-ANS-07), without waiting for the debounce.
  page.addEventListener('focusout', (event) => {
    const input = event.target.closest('[data-remark]');
    if (!input) return;
    const id = input.closest('.answer-row').dataset.standardId;
    if (!dirtyRemarks.delete(id)) return;
    save(id);
  });
}

/* ---------- Title and vendor: autosave (FR-PAP-03) ---------- */

const paperState = $('#paper-save-state');
const lastSaved = { title: $('#paper-title')?.value, vendor: $('#paper-vendor')?.value };

const savePaperField = debounce(async (input) => {
  const field = input.dataset.paperField;
  const value = input.value.trim();
  if (field === 'title' && (value.length < 3 || value.length > 150)) return; // reverted on blur
  if (value === lastSaved[field]) return;
  paperState.dataset.state = 'saving';
  paperState.textContent = t.saving;
  try {
    await api(`/api/papers/${paperId}`, { method: 'PATCH', body: { [field]: value } });
    lastSaved[field] = value;
    if (field === 'title') document.title = document.title.replace(/^[^·]*/, `${value} `);
    paperState.dataset.state = 'saved';
    paperState.textContent = `✓ ${t.saved}`;
  } catch (err) {
    paperState.dataset.state = 'error';
    paperState.textContent = t.notSaved;
    toast(err.message, { error: true, ref: err.requestId });
  }
}, 600);

for (const input of $$('[data-paper-field]')) {
  input.addEventListener('input', () => savePaperField(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  input.addEventListener('blur', () => {
    // The title must not be empty: put the saved one back and say so (FR-PAP-03).
    const value = input.value.trim();
    if (input.dataset.paperField === 'title' && (value.length < 3 || value.length > 150)) {
      input.value = lastSaved.title;
      toast(t.titleRequired, { error: true });
    }
  });
}

/* ---------- Jumping (chips, gaps): scroll, centre, flash ---------- */

function jumpToStandard(id) {
  const row = rowOf(id);
  if (!row) return;
  const section = row.closest('.paper-section');
  if (section.hidden) setSectionShown(section.dataset.sectionId, true);
  setCollapsed(section.dataset.sectionId, false);
  if (row.hidden) setFilter('all');
  row.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation when the same row is flashed twice
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1500);
  ($('[data-remark]', row) ?? $('button', row))?.focus({ preventScroll: true });
}

/* ---------- Clicks ---------- */

const actions = {
  answer: (button) => answer(button.closest('.answer-row').dataset.standardId, button.dataset.value),
  filter: (button) => setFilter(button.dataset.filter),
  'show-all': () => setFilter('all'),
  'toggle-section': (button) => {
    const id = button.closest('.paper-section').dataset.sectionId;
    setCollapsed(id, !collapsed.has(id));
  },
  'toggle-all': () => setAllCollapsed(!state.sections.every((s) => collapsed.has(s.id))),
  'toggle-side': () => setSideHidden(!$('.paper-layout').classList.contains('side-hidden')),
  'goto-standard': (button) => jumpToStandard(button.dataset.standardId),
  'view-reference': (button) => openReferenceViewer(button.dataset.referenceId),
  compare: (button) => openCompare(button.dataset.standardId),
  'apply-ai': async (button) => {
    button.disabled = true;
    await applyAi(button.dataset.standardId);
  },
  'keep-mine': async (button) => {
    button.disabled = true;
    await keepMine(button.dataset.standardId);
  },
  'open-checker': () => checker.open(),
  // D-45: move the paper to the newest published version of its type, then reload the page.
  'upgrade-paper': async (button) => {
    if (!window.confirm(t.confirmUpgrade)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/papers/${paperId}/upgrade`, { method: 'POST' });
      toast(fill(t.upgraded, { n: result.version, kept: result.carried, open: result.unanswered }));
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      button.disabled = false;
      toast(err.message, { error: true, ref: err.requestId });
    }
  },
  'delete-paper': async () => {
    // A native confirm is accessible and enough for this rare action.
    if (!window.confirm(t.confirmDelete)) return;
    try {
      await api(`/api/papers/${paperId}`, { method: 'DELETE' });
      window.location.assign('/papers');
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  },
};

page.addEventListener('click', (event) => {
  // A failed remark save can be retried by clicking "Not saved – retry".
  const failed = event.target.closest('.remark-state[data-state="error"]');
  if (failed) {
    save(failed.closest('.answer-row').dataset.standardId);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (button && actions[button.dataset.action]) actions[button.dataset.action](button);
});

/* ---------- Sticky offsets: the section bar's height can change (wrapping, phone width) ---------- */

const secbar = $('#secbar');
const setSecbarHeight = () =>
  document.documentElement.style.setProperty('--secbar-h', `${secbar.offsetHeight}px`);
new ResizeObserver(setSecbarHeight).observe(secbar);
setSecbarHeight();

/* ---------- AI result actions (FR-AI-09/10/12), owner only ---------- */

/** Put a saved answer on its row (after Use AI answer / Fill). */
function showAnswer(id, saved) {
  answers[id] = { value: saved.value, remark: saved.remark };
  const remark = $('[data-remark]', rowOf(id));
  if (remark) remark.value = saved.remark;
  renderRow(id);
}

async function applyAi(id) {
  try {
    const data = await api(`/api/papers/${paperId}/results/${id}/apply`, { method: 'POST' });
    showAnswer(id, data.answer);
    setLatest(data.latest);
    serverReadiness = data.readiness;
    render();
    if (checker.isOpen) checker.rerender(); // the chat's cards show the new answer
  } catch (err) {
    toast(err.message, { error: true, ref: err.requestId });
    render();
  }
}

async function keepMine(id) {
  try {
    const data = await api(`/api/papers/${paperId}/results/${id}/keep`, { method: 'POST' });
    setLatest(data.latest);
    serverReadiness = data.readiness;
    render();
    if (checker.isOpen) checker.rerender(); // the chat's cards show the new answer
  } catch (err) {
    toast(err.message, { error: true, ref: err.requestId });
    render();
  }
}

/** Fill my unanswered standards from this check (FR-AI-12). Returns how many, or null on error. */
async function fillUnanswered() {
  try {
    const data = await api(`/api/papers/${paperId}/results/apply-unanswered`, { method: 'POST' });
    for (const [id, saved] of Object.entries(data.answers)) {
      if (rowOf(id) && !sameAnswer(answerOf(id), saved)) showAnswer(id, saved);
    }
    setLatest(data.latest);
    serverReadiness = data.readiness;
    render();
    if (checker.isOpen) checker.rerender(); // the chat's cards show the new answer
    return data.filled;
  } catch (err) {
    toast(err.message, { error: true, ref: err.requestId });
    return null;
  }
}

/** The page state the checker and the compare dialog read and act on. */
const store = {
  paperId,
  isOwner,
  ai,
  strings: cs,
  icons,
  latest: () => latest,
  standard: (id) => {
    const s = standardById.get(id);
    return s && { id, number: s.number, title: ai.standardTitles[id] ?? '' };
  },
  standardCount: () => standards.length,
  resultFor,
  answerOf,
  firstIssueStandard: () => {
    const s = standards.find((x) => resultFor(x.id)?.issue) ?? standards.find((x) => resultById.has(x.id));
    return s && { id: s.id, number: s.number };
  },
  unansweredWithResult: () => standards.filter((s) => !answerOf(s.id).value && resultById.has(s.id)).length,
  apply: applyAi,
  fill: fillUnanswered,
  jump: (id) => jumpToStandard(id),
  openCompare: (id) => openCompare(id),
  showAttention: () => setFilter('attention'),
  updateBadge,
  async refreshLatest() {
    try {
      setLatest(await api(`/api/papers/${paperId}/checks/latest`));
      serverReadiness = null;
      render();
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  },
};
const openCompare = setupCompare(store);
const checker = setupChecker(store);

/* ---------- Start ---------- */

for (const s of standards) renderRow(s.id);
applyCollapse();
applyShownSections();
setSideHidden(sideHiddenAtStart, false);
render();
