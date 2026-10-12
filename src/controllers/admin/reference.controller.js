'use strict';

/**
 * Admin → References: the shared library (D-37) — list page, full-screen add / edit page, and the
 * API. Multipart bodies: the file is in `req.file` (multer), the other fields in `req.body`.
 */
const referenceService = require('../../services/reference.service');

/** GET /admin/references — the library. */
async function index(req, res) {
  const references = await referenceService.listLibrary();
  res.render('layouts/main', {
    page: 'pages/admin/references',
    title: res.locals.t.library.heading,
    pageScript: 'adminReferences',
    adminTab: 'references',
    references,
  });
}

/** GET /admin/references/new and /admin/references/:referenceId — the full-screen editor. */
async function edit(req, res) {
  const { reference, usedFor } = req.params.referenceId
    ? await referenceService.getReferencePage(req.params.referenceId)
    : { reference: null, usedFor: [] };
  res.render('layouts/main', {
    page: 'pages/admin/reference',
    title: reference ? reference.title : res.locals.t.library.newTitle,
    pageScript: 'adminReference',
    adminTab: 'references',
    usesRichEditor: true,
    reference,
    usedFor,
  });
}

/** POST /api/admin/references */
async function add(req, res) {
  const ref = await referenceService.addReference({
    fields: req.body,
    file: req.file,
    actor: req.user,
    log: req.log,
  });
  res
    .status(201)
    .json({ data: { ...referenceService.publicReference(ref), url: `/admin/references/${ref.id}` } });
}

/** PATCH /api/admin/references/:referenceId */
async function update(req, res) {
  const ref = await referenceService.updateReference({
    referenceId: req.params.referenceId,
    fields: req.body,
    file: req.file,
    actor: req.user,
    log: req.log,
  });
  res.json({ data: referenceService.publicReference(ref) });
}

/** DELETE /api/admin/references/:referenceId */
async function remove(req, res) {
  await referenceService.deleteReference({
    referenceId: req.params.referenceId,
    actor: req.user,
    log: req.log,
  });
  res.status(204).end();
}

/** POST /api/admin/references/:referenceId/restore */
async function restore(req, res) {
  await referenceService.restoreReference({
    referenceId: req.params.referenceId,
    actor: req.user,
    log: req.log,
  });
  res.status(204).end();
}

module.exports = { index, edit, add, update, remove, restore };
