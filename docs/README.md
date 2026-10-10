# Paper Standards Check — Build Requirements

> **Start here.** This folder tells you how to build the production version of the
> clickable prototype [`tacs-prototype.html`](../tacs-prototype.html). Open the
> prototype in a browser next to these documents. When a document says *"see
> prototype"*, click through that screen to see the expected behaviour.

## What we are building (in one paragraph)

Solution Architects write papers for the **Solution Lab committee**. Each paper
must follow the standards for its **paper type** (for example *SaaS*, *Cloud
Platform* or *Infrastructure*). This web app lets an architect:

1. pick the paper type and answer every standard with **Yes / No / N/A**,
2. open the **policies, samples, templates and guides** linked to each standard,
3. upload the paper as a **PDF** so an **AI checker** compares it — text,
   diagrams and tables — with those references and says, per standard, whether
   the paper complies,
4. see clearly whether the paper is **Ready for committee** or what to fix.

**Admins** (signed in with Microsoft Entra ID) maintain the paper types,
standards and reference documents.

## How to read these documents

| # | Document | Read it when… |
|---|----------|---------------|
| 01 | [Product overview](01-product-overview.md) | You are new to the project. Goals, users, scope, glossary. |
| 02 | [Functional requirements](02-functional-requirements.md) | You build a feature. Every rule, with IDs and acceptance criteria. |
| 03 | [UI / UX specification](03-ui-ux-specification.md) | You build a screen. Layout, components, states, accessibility. |
| 04 | [Architecture](04-architecture.md) | You need the big picture: stack, MVC, factories, folders, flows. |
| 05 | [Data model](05-data-model.md) | You write SQL or a model file. Tables, columns, relationships. |
| 06 | [API specification](06-api-specification.md) | You write a route, controller or front-end `fetch` call. |
| 07 | [AI integration](07-ai-integration.md) | You work on the AI checker, prompts or providers (Gemini / Bedrock). |
| 08 | [Authentication & security](08-auth-and-security.md) | You touch login, roles, uploads or anything security related. |
| 09 | [Logging & error handling](09-logging-and-errors.md) | Always — every feature must log and handle errors this way. |
| 10 | [Setup, configuration & deployment](10-setup-config-deployment.md) | Day 1: run the app locally. Later: deploy it. |
| 11 | [Developer guide](11-developer-guide.md) | You are about to write code. Conventions + step-by-step examples. |
| 12 | [Delivery plan & testing](12-delivery-plan-and-testing.md) | Planning sprints, writing tests, preparing UAT. |
| 13 | [Decisions & open questions](13-decisions-and-open-questions.md) | Check before assuming anything that is not written down. |

## Key decisions at a glance

| Topic | Decision |
|-------|----------|
| Runtime / web | Node.js (LTS) + Express |
| Views | EJS server-rendered pages + vanilla JavaScript for interactivity |
| UI kit | [Basecoat UI](https://basecoatui.com) (shadcn/ui look, plain HTML) + Tailwind CSS |
| Code structure | MVC + Services, with **factories** (AI provider, storage) and **utilities** |
| Database | PostgreSQL, plain SQL with the `pg` driver (no ORM) |
| File storage | AWS S3 (MinIO locally) |
| Sign-in | Microsoft Entra ID (OIDC) for **everyone**; roles from Entra **App Roles** |
| AI | **AWS Bedrock in UAT / production**, **Gemini (API key) for local development**, switched by config. **No AI framework** (no LangChain etc.) — official SDKs only. Prompts are Markdown files. |
| Long tasks | AI check runs as a background job; the browser polls for progress |
| Visibility | Every signed-in user can **view** every paper (read-only); only the owner edits |
| Retention | Uploaded PDFs, chat history and deleted items are kept **7 days** |
| Logging | `pino` structured logs with a request ID on every line |
| Errors | One `AppError` class family + one central error middleware |

## Requirement keywords

- **MUST** — required for go-live.
- **SHOULD** — expected; skip only with the tech lead's agreement.
- **MAY** — nice to have.

Requirement IDs look like `FR-PAP-03` (functional), `NFR-SEC-02`
(non-functional). Use them in branch names, commits and test names, for example
`feat/FR-PAP-03-answer-standard`.
