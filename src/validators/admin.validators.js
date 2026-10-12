'use strict';

/**
 * Request schemas for the admin API (docs/06 §4). Text is trimmed; an empty optional text field
 * means "no value" (null).
 */
const { z } = require('zod');

const id = z.uuid();
const text = (max, label) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} must be at most ${max} characters.`);
/** Optional text where '' or only spaces means "clear it" (null). */
const optionalText = (max, label) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .transform((v) => v || null)
    .nullable()
    .optional();
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => v || null)
  .refine((v) => v === null || /^https:\/\/[^\s]+$/.test(v), 'The link must start with https://')
  .nullable()
  .optional();
const REFERENCE_TYPES = ['Policy', 'Sample', 'Template', 'Guide'];
const direction = { body: z.object({ direction: z.enum(['up', 'down']) }).strict() };

const typeId = { params: z.object({ typeId: id }) };
const sectionId = { params: z.object({ sectionId: id }) };
const standardId = { params: z.object({ standardId: id }) };
const referenceId = { params: z.object({ referenceId: id }) };

module.exports = {
  typeId,
  sectionId,
  standardId,
  referenceId,
  createType: {
    body: z
      .object({
        name: text(80, 'Name'),
        description: optionalText(300, 'Description'),
        copyFromTypeId: id.optional(),
      })
      .strict(),
  },
  updateType: {
    ...typeId,
    body: z
      .object({ name: text(80, 'Name').optional(), description: optionalText(300, 'Description') })
      .strict()
      .refine((b) => b.name !== undefined || b.description !== undefined, 'Nothing to change.'),
  },
  card: { params: z.object({ typeId: id, card: z.enum(['references', 'standards']) }) },
  addSection: { ...typeId, body: z.object({ title: text(150, 'Title') }).strict() },
  renameSection: { ...sectionId, body: z.object({ title: text(150, 'Title') }).strict() },
  moveSection: { ...sectionId, ...direction },
  addStandard: { ...sectionId, body: z.object({ text: text(500, 'The standard') }).strict() },
  updateStandard: {
    ...standardId,
    body: z
      .object({
        text: text(500, 'The standard').optional(),
        isMandatory: z.boolean().optional(),
        referenceIds: z.array(id).max(50).optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to change.'),
  },
  moveStandard: { ...standardId, ...direction },
  // multipart/form-data: every field arrives as a string; the file is checked by the service.
  addReference: {
    ...typeId,
    body: z
      .object({
        type: z.enum(REFERENCE_TYPES, 'Choose Policy, Sample, Template or Guide.'),
        title: text(200, 'Title'),
        url: httpsUrl,
        note: optionalText(500, 'The note'),
      })
      .strict(),
  },
  updateReference: {
    ...referenceId,
    body: z
      .object({
        type: z.enum(REFERENCE_TYPES, 'Choose Policy, Sample, Template or Guide.').optional(),
        title: text(200, 'Title').optional(),
        url: httpsUrl,
        note: optionalText(500, 'The note'),
      })
      .strict(),
  },
};
