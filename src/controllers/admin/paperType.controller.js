'use strict';

/**
 * Admin pages and API for paper types and their versions (FR-ADM-01…03, FR-ADM-10, D-45). Thin:
 * rules are in the services.
 */
const paperTypeService = require('../../services/paperType.service');
const versionModel = require('../../models/paperTypeVersion.model');

/** GET /admin/types — the paper type cards. */
async function index(req, res) {
  const types = await paperTypeService.listTypes();
  res.render('layouts/main', {
    page: 'pages/admin/types',
    title: res.locals.t.adminTypes.heading,
    pageScript: 'adminTypes',
    adminTab: 'types',
    types,
  });
}

function renderEditor(res, editor) {
  res.render('layouts/main', {
    page: 'pages/admin/type',
    title: editor.type.name,
    pageScript: 'adminType',
    adminTab: 'types',
    usesRichEditor: true,
    ...editor,
  });
}

/**
 * GET /admin/types/:typeId — a published version, read-only (the newest, or `?version=N`). A type
 * that was never published opens its draft.
 */
async function show(req, res) {
  renderEditor(res, await paperTypeService.getEditor(req.params.typeId, { version: req.query.version }));
}

/** GET /admin/types/:typeId/draft — the draft editor; back to the type when nobody is editing. */
async function showDraft(req, res) {
  const { typeId } = req.params;
  await paperTypeService.getTypeOrThrow(typeId);
  if (!(await versionModel.findDraft(typeId))) return res.redirect(`/admin/types/${typeId}`);
  return renderEditor(res, await paperTypeService.getEditor(typeId, { version: 'draft' }));
}

/**
 * GET /admin/types/:typeId/cards/:card — one card of the DRAFT re-rendered as an HTML fragment, so
 * the editor can refresh after a change without a second copy of the markup in JavaScript.
 */
async function card(req, res) {
  const editor = await paperTypeService.getEditor(req.params.typeId, { version: 'draft' });
  res.render(`partials/admin/${req.params.card}Card`, editor);
}

/** POST /api/admin/types/:typeId/draft — "Edit": open (or join) the draft. */
async function startDraft(req, res) {
  const result = await paperTypeService.startDraft({
    typeId: req.params.typeId,
    actor: req.user,
    log: req.log,
  });
  res.status(result.created ? 201 : 200).json({ data: result });
}

/** DELETE /api/admin/types/:typeId/draft — "Cancel": throw the draft away. */
async function discardDraft(req, res) {
  const result = await paperTypeService.discardDraft({
    typeId: req.params.typeId,
    actor: req.user,
    log: req.log,
  });
  res.json({ data: result });
}

/** POST /api/admin/types/:typeId/publish — "Publish": the draft becomes the next version. */
async function publish(req, res) {
  const result = await paperTypeService.publishDraft({
    typeId: req.params.typeId,
    actor: req.user,
    log: req.log,
  });
  res.json({ data: result });
}

/** POST /api/admin/types */
async function create(req, res) {
  const result = await paperTypeService.createType({ ...req.body, actor: req.user, log: req.log });
  res.status(201).json({ data: result });
}

/** PATCH /api/admin/types/:typeId */
async function update(req, res) {
  const type = await paperTypeService.updateType({
    typeId: req.params.typeId,
    ...req.body,
    actor: req.user,
    log: req.log,
  });
  res.json({ data: type });
}

/** DELETE /api/admin/types/:typeId */
async function remove(req, res) {
  await paperTypeService.deleteType({ typeId: req.params.typeId, actor: req.user, log: req.log });
  res.status(204).end();
}

module.exports = { index, show, showDraft, card, create, update, remove, startDraft, discardDraft, publish };
