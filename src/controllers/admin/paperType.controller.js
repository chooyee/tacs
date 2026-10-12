'use strict';

/**
 * Admin pages and API for paper types (FR-ADM-01…03, FR-ADM-10). Thin: rules are in the services.
 */
const paperTypeService = require('../../services/paperType.service');

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

/** GET /admin/types/:typeId — the editor. */
async function show(req, res) {
  const editor = await paperTypeService.getEditor(req.params.typeId);
  res.render('layouts/main', {
    page: 'pages/admin/type',
    title: editor.type.name,
    pageScript: 'adminType',
    adminTab: 'types',
    ...editor,
  });
}

/**
 * GET /admin/types/:typeId/cards/:card — one card re-rendered as an HTML fragment, so the page can
 * refresh after a change without a second copy of the markup in JavaScript.
 */
async function card(req, res) {
  const editor = await paperTypeService.getEditor(req.params.typeId);
  res.render(`partials/admin/${req.params.card}Card`, editor);
}

/** POST /api/admin/types */
async function create(req, res) {
  const result = await paperTypeService.createType({ ...req.body, log: req.log });
  res.status(201).json({ data: result });
}

/** PATCH /api/admin/types/:typeId */
async function update(req, res) {
  const type = await paperTypeService.updateType({ typeId: req.params.typeId, ...req.body, log: req.log });
  res.json({ data: type });
}

/** DELETE /api/admin/types/:typeId */
async function remove(req, res) {
  await paperTypeService.deleteType({ typeId: req.params.typeId, log: req.log });
  res.status(204).end();
}

module.exports = { index, show, card, create, update, remove };
