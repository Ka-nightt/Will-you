require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is not set');
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;

// Turso in production; a local SQLite file when TURSO_DATABASE_URL is not set
let url = process.env.TURSO_DATABASE_URL;
if (!url) { fs.mkdirSync('data', { recursive: true }); url = 'file:data/app.db'; }
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const q = async (sql, args = []) => (await db.execute({ sql, args })).rows.map(r => ({ ...r }));
const one = async (sql, args) => (await q(sql, args))[0];
const run = (sql, args = []) => db.execute({ sql, args });

const ready = db.executeMultiple(`
create table if not exists requests(id integer primary key autoincrement, token text unique not null,
  name text, phone text, approved integer not null default 0, created_at text default (datetime('now')));
create table if not exists links(slug text primary key, token text not null references requests(token),
  from_name text, phone text, q text, custom_q text, plan integer not null default 1, created_at text default (datetime('now')));
create table if not exists responses(id integer primary key autoincrement, slug text not null references links(slug),
  name text, date_pick text, time_pick text, venue text, no_count integer, created_at text default (datetime('now')));
`);
ready.catch(() => {});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use('/api', (_req, _res, next) => ready.then(() => next(), next));

// light per-instance rate limiter
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limit = (max) => (req, res, next) => {
  const k = req.ip + req.path; const n = (hits.get(k) || 0) + 1; hits.set(k, n);
  n > max ? res.status(429).json({ error: 'Too many requests' }) : next();
};
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const rand = (b) => crypto.randomBytes(b).toString('hex');

// ---- admin session (signed cookie) ----
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
const isAdmin = (req) => {
  const [exp, sig] = (cookies(req).adm || '').split('.');
  return !!sig && sig.length === 64 && Number(exp) > Date.now() && crypto.timingSafeEqual(Buffer.from(sign(exp)), Buffer.from(sig));
};
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Login required' });
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

// ---- public API ----
app.get('/api/config', (_q, res) => res.json({ adminPhone: process.env.ADMIN_PHONE || '' }));

app.post('/api/request', limit(10), h(async (req, res) => {
  const name = clean(req.body.name, 60), phone = clean(req.body.phone, 20).replace(/\D/g, '');
  if (!name || phone.length < 9) return res.status(400).json({ error: 'Name and phone required' });
  const token = rand(12);
  await run('insert into requests(token,name,phone) values(?,?,?)', [token, name, phone]);
  res.json({ token });
}));

app.get('/api/access/:token', limit(60), h(async (req, res) => {
  const r = await one('select approved from requests where token=?', [req.params.token]);
  res.json({ approved: !!(r && r.approved) });
}));

app.post('/api/links', limit(20), h(async (req, res) => {
  const r = await one('select * from requests where token=? and approved=1', [clean(req.body.token, 64)]);
  if (!r) return res.status(403).json({ error: 'Not approved' });
  const qt = ['bf', 'gf', 'date', 'custom'].includes(req.body.q) ? req.body.q : 'date';
  const custom = qt === 'custom' ? clean(req.body.custom, 200) : null;
  if (qt === 'custom' && !custom) return res.status(400).json({ error: 'Write your question' });
  const plan = req.body.plan === false ? 0 : 1;
  const slug = rand(5);
  await run('insert into links(slug,token,from_name,phone,q,custom_q,plan) values(?,?,?,?,?,?,?)', [slug, r.token, r.name, r.phone, qt, custom, plan]);
  res.json({ slug });
}));

app.get('/api/links/:slug', limit(60), h(async (req, res) => {
  const l = await one('select from_name, phone, q, custom_q, plan from links where slug=?', [req.params.slug]);
  l ? res.json(l) : res.status(404).json({ error: 'Not found' });
}));

app.post('/api/responses', limit(20), h(async (req, res) => {
  const b = req.body;
  if (!(await one('select 1 as x from links where slug=?', [clean(b.slug, 20)]))) return res.status(404).json({ error: 'Not found' });
  await run('insert into responses(slug,name,date_pick,time_pick,venue,no_count) values(?,?,?,?,?,?)',
    [clean(b.slug, 20), clean(b.name, 60), clean(b.date, 20), clean(b.time, 10), clean(b.venue, 120), Math.min(Math.max(parseInt(b.noCount) || 0, 0), 9999)]);
  res.json({ ok: true });
}));

app.get('/api/my-responses/:token', limit(60), h(async (req, res) => {
  res.json(await q(`select r.* from responses r join links l on l.slug=r.slug
    join requests x on x.token=l.token where l.token=? and x.approved=1 order by r.id desc`, [req.params.token]));
}));

// ---- admin API ----
app.post('/api/admin/login', limit(10), (req, res) => {
  if (!same(String(req.body.password || ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Date.now() + 1000 * 60 * 60 * 12);
  res.setHeader('Set-Cookie', `adm=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/api/admin/requests', needAdmin, h(async (_q, res) => res.json(await q('select id,name,phone,approved,created_at from requests order by id desc'))));
app.post('/api/admin/requests/:id', needAdmin, h(async (req, res) => {
  await run('update requests set approved=? where id=?', [req.body.approved ? 1 : 0, Number(req.params.id)]); res.json({ ok: true });
}));
app.get('/api/admin/responses', needAdmin, h(async (_q, res) => res.json(await q(
  'select r.*, l.from_name from responses r join links l on l.slug=r.slug order by r.id desc'))));

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
app.use(express.static(path.join(__dirname, 'public'))); // local only; Vercel serves /public itself

module.exports = app;
