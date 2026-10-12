'use strict';

/**
 * Request schemas for papers and answers (docs/06 §3). Text is trimmed; an empty vendor means "no
 * vendor" (null).
 */
const { z } = require('zod');

const id = z.uuid();
const title = z
  .string()
  .trim()
  .min(3, 'The title needs at least 3 characters.')
  .max(150, 'The title must be at most 150 characters.');
const vendor = z
  .string()
  .trim()
  .max(150, 'The vendor must be at most 150 characters.')
  .transform((v) => v || null)
  .nullable();

const paperId = { params: z.object({ paperId: id }) };

module.exports = {
  paperId,

  // GET /papers?tab=all&q=&typeId=&page= — bad values fall back to the defaults instead of failing.
  listPapers: {
    query: z.object({
      tab: z.enum(['mine', 'all']).catch('mine').default('mine'),
      q: z.string().trim().max(100).catch('').default(''),
      typeId: id.nullable().catch(null).default(null),
      page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
    }),
  },

  createPaper: {
    body: z.object({ title, vendor: vendor.optional(), paperTypeId: id }).strict(),
  },

  updatePaper: {
    ...paperId,
    body: z
      .object({ title: title.optional(), vendor: vendor.optional() })
      .strict()
      .refine((b) => b.title !== undefined || b.vendor !== undefined, 'Nothing to change.'),
  },

  checkId: { params: z.object({ checkId: id }) },
  documentId: { params: z.object({ documentId: id }) },
  result: { params: z.object({ paperId: id, standardId: id }) },

  // multipart: only files[]; the service checks them
  upload: { ...paperId, body: z.object({}).strict() },

  chatMessage: {
    ...paperId,
    body: z
      .object({ text: z.string().trim().min(1, 'Type a message.').max(1000, 'Messages can be at most 1000 characters.') })
      .strict(),
  },

  chatQuick: {
    ...paperId,
    body: z.object({ action: z.enum(['gaps', 'refs', 'summary', 'compare']), standardId: id.optional() }).strict(),
  },

  saveAnswer: {
    params: z.object({ paperId: id, standardId: id }),
    body: z
      .object({
        value: z.enum(['yes', 'no', 'na'], 'Answer Yes, No or N/A.').nullable(),
        remark: z.string().max(2000, 'The remark must be at most 2000 characters.').default(''),
      })
      .strict(),
  },
};
