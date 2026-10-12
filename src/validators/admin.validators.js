'use strict';

/**
 * Request schemas for the admin API (docs/06 §4). Text is trimmed; an empty optional text field
 * means "no value" (null). Rich text arrives as HTML and is cleaned by the service (D-37).
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
/** Rich text (HTML from the editor). Size-limited here; cleaned in the service. */
const richText = (max) => z.string().max(max, 'This text is too long.').optional();
/** The most links one reference may have (D-39). */
const MAX_REFERENCE_LINKS = 10;
/**
 * The ordered links of a reference (D-39). Multipart forms carry them as one JSON string field,
 * e.g. links='[{"label":"Policy Hub","url":"https://…"}]'; the first link is the main one.
 */
const referenceLinks = z
  .preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value; // not JSON: the array check below reports it
      }
    },
    z
      .array(
        z
          .object({
            label: text(120, 'Link label'),
            url: z
              .string()
              .trim()
              .max(2000, 'The address must be at most 2000 characters.')
              .regex(/^https:\/\/[^\s]+$/, 'Use a full address that starts with https://'),
          })
          .strict(),
        'The links could not be read.',
      )
      .max(MAX_REFERENCE_LINKS, `Add at most ${MAX_REFERENCE_LINKS} links.`),
  )
  .optional();
const REFERENCE_TYPES = ['Policy', 'Sample', 'Template', 'Guide'];

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
  moveSection: { ...sectionId, body: z.object({ direction: z.enum(['up', 'down']) }).strict() },
  reorderSections: { ...typeId, body: z.object({ sectionIds: z.array(id).min(1).max(200) }).strict() },
  addStandard: {
    ...sectionId,
    body: z
      .object({
        title: text(500, 'The title'),
        description: richText(30_000),
        isMandatory: z.boolean().optional(),
        referenceIds: z.array(id).max(50).optional(),
      })
      .strict(),
  },
  updateStandard: {
    ...standardId,
    body: z
      .object({
        title: text(500, 'The title').optional(),
        description: richText(30_000),
        isMandatory: z.boolean().optional(),
        referenceIds: z.array(id).max(50).optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to change.'),
  },
  // Buttons send a direction; drag and drop sends the target section and position.
  moveStandard: {
    ...standardId,
    body: z.union([
      z.object({ direction: z.enum(['up', 'down']) }).strict(),
      z.object({ sectionId: id, index: z.number().int().min(0).max(1000) }).strict(),
    ]),
  },
  standardForm: {
    params: z.object({ typeId: id.optional(), standardId: id.optional() }),
    query: z.object({ section: id.optional() }).loose(),
  },
  // Import other types' standards as live links (D-38).
  importStandards: {
    ...typeId,
    body: z
      .object({
        standardIds: z.array(id).min(1).max(500),
        mode: z.enum(['sections', 'into']),
        targetSectionId: id.optional(),
      })
      .strict()
      .refine((b) => b.mode === 'sections' || b.targetSectionId, 'Choose the section to import into.'),
  },
  // multipart/form-data: every field arrives as a string; the file is checked by the service.
  addReference: {
    body: z
      .object({
        type: z.enum(REFERENCE_TYPES, 'Choose Policy, Sample, Template or Guide.'),
        title: text(200, 'Title'),
        links: referenceLinks,
        guidance: richText(100_000),
      })
      .strict(),
  },
  updateReference: {
    ...referenceId,
    body: z
      .object({
        type: z.enum(REFERENCE_TYPES, 'Choose Policy, Sample, Template or Guide.').optional(),
        title: text(200, 'Title').optional(),
        links: referenceLinks,
        guidance: richText(100_000),
      })
      .strict(),
  },
};
