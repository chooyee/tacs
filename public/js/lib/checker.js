// The AI paper checker (docs/03 §3.3, FR-AI-01…05/12/14, FR-CHAT-01…06): a docked chat panel that
// uploads the paper, shows the check's progress, posts the report and answers questions.
// Every message is built with textContent — AI output is never HTML (FR-CHAT-06).
import { api } from './api.js';
import { $ } from './dom.js';
import { toast } from './toast.js';
import { openReferenceViewer } from './referenceViewer.js';
import { drawPage, fill, loadReference } from './compare.js';

const POLL_MS = 2000;
const MAX_REPORT_CARDS = 4;

/** Create an element with a class and text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, extra = {}) {
  const b = el('button', 'btn', text);
  b.type = 'button';
  b.dataset.size = 'sm';
  b.dataset.action = action;
  if (extra.variant !== null) b.dataset.variant = extra.variant ?? 'outline';
  for (const [key, value] of Object.entries(extra.data ?? {})) b.dataset[key] = value;
  return b;
}

/**
 * Wire the checker. `store` is the paper page's state (see paper.js).
 * @returns {{open: () => void, refreshBar: () => void}}
 */
export function setupChecker(store) {
  const panel = $('#checker');
  const fab = $('#checker-fab');
  const list = $('#checker-messages');
  const s = JSON.parse(panel.dataset.strings);
  const ai = store.ai;
  let messages = null; // loaded on first open
  let polling = null; // { checkId, timer, status }
  let typing = false;

  $('#checker-subtitle').textContent = fill(s.subtitle, { paper: ai.paperTitle, type: ai.paperTypeName });

  /* ---------- Open / close ---------- */

  async function open() {
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    document.body.classList.add('checker-open');
    if (!messages) await loadHistory();
    render();
    ($('#checker-input') ?? $('[data-action="close-checker"]', panel)).focus();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('checker-open');
    fab.focus();
  }

  async function loadHistory() {
    try {
      messages = (await api(`/api/papers/${store.paperId}/chat`)).messages;
    } catch (err) {
      messages = [];
      toast(err.message, { error: true, ref: err.requestId });
    }
  }

  /* ---------- Rendering ---------- */

  function renderBar() {
    const bar = $('#checker-bar');
    const latest = store.latest();
    const parts = [];
    if (latest?.check.pdfsAvailable) {
      const docs = latest.check.documents;
      const pages = docs.reduce((sum, d) => sum + d.pageCount, 0);
      const uploaded = Math.min(...docs.map((d) => new Date(d.createdAt).getTime()));
      const days = Math.max(0, Math.ceil((uploaded + ai.retentionDays * 864e5 - Date.now()) / 864e5));
      parts.push(el('span', 'min-w-0 flex-1 truncate', fill(s.paperBar, { files: docs.map((d) => d.fileName).join(', '), pages, days })));
      if (store.isOwner) parts.push(button(s.recheck, 'recheck'));
    } else {
      parts.push(el('span', 'flex-1', latest ? s.paperBarExpired : s.noPaper));
    }
    bar.replaceChildren(...parts);
    if (latest?.standardsChanged && latest.check.pdfsAvailable && store.isOwner) {
      const note = el('div', 'checker-note');
      note.append(button(s.standardsChanged, 'recheck', { variant: 'ghost' }));
      bar.append(note);
    }
  }

  function renderQuick() {
    const quick = $('#checker-quick');
    if (!quick) return;
    const latest = store.latest();
    const chips = [];
    if (latest) {
      chips.push(button(s.quickGaps, 'quick', { data: { quick: 'gaps' } }));
      const first = store.firstIssueStandard();
      if (first) chips.push(button(fill(s.quickCompare, { n: first.number }), 'quick', { data: { quick: 'compare', standardId: first.id } }));
      chips.push(button(s.quickRefs, 'quick', { data: { quick: 'refs' } }));
      chips.push(button(s.quickSummary, 'quick', { data: { quick: 'summary' } }));
    } else {
      chips.push(button(s.quickRefs, 'quick', { data: { quick: 'refs' } }));
    }
    for (const chip of chips) chip.classList.add('chip-btn');
    quick.replaceChildren(...chips);
  }

  function bubble(role, ...children) {
    const b = el('div', `msg ${role}`);
    b.append(...children);
    return b;
  }

  /** A compare card (docs/03 §3.3): verdict, #N, mini previews, finding, actions. */
  function compareCard(standardId) {
    const standard = store.standard(standardId);
    const result = store.resultFor(standardId);
    const card = el('div', 'cmp-card');
    if (!standard || !result) {
      card.append(el('p', 'text-[13px]', standard ? s.notFoundInPaper : '—'));
      return card;
    }
    const head = el('div', 'cmp-card-head');
    const vd = el('span', 'vd', `✦ ${s.verdicts[result.verdict]}`);
    vd.dataset.verdict = result.verdict;
    head.append(vd, el('b', 'whitespace-nowrap', `#${standard.number}`), el('span', 'min-w-0 truncate', standard.title));
    const thumbs = el('div', 'cmp-thumbs');
    const paperThumb = el('div', 'cmp-thumb');
    const refThumb = el('div', 'cmp-thumb');
    thumbs.append(paperThumb, refThumb);
    const latest = store.latest();
    const doc = latest.check.documents.find((d) => d.id === result.documentId);
    drawPage(paperThumb, {
      url: doc && `/files/documents/${doc.id}`,
      page: result.page,
      area: result.area,
      bbox: result.bbox,
      outline: 'solid',
      verdict: result.verdict,
      width: 150,
      emptyText: latest.check.pdfsAvailable ? s.notFoundInPaper : s.pdfRemoved,
    });
    if (result.referenceId) {
      loadReference(result.referenceId)
        .then((ref) =>
          drawPage(refThumb, { url: ref.fileUrl, mimeType: ref.mimeType, page: result.referencePage ?? 1, area: result.area, outline: 'dashed', width: 150, emptyText: s.noReference }),
        )
        .catch(() => drawPage(refThumb, { width: 150, outline: 'dashed', emptyText: s.noReference }));
    } else {
      drawPage(refThumb, { width: 150, outline: 'dashed', emptyText: s.noReference });
    }
    const actions = el('div', 'cmp-actions');
    actions.append(button(s.sideBySide, 'compare', { data: { standardId } }));
    if (store.isOwner && store.answerOf(standardId).value !== result.suggested) {
      actions.append(button(fill(s.useAi, { answer: result.suggested === 'yes' ? 'Yes' : 'No' }), 'apply', { data: { standardId } }));
    }
    actions.append(button(fill(s.goTo, { n: standard.number }), 'goto', { data: { standardId }, variant: 'ghost' }));
    card.append(head, thumbs, el('p', 'text-[13px]', result.finding), actions);
    if (result.issue) card.append(el('p', `issue ${result.issue.level}`, `${result.issue.level === 'gap' ? '⚠' : '•'} ${result.issue.message}`));
    return card;
  }

  /** The report after a check (FR-AI-12). Details only for the latest check. */
  function report(content) {
    const box = el('div', 'grid gap-2');
    const counts = fill(s.counts, content.counts);
    box.append(el('b', '', s.reportTitle), el('span', '', counts));
    const latest = store.latest();
    if (!latest || latest.check.id !== content.checkId) return bubble('assistant', box);
    const issues = latest.results
      .filter((r) => r.issue)
      .sort((a, b) => (a.issue.level === b.issue.level ? 0 : a.issue.level === 'gap' ? -1 : 1));
    if (issues.length) {
      box.append(el('span', '', s.toLookAt));
      for (const r of issues.slice(0, MAX_REPORT_CARDS)) box.append(compareCard(r.standardId));
      if (issues.length > MAX_REPORT_CARDS) box.append(button(fill(s.showAll, { n: issues.length }), 'show-attention'));
    } else {
      box.append(el('span', '', s.nothingToLookAt));
    }
    if (store.isOwner && store.unansweredWithResult() > 0) box.append(button(s.fill, 'fill', { variant: null }));
    return bubble('assistant', box);
  }

  function renderMessage(m) {
    const c = m.content ?? {};
    switch (m.kind) {
      case 'files': {
        const parts = [el('span', '', fill(s.filesSent, { files: c.files.map((f) => `${f.name} (${fill(s.pagesShort, { n: f.pageCount })})`).join(', ') }))];
        if (c.skipped?.length) parts.push(el('span', 'block text-xs opacity-80', fill(s.skipped, { files: c.skipped.join(', ') })));
        return bubble('user', ...parts);
      }
      case 'report':
        return report(c);
      case 'compare':
        return bubble('assistant', compareCard(c.standardId));
      case 'gaps': {
        if (c.ready || !c.gaps.length) return bubble('assistant', el('span', '', s.readyGaps));
        const ul = el('ul', 'grid gap-1');
        for (const g of c.gaps) {
          const li = el('li');
          li.append(g.standardId ? button(g.text, 'goto', { data: { standardId: g.standardId }, variant: 'ghost' }) : el('span', '', g.text));
          ul.append(li);
        }
        return bubble('assistant', el('b', '', s.gapsTitle), ul);
      }
      case 'refs': {
        const ul = el('ul', 'grid gap-1');
        for (const r of c.references) {
          const li = el('li');
          li.append(button(`${store.icons[r.type] ?? '📄'} ${r.title}`, 'view-reference', { data: { referenceId: r.id }, variant: 'ghost' }));
          ul.append(li);
        }
        return bubble('assistant', el('b', '', fill(s.refsTitle, { type: ai.paperTypeName })), ul);
      }
      case 'summary': {
        const r = c.readiness;
        const text = [
          fill(s.summary, { answered: r.answered, total: r.total, gaps: r.ready ? s.summaryReady : fill(s.summaryGaps, { n: r.gaps }) }),
          c.counts ? fill(s.summaryCheck, { counts: fill(s.counts, c.counts) }) : s.summaryNoCheck,
        ].join(' ');
        return bubble('assistant', el('span', '', text));
      }
      case 'error': {
        const parts = [el('span', '', c.message)];
        if (store.isOwner) parts.push(button(s.tryAgain, 'recheck', { variant: null }));
        return bubble('assistant error', ...parts);
      }
      case 'error-local': // an upload or chat error, only shown in this browser (never stored)
        return bubble('assistant error', el('span', '', c.text));
      default:
        return bubble(m.role, el('span', 'whitespace-pre-wrap', c.text ?? ''));
    }
  }

  function progressBubble(status) {
    const box = el('div', 'grid gap-1.5');
    box.append(el('b', '', s.running));
    status.stepLabels.forEach((label, i) => {
      const step = i + 1;
      const state = status.status === 'queued' ? 'todo' : step < status.step ? 'done' : step === status.step ? 'now' : 'todo';
      const row = el('span', `step ${state}`, `${{ done: '✔', now: '◌', todo: '·' }[state]} ${label}`);
      box.append(row);
    });
    const bar = el('progress', 'bar');
    bar.max = status.totalSteps;
    bar.value = status.status === 'queued' ? 0 : status.step - 0.5;
    box.append(bar);
    return bubble('assistant progress', box);
  }

  function render() {
    if (panel.hidden) return;
    renderBar();
    renderQuick();
    const items = [el('p', 'checker-retention', s.olderRemoved)];
    items.push(bubble('assistant', el('span', '', fill(s.greeting, { name: ai.firstName, refs: ai.referenceCount, type: ai.paperTypeName, standards: store.standardCount() }))));
    for (const m of messages ?? []) items.push(renderMessage(m));
    if (polling?.status && ['queued', 'running'].includes(polling.status.status)) items.push(progressBubble(polling.status));
    if (typing) items.push(bubble('assistant typing', el('span', '', s.typing)));
    list.replaceChildren(...items);
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- Checks: upload, re-check, polling ---------- */

  function startPolling(checkId) {
    clearTimeout(polling?.timer);
    polling = { checkId, timer: null, status: null };
    const poll = async () => {
      try {
        const status = await api(`/api/checks/${checkId}`);
        if (polling?.checkId !== checkId) return;
        polling.status = status;
        if (status.status === 'done' || status.status === 'failed') {
          polling = null;
          await store.refreshLatest(); // new results → AI lines, readiness, badge (FR-AI-07)
          await loadHistory(); // the report or the failure message
          render();
          store.updateBadge();
          return;
        }
        render();
      } catch {
        // A network hiccup: keep polling.
      }
      if (polling?.checkId === checkId) polling.timer = setTimeout(poll, POLL_MS);
    };
    poll();
  }

  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const body = new FormData();
    for (const file of files.slice(0, 3)) body.append('files', file);
    try {
      const started = await api(`/api/papers/${store.paperId}/checks`, { method: 'POST', body });
      await loadHistory(); // shows the "files" message
      startPolling(started.checkId);
    } catch (err) {
      messages = [...(messages ?? []), { role: 'assistant', kind: 'error-local', content: { text: err.message } }];
      render();
    }
  }

  async function recheck() {
    try {
      const started = await api(`/api/papers/${store.paperId}/checks/rerun`, { method: 'POST' });
      startPolling(started.checkId);
      render();
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  }

  /* ---------- Chat ---------- */

  async function send(text) {
    typing = true;
    messages = [...messages, { role: 'user', kind: 'text', content: { text } }];
    render();
    try {
      const { messages: added } = await api(`/api/papers/${store.paperId}/chat`, { method: 'POST', body: { text } });
      messages = [...messages.slice(0, -1), ...added];
    } catch (err) {
      messages = [...messages, { role: 'assistant', kind: 'error-local', content: { text: err.message } }];
    }
    typing = false;
    render();
  }

  async function quick(action, standardId) {
    try {
      const { messages: added } = await api(`/api/papers/${store.paperId}/chat/quick`, {
        method: 'POST',
        body: { action, ...(standardId && { standardId }) },
      });
      messages = [...messages, ...added];
      render();
    } catch (err) {
      toast(err.message, { error: true, ref: err.requestId });
    }
  }

  /* ---------- Events ---------- */

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) close();
  });

  panel.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-action]');
    if (!b) return;
    const { action, standardId } = b.dataset;
    if (action === 'close-checker') close();
    else if (action === 'recheck') recheck();
    else if (action === 'quick') quick(b.dataset.quick, standardId);
    else if (action === 'compare') store.openCompare(standardId);
    else if (action === 'goto') {
      if (window.matchMedia('(max-width: 719px)').matches) close(); // full screen on phones
      store.jump(standardId);
    } else if (action === 'apply') {
      b.disabled = true;
      await store.apply(standardId);
      render();
    } else if (action === 'fill') {
      b.disabled = true;
      const n = await store.fill();
      if (n !== null) toast(fill(s.filled, { n }));
      render();
    } else if (action === 'show-attention') store.showAttention();
    else if (action === 'view-reference') openReferenceViewer(b.dataset.referenceId);
  });

  const input = $('#checker-input');
  if (input) {
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter adds a new line (FR-CHAT-05).
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#checker-composer').requestSubmit();
      }
    });
    $('#checker-composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || typing) return;
      input.value = '';
      grow();
      send(text);
    });
    $('#checker-files').addEventListener('change', (event) => {
      upload(event.target.files);
      event.target.value = '';
    });

    // Drag and drop files onto the panel (docs/03 §3.3).
    const drop = $('#checker-drop');
    let depth = 0;
    panel.addEventListener('dragenter', (event) => {
      if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
      depth += 1;
      drop.hidden = false;
    });
    panel.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) drop.hidden = true;
    });
    panel.addEventListener('dragover', (event) => event.preventDefault());
    panel.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      drop.hidden = true;
      upload(event.dataTransfer.files);
    });
  }

  // A check that was running when the page loaded: show its progress again (FR-AI-04).
  if (ai.active) startPolling(ai.active.id);

  return {
    open,
    rerender: render,
    get isOpen() {
      return !panel.hidden;
    },
  };
}
