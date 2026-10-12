'use strict';

/**
 * Admin API for sections and standards (FR-ADM-14…19, FR-ADM-21). Thin: rules are in the services.
 */
const sectionService = require('../../services/section.service');
const standardService = require('../../services/standard.service');

/** POST /api/admin/types/:typeId/sections */
async function addSection(req, res) {
  const section = await sectionService.addSection({
    typeId: req.params.typeId,
    title: req.body.title,
    log: req.log,
  });
  res.status(201).json({ data: { id: section.id, title: section.title } });
}

/** PATCH /api/admin/sections/:sectionId */
async function renameSection(req, res) {
  const section = await sectionService.renameSection({ ...req.params, title: req.body.title, log: req.log });
  res.json({ data: { id: section.id, title: section.title } });
}

/** POST /api/admin/sections/:sectionId/move */
async function moveSection(req, res) {
  await sectionService.moveSection({ ...req.params, direction: req.body.direction, log: req.log });
  res.status(204).end();
}

/** DELETE /api/admin/sections/:sectionId */
async function deleteSection(req, res) {
  await sectionService.deleteSection({ ...req.params, log: req.log });
  res.status(204).end();
}

/** POST /api/admin/sections/:sectionId/restore */
async function restoreSection(req, res) {
  await sectionService.restoreSection({ ...req.params, log: req.log });
  res.status(204).end();
}

/** POST /api/admin/sections/:sectionId/standards */
async function addStandard(req, res) {
  const standard = await standardService.addStandard({ ...req.params, text: req.body.text, log: req.log });
  res.status(201).json({ data: { id: standard.id, text: standard.text, isMandatory: standard.isMandatory } });
}

/** PATCH /api/admin/standards/:standardId */
async function updateStandard(req, res) {
  const { standard, warnings } = await standardService.updateStandard({
    ...req.params,
    ...req.body,
    log: req.log,
  });
  res.json({ data: { id: standard.id, text: standard.text, isMandatory: standard.isMandatory, warnings } });
}

/** POST /api/admin/standards/:standardId/move */
async function moveStandard(req, res) {
  await standardService.moveStandard({ ...req.params, direction: req.body.direction, log: req.log });
  res.status(204).end();
}

/** DELETE /api/admin/standards/:standardId */
async function deleteStandard(req, res) {
  await standardService.deleteStandard({ ...req.params, log: req.log });
  res.status(204).end();
}

/** POST /api/admin/standards/:standardId/restore */
async function restoreStandard(req, res) {
  await standardService.restoreStandard({ ...req.params, log: req.log });
  res.status(204).end();
}

module.exports = {
  addSection,
  renameSection,
  moveSection,
  deleteSection,
  restoreSection,
  addStandard,
  updateStandard,
  moveStandard,
  deleteStandard,
  restoreStandard,
};
