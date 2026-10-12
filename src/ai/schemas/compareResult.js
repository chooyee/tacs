'use strict';

/**
 * The JSON the model must return for a compare request (docs/07 §4). The AI is untrusted input:
 * every response is validated with the zod schema before anything is saved. The same shape is
 * written once more as plain JSON Schema, because Gemini (responseJsonSchema) and Bedrock (tool
 * inputSchema) want that; a unit test can compare the two.
 */
const { z } = require('zod');

const compareResultSchema = z.object({
  standardKey: z.string().regex(/^S\d+$/),
  verdict: z.enum(['comply', 'partial', 'gap', 'none']),
  fileKey: z.string().regex(/^P\d+$/).nullable(), // which paper file
  page: z.number().int().min(1).nullable(),
  area: z.enum(['text', 'diagram', 'table']).nullable(),
  // 0–1 fractions of the page, optional
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  finding: z.string().min(1).max(1000), // trimmed to 300 after validation (post-processing)
  referenceKey: z.string().regex(/^R\d+$/).nullable(),
  referencePage: z.number().int().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const compareResponseSchema = z.object({ results: z.array(compareResultSchema) });

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });

/** The same shape as JSON Schema (draft 2020-12 subset both providers understand). */
const compareResponseJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          standardKey: { type: 'string', pattern: '^S\\d+$' },
          verdict: { type: 'string', enum: ['comply', 'partial', 'gap', 'none'] },
          fileKey: nullable('string', { pattern: '^P\\d+$' }),
          page: nullable('integer', { minimum: 1 }),
          area: { type: ['string', 'null'], enum: ['text', 'diagram', 'table', null] },
          bbox: {
            type: ['object', 'null'],
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
          finding: { type: 'string', maxLength: 300 },
          referenceKey: nullable('string', { pattern: '^R\\d+$' }),
          referencePage: nullable('integer', { minimum: 1 }),
          confidence: nullable('number', { minimum: 0, maximum: 1 }),
        },
        required: ['standardKey', 'verdict', 'fileKey', 'page', 'area', 'finding', 'referenceKey', 'referencePage'],
      },
    },
  },
  required: ['results'],
};

module.exports = { compareResultSchema, compareResponseSchema, compareResponseJsonSchema };
