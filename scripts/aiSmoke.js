'use strict';

/**
 * Live smoke test of the AI layer (docs/07 §10). Sends a paper PDF and the paper type's references
 * to the configured provider, section by section, validates the JSON and prints a verdict table.
 * Nothing is saved. Run it by hand before releases and after changing prompts or models:
 *
 *   npm run ai:smoke -- --paper=path/to/test-paper.pdf [--type=SaaS] [--provider=gemini|bedrock|fake]
 *
 * TEST DOCUMENTS ONLY with Gemini (D-13). Production prompts must also be smoke-tested on Bedrock.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [key, ...rest] = a.slice(2).split('=');
      return [key, rest.join('=') || true];
    }),
);
if (args.provider) process.env.AI_PROVIDER = args.provider; // before the config is loaded

const config = require('../src/config');
const db = require('../src/utils/db');
const paperTypeModel = require('../src/models/paperType.model');
const sectionModel = require('../src/models/section.model');
const standardModel = require('../src/models/standard.model');
const referenceModel = require('../src/models/reference.model');
const { getStorage } = require('../src/factories/storageFactory');
const { getAiProvider } = require('../src/factories/aiProviderFactory');
const { compareResponseSchema } = require('../src/ai/schemas/compareResult');
const { batchesFor } = require('../src/services/check.service');
const { inspectPdf } = require('../src/utils/pdfInfo');
const { logger } = require('../src/utils/logger');

// A table for a person to read, so plain stdout (as in adminUser.js), not the JSON logger.
const say = (line = '') => process.stdout.write(`${line}\n`);

async function readKey(key) {
  const file = await getStorage().get(key);
  const chunks = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!args.paper) throw new Error('Give the paper PDF: --paper=path/to/test-paper.pdf');
  const bytes = fs.readFileSync(args.paper);
  const { pageCount } = await inspectPdf(bytes);
  const typeName = String(args.type ?? 'SaaS').toLowerCase();
  const type = (await paperTypeModel.listWithStats()).find((t) => t.name.toLowerCase() === typeName);
  if (!type) throw new Error(`No paper type named "${args.type ?? 'SaaS'}"`);

  const provider = getAiProvider();
  say(`Provider ${provider.name} · model ${provider.model} · ${type.name} · ${path.basename(args.paper)} (${pageCount} pages)\n`);
  const [sections, standards] = await Promise.all([sectionModel.listForType(type.id), standardModel.listForType(type.id)]);
  const refs = (await Promise.all([...new Set(standards.flatMap((s) => s.referenceIds))].map((id) => referenceModel.findById(id)))).filter(Boolean);
  const refById = new Map(refs.map((r) => [r.id, r]));
  const refKey = new Map(refs.map((r, i) => [r.id, `R${i + 1}`]));
  const paperFiles = [{ key: 'P1', name: path.basename(args.paper), mimeType: 'application/pdf', pageCount, bytes }];
  const rows = [];
  let tokens = { inputTokens: 0, outputTokens: 0 };

  for (const section of sections) {
    const own = standards.filter((s) => s.sectionId === section.id);
    for (const batch of batchesFor(own, refById, Math.max(1, config.ai.maxDocsPerRequest - 1), logger)) {
      const input = {
        paperTypeName: type.name,
        paperFiles,
        standards: batch.standards.map((s) => ({
          key: `S${s.number}`,
          number: s.number,
          text: s.title,
          mandatory: s.isMandatory,
          referenceKeys: s.usedReferenceIds.map((id) => refKey.get(id)),
        })),
        references: await Promise.all(
          batch.referenceIds.map(async (id) => {
            const r = refById.get(id);
            return { key: refKey.get(id), name: r.fileName, mimeType: r.mimeType, bytes: await readKey(r.s3Key), type: r.type, title: r.title, note: r.note ?? '' };
          }),
        ),
      };
      const started = Date.now();
      const out = await provider.compareSection(input);
      const data = typeof out.raw === 'string' ? JSON.parse(out.raw) : out.raw;
      const parsed = compareResponseSchema.safeParse(data);
      tokens = { inputTokens: tokens.inputTokens + out.usage.inputTokens, outputTokens: tokens.outputTokens + out.usage.outputTokens };
      say(`${section.title}: ${input.standards.length} standards, ${input.references.length} references, ${Date.now() - started} ms, schema ${parsed.success ? 'OK' : 'INVALID'}`);
      if (!parsed.success) {
        say(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
        continue;
      }
      for (const r of parsed.data.results) rows.push(r);
    }
  }

  say('\n| # | verdict | page | area | ref | finding |\n|---|---------|------|------|-----|---------|');
  for (const r of rows.sort((a, b) => Number(a.standardKey.slice(1)) - Number(b.standardKey.slice(1)))) {
    say(`| ${r.standardKey} | ${r.verdict} | ${r.page ?? '—'} | ${r.area ?? '—'} | ${r.referenceKey ?? '—'} | ${r.finding.replace(/\|/g, '/').slice(0, 120)} |`);
  }
  say(`\n${rows.length}/${standards.length} results · tokens in ${tokens.inputTokens}, out ${tokens.outputTokens}`);
}

main()
  .catch((err) => {
    say(`ai:smoke failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
