# Paper Standards Check

Web app for Solution Architects to check their Solution Lab paper against the standards of its paper
type, with an AI checker. Requirements and design: [`docs/`](docs/README.md) (start there).

## Quick start (local)

Prerequisites: Node.js 22, PostgreSQL 16+ (installed locally, or `docker compose up -d`).

1. **Create the databases** (once, as a PostgreSQL superuser, e.g. `psql -U postgres`):

   ```sql
   CREATE ROLE psc LOGIN PASSWORD 'psc';
   CREATE DATABASE psc OWNER psc;
   CREATE DATABASE psc_test OWNER psc;  -- used by npm test
   ```

   Using another database? Put its URL in `.env`. For tests, create the git-ignored
   `tests/test.local.env` with `DATABASE_URL=<same URL>?options=-c%20search_path%3Dtest`: the tests
   then run in their own schema `test` and never touch your data (they refuse to reset `public`).

2. **Install and configure**

   ```bash
   npm install
   cp .env.example .env      # fill in the Entra values (see below)
   npm run db:migrate
   ```

3. **Run**: `npm run dev` → http://localhost:3000 (app restarts on changes, CSS rebuilds on changes).

4. **First start: create the administrator** (D-27, like Keycloak). The log shows
   `No administrator exists yet. Open http://localhost:3000/setup and enter this setup token: …`.
   Open http://localhost:3000, paste the token, choose a username and password. You are signed in as
   the local administrator. (Unattended deploys: set `ADMIN_BOOTSTRAP_USERNAME` / `_PASSWORD` instead.)

   - Everyone else signs in with Microsoft and starts as an **Architect**.
   - The local administrator makes people **Admin** on **Users** (`/admin/users`); later sign-ins
     are at http://localhost:3000/auth/local. Lost the password? `npm run admin -- reset <username>`.

## Entra ID app registration (dev)

See [docs/08 §1.1](docs/08-auth-and-security.md). In short: a *Web* app with redirect URI
`http://localhost:3000/auth/callback`, a client secret, delegated permissions `openid profile email`,
and *Assignment required* on the enterprise application (assign the people / groups allowed in).
No App Roles are needed: roles are managed in the app (D-26). Put the tenant ID, client ID and secret
in `.env`.

## Commands

| Command | Does |
|---------|------|
| `npm run dev` | App with `node --watch` + Tailwind watch |
| `npm run build` | Builds `public/css/app.css` and copies vendor JS to `public/vendor/` |
| `npm start` | Production start (`node src/server.js`) |
| `npm run db:migrate` | Applies new files from `db/migrations/` |
| `npm run admin -- create\|reset <username>` / `list` | Local administrator accounts |
| `npm test` | Unit + integration tests (needs the `psc_test` database) |
| `npm run lint` / `npm run format` | ESLint / Prettier |

## Docker

`docker build -t paper-standards-check .` builds the production image (non-root, `HEALTHCHECK` on
`/health`). Run `npm run db:migrate` as a one-off task before starting a new version.
