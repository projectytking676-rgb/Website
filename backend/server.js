import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters. Set it in Railway Variables.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Attach a Railway PostgreSQL service.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

app.set('trust proxy', 1);
app.use(helmet());
const allowed = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowed.includes('*') || allowed.includes(origin)), credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/admin/login', rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false }));

const cleanPath = p => String(p || '').split('/').filter(Boolean).map(x => decodeURIComponent(x)).join('/');
const tokenFor = user => jwt.sign({ sub: String(user.id), email: user.email, role: 'admin' }, JWT_SECRET, { expiresIn: '8h', issuer: 'project-yt-api' });
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { const payload = jwt.verify(token, JWT_SECRET, { issuer: 'project-yt-api' }); if (payload.role !== 'admin') throw new Error('role'); req.admin = payload; next(); }
  catch { res.status(401).json({ error: 'AUTH_REQUIRED' }); }
}
async function readPath(p) {
  const exact = await pool.query('SELECT value FROM app_data WHERE path=$1', [p]);
  if (exact.rowCount) return exact.rows[0].value;
  const prefix = p ? p + '/' : '';
  const children = await pool.query('SELECT path,value FROM app_data WHERE path LIKE $1 ORDER BY path', [prefix + '%']);
  if (!children.rowCount) return null;
  const root = {};
  for (const row of children.rows) {
    const rest = row.path.slice(prefix.length).split('/');
    let cur = root;
    for (let i = 0; i < rest.length - 1; i++) cur = cur[rest[i]] ??= {};
    cur[rest.at(-1)] = row.value;
  }
  return root;
}
async function writePath(p, value) {
  if (!p) throw new Error('Root writes are not allowed');
  await pool.query('DELETE FROM app_data WHERE path=$1 OR path LIKE $2', [p, p + '/%']);
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    const entries = [];
    const walk = (v, at) => { const keys = Object.keys(v); if (!keys.length) entries.push([at, JSON.stringify({})]); else for (const k of keys) { const next = at ? at + '/' + k : k; const child = v[k]; if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length) walk(child, next); else entries.push([next, JSON.stringify(child)]); } };
    walk(value, p);
    for (const [at, json] of entries) await pool.query('INSERT INTO app_data(path,value) VALUES($1,$2::jsonb) ON CONFLICT(path) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [at, json]);
  } else {
    await pool.query('INSERT INTO app_data(path,value) VALUES($1,$2::jsonb) ON CONFLICT(path) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [p, JSON.stringify(value)]);
  }
}
async function patchPath(p, patch) {
  const current = await readPath(p) || {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('PATCH target must be an object');
  await writePath(p, { ...current, ...patch });
}
async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 12) { console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set; admin login disabled until configured.'); return; }
  const hash = await bcrypt.hash(password, 12);
  await pool.query('INSERT INTO admin_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash', [email, hash]);
}

app.get('/health', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'project-yt-api' }); } catch { res.status(503).json({ ok: false }); } });
app.post('/api/admin/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const q = await pool.query('SELECT id,email,password_hash FROM admin_users WHERE email=$1', [email]);
  if (!q.rowCount || !(await bcrypt.compare(password, q.rows[0].password_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  res.json({ token: tokenFor(q.rows[0]), user: { email: q.rows[0].email } });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));

// Admin-only generic data API. Paths map the old Firebase nodes: FIXA_MODS, FIXA_CONFIG, ADMIN_ACTIVITY.
app.get('/api/admin/data/*', requireAdmin, async (req, res) => { const p = cleanPath(req.params[0]); res.json({ value: await readPath(p) }); });
app.put('/api/admin/data/*', requireAdmin, async (req, res) => { try { const p = cleanPath(req.params[0]); await writePath(p, req.body?.value); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.patch('/api/admin/data/*', requireAdmin, async (req, res) => { try { const p = cleanPath(req.params[0]); await patchPath(p, req.body?.value || {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/admin/data/*', requireAdmin, async (req, res) => { const p = cleanPath(req.params[0]); await pool.query('DELETE FROM app_data WHERE path=$1 OR path LIKE $2', [p, p + '/%']); res.json({ ok: true }); });
app.post('/api/admin/activity', requireAdmin, async (req, res) => {
  const id = `ADMIN_ACTIVITY/${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const value = { action: String(req.body?.action || 'Action').slice(0, 120), key: String(req.body?.key || '').slice(0, 160), time: new Date().toISOString(), admin: req.admin.email };
  await writePath(id, value); res.json({ ok: true });
});

// App-facing routes. The server, not the client, enforces status, expiry and device caps.
app.post('/api/app/verify', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!key || !deviceId || key.length > 160 || deviceId.length > 200) return res.status(400).json({ valid: false, reason: 'KEY_AND_DEVICE_REQUIRED' });
  const row = await readPath(`FIXA_MODS/${key}`);
  if (!row || typeof row !== 'object') return res.status(404).json({ valid: false, reason: 'INVALID_KEY' });
  const status = String(row.keyStatus || 'ACTIVE').toUpperCase();
  if (['BANNED','BLOCKED','DISABLED','INACTIVE'].includes(status)) return res.status(403).json({ valid: false, reason: status, message: row.banReason || row.blockReason || row.disableReason || status });
  const expiry = parseExpiry(row.validity);
  if (expiry && expiry <= Date.now()) return res.status(403).json({ valid: false, reason: 'EXPIRED' });
  // Keep registered devices in the same legacy node the admin panel manages.
  const registered = row.devices && typeof row.devices === 'object' ? row.devices : {};
  const ids = Object.keys(registered).filter(id => registered[id] === true || registered[id] === 1 || registered[id] === 'true');
  const known = Object.prototype.hasOwnProperty.call(registered, deviceId);
  const max = Math.max(1, Number(row.maxDevices ?? row.devicesMax ?? 1) || 1);
  if (!known && ids.length >= max) return res.status(403).json({ valid: false, reason: 'DEVICE_LIMIT', used: ids.length, max });
  if (!known) await writePath(`FIXA_MODS/${key}/devices/${deviceId}`, true);
  const used = known ? ids.length : ids.length + 1;
  res.json({ valid: true, message: 'OK', key: { username: row.username || '', keyType: row.keyType || 'PAID', keyStatus: status, status: row.status || 'ACTIVE', validity: row.validity || '', deviceCount: used, maxDevices: max } });
});
app.get('/api/app/config', async (_req, res) => {
  const [global, brandingUpper, brandingLower, switches, support, maintenance, offlineBypass] = await Promise.all([
    readPath('FIXA_CONFIG/global'), readPath('FIXA_CONFIG/BRANDING'), readPath('FIXA_CONFIG/branding'), readPath('FIXA_CONFIG/switches'), readPath('FIXA_CONFIG/support'), readPath('FIXA_CONFIG/maintenance'), readPath('FIXA_CONFIG/offlineBypass')
  ]);
  res.json({ global, branding: brandingUpper || {}, brandingLegacy: brandingLower || {}, switches, support, maintenance, offlineBypass });
});
app.get('/api/app/key/:key', async (req, res) => {
  const row = await readPath(`FIXA_MODS/${String(req.params.key).slice(0,160)}`);
  if (!row) return res.status(404).json({ error: 'KEY_NOT_FOUND' });
  // Keep this endpoint limited to fields required by the floating menu; no private device identifiers.
  res.json({ keyStatus: row.keyStatus || '', status: row.status || '', validity: row.validity || '', username: row.username || '', keyType: row.keyType || 'PAID', maxDevices: row.maxDevices || 1 });
});

function parseExpiry(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) { const t = Date.parse(value); return Number.isNaN(t) ? null : t; }
  return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
await pool.query(schema);
await ensureAdmin();
app.listen(PORT, '0.0.0.0', () => console.log(`PROJECT YT API listening on ${PORT}`));
