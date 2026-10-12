'use strict';

/**
 * Admin API for sections and standards (FR-ADM-14…19, FR-ADM-21). Thin: rules are in the services.
 * `actor` (the signed-in user) is passed so each change records who made it (D-37).
 */
const sectionService = require('../../services/section.service');
const standardService = require('../../services/standard.service');

const ctx = (req) => ({ actor: req.user, log: req.log });

/** POST /api/admin/types/:typeId/sections */
async function addSection(req, res) {
  const section = await sectionService.addSection({
    typeId: req.params.typeId,
    title: req.body.title,
    ...ctx(req),
  });
  res.status(201).json({ data: { id: section.id, title: section.title } });
}

/** PATCH /api/admin/sections/:sectionId */
async function renameSection(req, res) {
  const section = await sectionService.renameSection({ ...req.params, title: req.body.title, ...ctx(req) });
  res.json({
    data: {
      id: section.id,
      title: section.title,
      updatedAt: section.updatedAt,
      updatedBy: section.updatedBy,
    },
  });
}

/** POST /api/admin/types/:typeId/sections/order — drag and drop of sections */
async function reorderSections(req, res) {
  await sectionService.reorderSections({
    typeId: req.params.typeId,
    orderedIds: req.body.sectionIds,
    ...ctx(req),
  });
  res.status(204).end();
}

/** POST /api/admin/sections/:sectionId/move */
async function moveSection(req, res) {
  await sectionService.moveSection({ ...req.params, direction: req.body.direction, ...ctx(req) });
  res.status(204).end();
}

/** DELETE /api/admin/sections/:sectionId */
async function deleteSection(req, res) {
  await sectionService.deleteSection({ ...req.params, ...ctx(req) });
  res.status(204).end();
}

/** POST /api/admin/sections/:sectionId/restore */
async function restoreSection(req, res) {
  await sectionService.restoreSection({ ...req.params, ...ctx(req) });
  res.status(204).end();
}

/** POST /api/admin/sections/:sectionId/standards */
async function addStandard(req, res) {
  const standard = await standardService.addStandard({ ...req.params, ...req.body, ...ctx(req) });
  res
    .status(201)
    .json({ data: { id: standard.id, title: standard.title, isMandatory: standard.isMandatory } });
}

/** PATCH /api/admin/standards/:standardId */
async function updateStandard(req, res) {
  const { standard, warnings } = await standardService.updateStandard({
    ...req.params,
    ...req.body,
    ...ctx(req),
  });
  res.json({
    data: { id: standard.id, title: standard.title, isMandatory: standard.isMandatory, warnings },
  });
}

/** POST /api/admin/standards/:standardId/move — { direction } or { sectionId, index } */
async function moveStandard(req, res) {
  await standardService.moveStandard({ ...req.params, ...req.body, ...ctx(req) });
  res.status(204).end();
}

/** DELETE /api/admin/standards/:standardId */
async function deleteStandard(req, res) {
  await standardService.deleteStandard({ ...req.params, ...ctx(req) });
  res.status(204).end();
}

/** POST /api/admin/standards/:standardId/restore */
async function restoreStandard(req, res) {
  await standardService.restoreStandard({ ...req.params, ...ctx(req) });
  res.status(204).end();
}

/** GET /admin/types/:typeId/standards/new and /admin/standards/:standardId — the full form (D-38). */
async function form(req, res) {
  const vm = await standardService.getStandardForm({
    typeId: req.params.typeId,
    standardId: req.params.standardId,
    sectionId: req.query.section,
  });
  res.render('layouts/main', {
    page: 'pages/admin/standard',
    title: vm.standard ? vm.standard.title : res.locals.t.standardForm.newTitle,
    pageScript: 'adminStandard',
    adminTab: 'types',
    usesRichEditor: true,
    ...vm,
  });
}

/** POST /api/admin/standards/:standardId/duplicate — turn a live link into an own copy. */
async function duplicateStandard(req, res) {
  await standardService.detachStandard({ ...req.params, ...ctx(req) });
  res.status(204).end();
}

/** GET /api/admin/types/:typeId/tree — sections and standards for the Import picker. */
async function importTree(req, res) {
  res.json({ data: await standardService.getImportTree(req.params.typeId) });
}

/** POST /api/admin/types/:typeId/import — link standards of other types (D-38). */
async function importStandards(req, res) {
  const result = await standardService.importStandards({
    typeId: req.params.typeId,
    ...req.body,
    ...ctx(req),
  });
  res.json({ data: result });
}

module.exports = {
  form,
  duplicateStandard,
  importTree,
  importStandards,
  addSection,
  renameSection,
  reorderSections,
  moveSection,
  deleteSection,
  restoreSection,
  addStandard,
  updateStandard,
  moveStandard,
  deleteStandard,
  restoreStandard,
};
