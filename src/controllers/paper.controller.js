'use strict';

/**
 * Papers for architects: the home page (My papers / All papers), the paper page and the paper API
 * (docs/06 §2–3). Thin: the rules live in paper.service and answer.service.
 */
const paperService = require('../services/paper.service');
const answerService = require('../services/answer.service');
const checkService = require('../services/check.service');
const config = require('../config');

/** GET /papers — My papers, or All papers with `?tab=all&q=&typeId=&page=` (FR-PAP-01, FR-PAP-07). */
async function index(req, res) {
  const { tab, q, typeId, page } = req.query;
  const [paperTypes, mine, all] = await Promise.all([
    paperService.listPaperTypeOptions(),
    tab === 'mine' ? paperService.listMine(req.user) : null,
    tab === 'all' ? paperService.listAll({ search: q, paperTypeId: typeId, page }) : null,
  ]);
  res.render('layouts/main', {
    page: 'pages/papers/index',
    title: tab === 'all' ? res.locals.t.papers.tabAll : res.locals.t.papers.heading,
    pageScript: 'papers',
    tab,
    papers: mine ?? all.papers,
    pager: all && { page: all.page, pages: all.pages, total: all.total, q, typeId },
    paperTypes,
  });
}

/** GET /papers/:paperId — the paper page; read-only unless you own it (FR-PAP-08). */
async function show(req, res) {
  const { paperId } = req.params;
  const [vm, latest, active] = await Promise.all([
    paperService.getPaperPage({ user: req.user, paperId }),
    checkService.getLatest({ paperId }),
    checkService.getActive(paperId),
  ]);
  // What the AI checker needs (FR-AI-01…18); the page script renders the AI lines from it.
  vm.client.ai = {
    latest,
    active,
    retentionDays: config.retention.days,
    firstName: String(req.user.name).split(/\s+/)[0],
    paperTypeName: vm.paper.paperTypeName,
    paperTitle: vm.paper.title,
    referenceCount: vm.references.length,
    references: vm.references.map((r) => ({ id: r.id, type: r.type, title: r.title, mimeType: r.mimeType })),
    standardTitles: Object.fromEntries(vm.sections.flatMap((s) => s.standards.map((x) => [x.id, x.title]))),
  };
  res.render('layouts/main', {
    page: 'pages/papers/show',
    title: vm.paper.title,
    pageScript: 'paper',
    usesReadinessRules: true,
    ...vm,
  });
}

/** POST /api/papers */
async function create(req, res) {
  const data = await paperService.createPaper({ user: req.user, ...req.body, log: req.log });
  res.status(201).json({ data });
}

/** PATCH /api/papers/:paperId */
async function update(req, res) {
  const data = await paperService.updatePaper({
    user: req.user,
    paperId: req.params.paperId,
    ...req.body,
    log: req.log,
  });
  res.json({ data });
}

/** DELETE /api/papers/:paperId */
async function remove(req, res) {
  await paperService.deletePaper({ user: req.user, paperId: req.params.paperId, log: req.log });
  res.status(204).end();
}

/** GET /api/papers/:paperId/readiness */
async function readiness(req, res) {
  const vm = await paperService.getPaperPage({ user: req.user, paperId: req.params.paperId });
  res.json({ data: vm.readiness });
}

/** PUT /api/papers/:paperId/answers/:standardId */
async function saveAnswer(req, res) {
  const data = await answerService.saveAnswer({
    user: req.user,
    paperId: req.params.paperId,
    standardId: req.params.standardId,
    value: req.body.value,
    remark: req.body.remark,
    log: req.log,
  });
  res.json({ data });
}

module.exports = { index, show, create, update, remove, readiness, saveAnswer };
