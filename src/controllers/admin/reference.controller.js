'use strict';

/**
 * Admin API for reference documents (FR-ADM-11…13). Multipart bodies: the file is in `req.file`
 * (multer), the other fields in `req.body` (validated with zod before this runs).
 */
const referenceService = require('../../services/reference.service');

/** POST /api/admin/types/:typeId/references */
async function add(req, res) {
  const ref = await referenceService.addReference({
    typeId: req.params.typeId,
    fields: req.body,
    file: req.file,
    log: req.log,
  });
  res.status(201).json({ data: referenceService.publicReference(ref) });
}

/** PATCH /api/admin/references/:referenceId */
async function update(req, res) {
  const ref = await referenceService.updateReference({
    referenceId: req.params.referenceId,
    fields: req.body,
    file: req.file,
    log: req.log,
  });
  res.json({ data: referenceService.publicReference(ref) });
}

/** DELETE /api/admin/references/:referenceId */
async function remove(req, res) {
  await referenceService.deleteReference({ referenceId: req.params.referenceId, log: req.log });
  res.status(204).end();
}

/** POST /api/admin/references/:referenceId/restore */
async function restore(req, res) {
  await referenceService.restoreReference({ referenceId: req.params.referenceId, log: req.log });
  res.status(204).end();
}

module.exports = { add, update, remove, restore };
