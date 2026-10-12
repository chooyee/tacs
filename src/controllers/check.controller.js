'use strict';

/**
 * AI checks, results and the chat (docs/06 §3). Thin: the rules live in check.service and
 * chat.service. Every write is owner-only (checked in the services, FR-AI-18).
 */
const { pipeline } = require('node:stream/promises');
const checkService = require('../services/check.service');
const chatService = require('../services/chat.service');
const documentService = require('../services/document.service');
const { contentDisposition } = require('./reference.controller');

const ctx = (req) => ({ user: req.user, paperId: req.params.paperId, log: req.log });

/**
 * Runs before the upload middleware: refuse early, and hold one upload slot per user until the
 * response is sent (see checkService.beforeUpload).
 */
async function precheckUpload(req, res, next) {
  const release = await checkService.beforeUpload({ user: req.user, paperId: req.params.paperId });
  res.on('close', release);
  next();
}

/** POST /api/papers/:paperId/checks — multipart files[] (1–3 PDFs) */
async function upload(req, res) {
  res.status(202).json({ data: await checkService.uploadAndCheck({ ...ctx(req), files: req.files }) });
}

/** POST /api/papers/:paperId/checks/rerun */
async function rerun(req, res) {
  res.status(202).json({ data: await checkService.recheck(ctx(req)) });
}

/** GET /api/checks/:checkId — polled every 2 s */
async function status(req, res) {
  res.json({ data: await checkService.getStatus(req.params.checkId) });
}

/** GET /api/papers/:paperId/checks/latest */
async function latest(req, res) {
  res.json({ data: await checkService.getLatest({ paperId: req.params.paperId }) });
}

/** POST /api/papers/:paperId/results/:standardId/apply */
async function apply(req, res) {
  res.json({ data: await checkService.applyResult({ ...ctx(req), standardId: req.params.standardId }) });
}

/** POST /api/papers/:paperId/results/:standardId/keep */
async function keep(req, res) {
  res.json({ data: await checkService.keepAnswer({ ...ctx(req), standardId: req.params.standardId }) });
}

/** POST /api/papers/:paperId/results/apply-unanswered */
async function applyUnanswered(req, res) {
  res.json({ data: await checkService.applyUnanswered(ctx(req)) });
}

/** GET /api/papers/:paperId/chat */
async function chat(req, res) {
  res.json({ data: await chatService.listMessages({ paperId: req.params.paperId }) });
}

/** POST /api/papers/:paperId/chat */
async function chatPost(req, res) {
  res.json({ data: await chatService.postMessage({ ...ctx(req), text: req.body.text }) });
}

/** POST /api/papers/:paperId/chat/quick */
async function chatQuick(req, res) {
  res.json({ data: await chatService.quickAction({ ...ctx(req), ...req.body }) });
}

/** GET /files/documents/:documentId — stream a paper PDF through the app (never a public S3 link). */
async function document(req, res) {
  const { stream, contentLength, fileName } = await documentService.openDocument(req.params.documentId);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition(fileName),
    'Cache-Control': 'private, max-age=300',
  });
  if (contentLength) res.set('Content-Length', String(contentLength));
  await pipeline(stream, res);
}

module.exports = { precheckUpload, upload, rerun, status, latest, apply, keep, applyUnanswered, chat, chatPost, chatQuick, document };
