# PROJECT YT — Railway backend starter

This package creates a Node.js + PostgreSQL API intended to replace direct Firebase database access. It is a backend foundation, **not yet a complete drop-in replacement for the uploaded Android and web clients**.

## What is included
- Express API with JWT admin authentication and bcrypt password hashing.
- PostgreSQL JSON-path store for legacy nodes such as `FIXA_MODS`, `FIXA_CONFIG`, and `ADMIN_ACTIVITY`.
- Admin-only read/write/patch/delete endpoints.
- App-facing license verification with expiry/status checks and server-side device limits.
- Public app configuration and limited key-status endpoints.
- Original uploaded `index.html`, `LoginActivity.java`, and `FloatingActivity.java` copied unchanged for reference.

## Important before production
The original three clients still call Firebase. Do not remove Firebase or change its database rules until the clients have been migrated and tested against this API. The included admin data routes are not a Firebase SDK compatibility layer; the web panel needs its Firebase calls replaced with authenticated API calls, and both Java activities need their Firebase listeners/writes converted to HTTP calls. Keep Firebase active during the transition and export/back up the existing data first.

## Local run
1. Install Node.js 20+ and PostgreSQL.
2. Copy `.env.example` to `.env` and set real values.
3. In `backend/`: `npm install` then `npm start`.
4. Check `GET /health`.

## Railway deployment
1. Push this folder/repository to a private GitHub repository.
2. In Railway, create a project and add a PostgreSQL database.
3. Add a Node service from the GitHub repository. Set its Root Directory to `/backend` if using this monorepo layout.
4. Add variables to the Node service:
   - `DATABASE_URL` = reference the Postgres service's `DATABASE_URL` variable (Railway variable reference syntax shown in Railway's Variables UI).
   - `JWT_SECRET` = long random secret (32+ characters).
   - `ADMIN_EMAIL` = your admin email.
   - `ADMIN_PASSWORD` = unique password of at least 12 characters.
   - `NODE_ENV` = `production`.
   - `CORS_ORIGIN` = exact admin-panel origin once known; do not leave `*` for production.
5. Deploy, then open service Settings → Networking and generate a public domain.
6. Test `https://YOUR-DOMAIN/health`.

Railway docs: https://docs.railway.com/quick-start , https://docs.railway.com/databases/postgresql , https://docs.railway.com/variables

## API overview
- `POST /api/admin/login` — `{ "email": "...", "password": "..." }`; returns JWT.
- `GET /api/admin/me` — Bearer JWT.
- `GET /api/admin/data/FIXA_MODS` — Bearer JWT.
- `PUT /api/admin/data/FIXA_CONFIG/global` — Bearer JWT, body `{ "value": { ... } }`.
- `PATCH /api/admin/data/FIXA_MODS/KEY` — Bearer JWT, body `{ "value": { "keyStatus": "ACTIVE" } }`.
- `DELETE /api/admin/data/FIXA_MODS/KEY` — Bearer JWT.
- `POST /api/app/verify` — `{ "key": "...", "deviceId": "..." }`.
- `GET /api/app/config` — public app config.
- `GET /api/app/key/KEY` — limited public key fields.

## Migration sequence
1. Back up/export the current Firebase Realtime Database and retain a private copy.
2. Deploy this API and configure the first admin account.
3. Import existing Firebase nodes into PostgreSQL (a dedicated importer is still required).
4. Migrate `index.html` authentication and data operations to `/api/admin/*`.
5. Migrate `LoginActivity.java` key verification to `POST /api/app/verify`.
6. Migrate `FloatingActivity.java` config/key listeners to periodic HTTPS GETs (or add authenticated polling/SSE).
7. Test create/edit/delete keys, expiry, device limit, branding, switches, maintenance, and logout on a test key.
8. Only after all tests pass, lock down or disable Firebase rules/services.

Never put `JWT_SECRET`, database credentials, or admin password in HTML or APK. A public API URL is not a secret. Use HTTPS and server-side authorization; no system can be guaranteed unhackable.
