# 11 · Developer guide

This guide is for developers joining the project, especially if you are new to
Express. Read [04 · Architecture](04-architecture.md) §3 first.

## 1. Coding conventions

| Topic | Rule |
|-------|------|
| Modules | CommonJS (`require` / `module.exports`) on the server — no build step. Native ES modules (`import`) in `public/js/`. |
| Async | `async` / `await` everywhere. No callbacks, no `.then()` chains. |
| Naming | Files `camelCase.role.js` (`paper.service.js`). Functions are verbs (`getOwnedPaper`, `saveAnswer`). Booleans start with `is` / `has` (`isMandatory`). |
| Size | Functions ≤ ~40 lines; files ≤ ~300 lines. Split when bigger. |
| Comments | JSDoc on every exported function. Inline comments explain **why**, not what. |
| Config | Only `src/config` reads `process.env`. |
| SQL | Only in `src/models`. Always parameterised. One model per table. |
| Business rules | Only in `src/services` (and the pure `utils/readinessRules.js`). |
| Errors | Throw `AppError` subclasses; never `res.status(500).send(err.message)`. See 09. |
| Logging | `req.log` / child loggers; never `console.log`. |
| Views | Escaped output `<%= %>` only; keep logic out of templates (prepare a view model in the service). |
| Front end | One module per page; shared helpers in `public/js/lib`. Insert text with `textContent`. |
| Formatting | Prettier (2 spaces, single quotes, semicolons, width 110). ESLint must pass. |
| Git | Branch `feat/<REQ-ID>-short-name`; small PRs (< 400 lines); one approval needed; squash merge. Commit messages: `feat(papers): create paper dialog (FR-PAP-02)`. |

## 2. How a feature is put together — worked example

**Goal:** implement FR-ANS-04 / 05 — save an answer.

### Step 1 · Model (SQL only)

```js
// src/models/answer.model.js
const { query, toCamel } = require('../utils/db');

/**
 * Insert or update one answer.
 * @param {{paperId:string, standardId:string, value:'yes'|'no'|'na'|null, remark:string}} a
 * @returns {Promise<object>} the saved answer
 */
async function upsert({ paperId, standardId, value, remark }) {
  const { rows } = await query(
    `insert into answers (paper_id, standard_id, value, remark, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (paper_id, standard_id)
     do update set value = excluded.value, remark = excluded.remark, updated_at = now()
     returning *`,
    [paperId, standardId, value, remark],
  );
  return toCamel(rows[0]);
}

module.exports = { upsert, /* listForPaper, … */ };
```

### Step 2 · Service (business rules)

```js
// src/services/answer.service.js
const answerModel = require('../models/answer.model');
const standardModel = require('../models/standard.model');
const paperService = require('./paper.service');
const readinessService = require('./readiness.service');
const { ValidationError } = require('../utils/errors');

/**
 * Save the user's answer for one standard and return the new readiness.
 * @throws {NotFoundError} if the paper does not exist
 * @throws {NotOwnerError} if the user is not the owner
 * @throws {ValidationError} if the standard is not part of the paper's type
 */
async function saveAnswer({ user, paperId, standardId, value, remark, log }) {
  const paper = await paperService.getOwnedPaper(user.id, paperId);     // 403 NOT_OWNER if not the owner
  const belongs = await standardModel.belongsToType(standardId, paper.paperTypeId);
  if (!belongs) throw new ValidationError('This standard is not part of the paper type.');

  const answer = await answerModel.upsert({ paperId, standardId, value, remark: remark.trim() });
  await paperService.touch(paperId);                                    // bump updated_at
  const readiness = await readinessService.forPaper(paper);
  log.info({ paperId, standardId, value }, 'Answer saved');            // no remark text in logs
  return { answer, readiness };
}

module.exports = { saveAnswer };
```

### Step 3 · Validator (request shape)

```js
// src/validators/answer.validators.js
const { z } = require('zod');
const saveAnswerSchema = {
  params: z.object({ paperId: z.string().uuid(), standardId: z.string().uuid() }),
  body: z.object({
    value: z.enum(['yes', 'no', 'na']).nullable(),
    remark: z.string().max(2000).default(''),
  }),
};
module.exports = { saveAnswerSchema };
```

### Step 4 · Controller (thin)

```js
// src/controllers/answer.controller.js
const answerService = require('../services/answer.service');

/** PUT /api/papers/:paperId/answers/:standardId */
async function save(req, res) {
  const result = await answerService.saveAnswer({
    user: req.user, ...req.params, ...req.body, log: req.log,
  });
  res.json({ data: result });
}

module.exports = { save };
```

### Step 5 · Route

```js
// src/routes/paper.api.routes.js
const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const answerController = require('../controllers/answer.controller');
const { saveAnswerSchema } = require('../validators/answer.validators');

router.use(requireRole('Architect', 'Admin'));
router.put('/papers/:paperId/answers/:standardId',
  validate(saveAnswerSchema),
  asyncHandler(answerController.save));

module.exports = router;
```

### Step 6 · Front end

```js
// public/js/pages/paper.js (excerpt)
import { api } from '../lib/api.js';
import { renderReadiness, renderSectionChip } from './paperView.js';

async function onAnswerClick(btn) {
  const row = btn.closest('[data-standard-id]');
  const standardId = row.dataset.standardId;
  const value = btn.getAttribute('aria-pressed') === 'true' ? null : btn.dataset.value; // click again = clear
  setPressed(row, value);                       // optimistic UI
  try {
    const data = await api(`/api/papers/${paperId}/answers/${standardId}`, {
      method: 'PUT', body: { value, remark: row.querySelector('textarea').value },
    });
    renderReadiness(data.readiness);
  } catch {
    setPressed(row, previousValue);             // roll back; api() already showed a toast
  }
}
```

### Step 7 · Tests

```js
// tests/unit/readinessRules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { readiness } = require('../../src/utils/readinessRules');

test('FR-RDY: mandatory "No" blocks readiness', () => {
  const r = readiness(fixture({ answers: { s4: { value: 'no', remark: 'plan in Q1' } } }));
  assert.equal(r.ready, false);
  assert.equal(r.gaps[0].code, 'MANDATORY_NO');
});
```

```js
// tests/integration/answers.test.js
test('PUT answer on someone else\'s paper returns 403 NOT_OWNER', async () => {
  const res = await agentAs(userB).put(`/api/papers/${paperOfA}/answers/${std}`)
    .set('X-CSRF-Token', csrfB).send({ value: 'yes', remark: '' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'NOT_OWNER');
});
```

## 3. How to add a new AI provider (e.g. Azure OpenAI later)

1. Create `src/providers/ai/<name>Provider.js` implementing `compareSection`,
   `answerQuestion` and `healthCheck` (07 · §2).
2. Convert its SDK errors with `toAiError()`.
3. Add a `case` to `src/factories/aiProviderFactory.js`.
4. Add its variables to `src/config/index.js` and `.env.example`.
5. Run the provider-contract tests (`tests/unit/aiProviderContract.test.js`)
   against a fake HTTP layer, then `npm run ai:smoke -- --provider=<name>`.
6. Document it in 07 · §6.

## 4. How to change a prompt

1. **Copy** `compare-section.md` → bump `version` in the front matter (for
   example `1.1.0`). Don't change meaning without a version bump.
2. Run `npm test` (the prompt snapshot test will fail — review the diff, then
   update the snapshot).
3. Run `npm run ai:smoke` on **Gemini and Bedrock** and read the verdict
   table for the fixture papers.
4. In the PR description, paste the before / after verdict tables and say what
   changed and why.

## 5. How to add a database change

1. Add `db/migrations/00N_short_description.sql` (never edit an applied one).
2. Make it **backward compatible** (add columns as nullable or with defaults;
   remove columns in a later release).
3. Run `npm run db:migrate` locally; update the model and 05 · Data model.

## 6. Debugging tips

| Problem | Try |
|---------|-----|
| "Invalid state" after sign-in | Cookies blocked, or two tabs signing in at once; clear the cookies for localhost. |
| 403 everywhere | Your account has no app role in the **dev** enterprise app. |
| CSS changes not visible | Is `npm run dev` running the Tailwind watcher? Hard refresh. |
| PDF thumbnails blank | Check the browser console for the pdf.js worker path / CSP `worker-src`. |
| AI check fails instantly | `LOG_LEVEL=debug`, look for `AiProviderError` with `code`; check the API key / quota. |
| Find a user's error | Ask for the "ref" in the toast; search logs for that `requestId`. |
