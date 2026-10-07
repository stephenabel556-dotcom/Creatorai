import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import Stripe from 'stripe';
import { startJob, checkJob, makeCaptions } from './providers.js';

const E = process.env, ROOT = import.meta.dirname, PORT = E.PORT || 3000, BASE = E.APP_URL || `http://localhost:${PORT}`;
if (!E.JWT_SECRET) throw new Error('Set JWT_SECRET in .env');
// Prices: usd in cents, ngn in kobo. Placeholders: set them so they clear your AI costs plus fees.
const COST = { photo: 1, background: 1, video: 5, caption: 1 }, VIDEO10 = 8;
const PACKS = { starter: { credits: 25, usd: 499, ngn: 500000 }, pro: { credits: 100, usd: 1499, ngn: 1500000 } };
const PLANS = { creator: { credits: 150, usd: 999, ngn: 1000000 }, studio: { credits: 400, usd: 2499, ngn: 2500000 } };
const STORE = path.join(ROOT, 'storage'); fs.mkdirSync(STORE, { recursive: true }); // swap for S3/R2 in production
const db = new Database(E.DB_FILE || path.join(ROOT, 'creatorai.db'));
db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON'); db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const run = (s, ...a) => db.prepare(s).run(...a), one = (s, ...a) => db.prepare(s).get(...a), all = (s, ...a) => db.prepare(s).all(...a);
const stripe = E.STRIPE_SECRET_KEY ? new Stripe(E.STRIPE_SECRET_KEY) : null;

// ---- credits (atomic; balance can never go negative) ----
const spend = db.transaction((uid, n, reason, ref) => {
  if (!run('UPDATE users SET credits=credits-? WHERE id=? AND credits>=?', n, uid, n).changes) return false;
  run('INSERT INTO credit_transactions(user_id,delta,reason,ref) VALUES(?,?,?,?)', uid, -n, reason, ref || null); return true;
});
const grant = db.transaction((uid, n, reason, ref) => {
  run('UPDATE users SET credits=credits+? WHERE id=?', n, uid);
  run('INSERT INTO credit_transactions(user_id,delta,reason,ref) VALUES(?,?,?,?)', uid, n, reason, ref || null);
});
const createUser = db.transaction((email, name, hash, gid) => {
  const id = run('INSERT INTO users(email,name,password_hash,google_id) VALUES(?,?,?,?)', email, name, hash, gid).lastInsertRowid;
  grant(id, 3, 'signup_bonus'); return id;
});
// Idempotent: webhooks and return-page checks can both call this; credits are granted once.
const fulfil = db.transaction((ref, subId) => {
  const p = one('SELECT * FROM payments WHERE reference=?', ref);
  if (!p || p.status === 'paid') return;
  run("UPDATE payments SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=?", p.id);
  grant(p.user_id, p.credits, 'purchase:' + p.item, ref);
  if (p.kind === 'plan') run("INSERT INTO subscriptions(user_id,plan,provider,provider_sub_id,current_period_end) VALUES(?,?,?,?,datetime('now','+30 days'))", p.user_id, p.item, p.provider, subId || null);
});
const settlePaystack = d => { const p = one('SELECT * FROM payments WHERE reference=?', d.reference); if (p && d.status === 'success' && d.amount === p.amount && d.currency === p.currency) fulfil(p.reference); };
const fail = (gid, msg) => db.transaction(() => {
  const g = one('SELECT * FROM generations WHERE id=?', gid);
  if (run("UPDATE generations SET status='failed',error=? WHERE id=? AND status IN ('processing','saving')", msg, gid).changes) grant(g.user_id, g.cost, 'refund', String(gid));
})();

const app = express();
app.set('trust proxy', 1); app.use(helmet({ contentSecurityPolicy: false }));

// ---- payment webhooks (raw body needed for signature checks; registered before express.json) ----
app.post('/webhooks/stripe', express.raw({ type: '*/*' }), (req, res) => {
  if (!stripe) return res.sendStatus(503);
  let ev; try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], E.STRIPE_WEBHOOK_SECRET); } catch { return res.sendStatus(400); }
  const o = ev.data.object;
  if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid') fulfil(o.client_reference_id, o.subscription);
  if (ev.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
    const sid = o.subscription || o.parent?.subscription_details?.subscription, s = one('SELECT * FROM subscriptions WHERE provider_sub_id=?', sid);
    if (s && !one('SELECT 1 FROM credit_transactions WHERE ref=?', o.id)) { grant(s.user_id, PLANS[s.plan].credits, 'renewal:' + s.plan, o.id); run("UPDATE subscriptions SET current_period_end=datetime('now','+30 days') WHERE id=?", s.id); }
  }
  if (ev.type === 'customer.subscription.deleted') run("UPDATE subscriptions SET status='canceled' WHERE provider_sub_id=?", o.id);
  res.sendStatus(200);
});
app.post('/webhooks/paystack', express.raw({ type: '*/*' }), (req, res) => {
  const sig = crypto.createHmac('sha512', E.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
  if (sig !== req.headers['x-paystack-signature']) return res.sendStatus(400);
  const ev = JSON.parse(req.body); if (ev.event === 'charge.success') settlePaystack(ev.data);
  res.sendStatus(200);
});

app.use(express.json({ limit: '15mb' })); app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 6e4, limit: 120 }));
app.use(express.static(path.join(ROOT, 'public')));

// ---- auth ----
const authLimit = rateLimit({ windowMs: 6e4, limit: 20 });
const sign = (id, res) => res.cookie('t', jwt.sign({ id }, E.JWT_SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: E.NODE_ENV === 'production', maxAge: 2592e6 });
const auth = (req, res, next) => { try { req.uid = jwt.verify(req.cookies.t, E.JWT_SECRET).id; if (!one('SELECT 1 FROM users WHERE id=?', req.uid)) throw 0; next(); } catch { res.status(401).json({ error: 'Please log in' }); } };
const pub = u => ({ id: u.id, email: u.email, name: u.name, credits: u.credits });
const gc = new OAuth2Client(E.GOOGLE_CLIENT_ID);
app.post('/api/auth/signup', authLimit, (req, res) => {
  const { email = '', password = '', name = '' } = req.body || {}, em = String(email).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(em) || String(password).length < 8) return res.status(400).json({ error: 'Enter a valid email and a password of 8+ characters' });
  if (one('SELECT 1 FROM users WHERE email=?', em)) return res.status(409).json({ error: 'That email is already registered. Log in instead.' });
  const id = createUser(em, String(name).trim().slice(0, 60) || em.split('@')[0], bcrypt.hashSync(String(password), 12), null);
  sign(id, res); res.json(pub(one('SELECT * FROM users WHERE id=?', id)));
});
app.post('/api/auth/login', authLimit, (req, res) => {
  const u = one('SELECT * FROM users WHERE email=?', String(req.body?.email || '').trim().toLowerCase());
  if (!u?.password_hash || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  sign(u.id, res); res.json(pub(u));
});
app.post('/api/auth/google', authLimit, async (req, res) => {
  try {
    const p = (await gc.verifyIdToken({ idToken: req.body.credential, audience: E.GOOGLE_CLIENT_ID })).getPayload();
    if (!p.email_verified) throw 0;
    let u = one('SELECT * FROM users WHERE google_id=? OR email=?', p.sub, p.email);
    if (!u) u = one('SELECT * FROM users WHERE id=?', createUser(p.email, p.name, null, p.sub));
    else if (!u.google_id) run('UPDATE users SET google_id=? WHERE id=?', p.sub, u.id);
    sign(u.id, res); res.json(pub(u));
  } catch { res.status(401).json({ error: 'Google sign-in failed' }); }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('t'); res.json({ ok: true }); });
app.get('/api/config', (req, res) => res.json({ googleClientId: E.GOOGLE_CLIENT_ID || null, costs: COST, video10: VIDEO10, packs: PACKS, plans: PLANS, providers: { paystack: !!E.PAYSTACK_SECRET_KEY, stripe: !!stripe } }));
app.get('/api/me', auth, (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', req.uid);
  res.json({ ...pub(u), subscription: one("SELECT plan,status,current_period_end FROM subscriptions WHERE user_id=? AND status='active' ORDER BY id DESC", req.uid) || null });
});
app.get('/api/history', auth, (req, res) => res.json({
  payments: all('SELECT item,kind,provider,amount,currency,credits,status,created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 30', req.uid),
  credits: all('SELECT delta,reason,created_at FROM credit_transactions WHERE user_id=? ORDER BY id DESC LIMIT 30', req.uid) }));

// ---- generation ----
const IMG = /^data:image\/(png|jpe?g|webp);base64,/;
const view = id => one('SELECT id,type,prompt,style,status,error,result_text,created_at,(SELECT id FROM media WHERE generation_id=generations.id) media_id,(SELECT kind FROM media WHERE generation_id=generations.id) kind FROM generations WHERE id=?', id);
const buildPrompt = (t, p, s) => t === 'background'
  ? `Replace the background with: ${s === 'Custom' ? p : s + (p ? ', ' + p : '')}. Keep the person identical (face, body, pose, clothing) and match lighting naturally.`
  : t === 'photo' ? `${p}. Style: ${s || 'photorealistic'}.` : p;
app.post('/api/generate', auth, async (req, res) => {
  const { type, prompt = '', style = '', image, seconds } = req.body || {};
  const bad = m => res.status(400).json({ error: m });
  if (!COST[type] || typeof prompt !== 'string' || prompt.length > 1000 || typeof style !== 'string') return bad('Invalid request');
  if (type !== 'caption' && (typeof image !== 'string' || !IMG.test(image) || image.length > 12e6)) return bad('Upload a PNG, JPG or WebP photo');
  if (!prompt.trim() && type !== 'background') return bad('Enter a prompt first');
  if (type === 'background' && !style) return bad('Pick a background');
  const cost = type === 'video' && +seconds === 10 ? VIDEO10 : COST[type];
  const gid = db.transaction(() => spend(req.uid, cost, 'generation:' + type) ? run('INSERT INTO generations(user_id,type,prompt,style,cost) VALUES(?,?,?,?,?)', req.uid, type, prompt, style, cost).lastInsertRowid : 0)();
  if (!gid) return res.status(402).json({ error: 'Not enough credits' });
  try {
    if (type === 'caption') run("UPDATE generations SET status='done',result_text=?,completed_at=CURRENT_TIMESTAMP WHERE id=?", await makeCaptions(prompt, style), gid);
    else run('UPDATE generations SET provider_job_id=? WHERE id=?', await startJob(type, buildPrompt(type, prompt.trim(), style), image, +seconds === 10 ? 10 : 5), gid);
  } catch (e) { console.error('generate:', e.message); fail(gid, 'Generation failed and your credits were refunded. Try again.'); }
  res.json(view(gid));
});
// Polling advances the job: checks the provider, saves the file, or refunds on failure.
app.get('/api/generations/:id', auth, async (req, res) => {
  const g = one('SELECT * FROM generations WHERE id=? AND user_id=?', req.params.id, req.uid);
  if (!g) return res.sendStatus(404);
  if (g.status === 'processing' && g.provider_job_id) try {
    const r = await checkJob(g.provider_job_id);
    if (r.status === 'failed') fail(g.id, 'The AI provider could not complete this. Credits refunded.');
    else if (r.status === 'succeeded' && run("UPDATE generations SET status='saving' WHERE id=? AND status='processing'", g.id).changes) try {
      const f = await fetch(r.url); if (!f.ok) throw new Error('download');
      const ext = (r.url.match(/\.(png|jpe?g|webp|mp4)(\?|$)/i) || [])[1] || (g.type === 'video' ? 'mp4' : 'png'), name = `${g.user_id}-${crypto.randomUUID()}.${ext.toLowerCase()}`;
      fs.writeFileSync(path.join(STORE, name), Buffer.from(await f.arrayBuffer()));
      db.transaction(() => { run('INSERT INTO media(generation_id,user_id,kind,file) VALUES(?,?,?,?)', g.id, g.user_id, g.type === 'video' ? 'video' : 'image', name); run("UPDATE generations SET status='done',completed_at=CURRENT_TIMESTAMP WHERE id=?", g.id); })();
    } catch { fail(g.id, 'Could not save the result. Credits refunded.'); }
  } catch (e) { console.error('poll:', e.message); }
  res.json(view(g.id));
});
app.get('/api/creations', auth, (req, res) => res.json(all("SELECT id FROM generations WHERE user_id=? AND status IN ('processing','saving','done') ORDER BY id DESC LIMIT 100", req.uid).map(r => view(r.id))));
app.delete('/api/creations/:id', auth, (req, res) => {
  const g = one('SELECT id FROM generations WHERE id=? AND user_id=?', req.params.id, req.uid); if (!g) return res.sendStatus(404);
  for (const m of all('SELECT file FROM media WHERE generation_id=?', g.id)) fs.rmSync(path.join(STORE, m.file), { force: true });
  run('DELETE FROM media WHERE generation_id=?', g.id); run('DELETE FROM generations WHERE id=?', g.id); res.json({ ok: true });
});
app.get('/media/:id', auth, (req, res) => { // private: only the owner can fetch
  const m = one('SELECT * FROM media WHERE id=? AND user_id=?', req.params.id, req.uid); if (!m) return res.sendStatus(404);
  const f = path.join(STORE, m.file); req.query.dl ? res.download(f, `creatorai-${m.id}${path.extname(m.file)}`) : res.sendFile(f);
});

// ---- payments ----
app.post('/api/pay/checkout', auth, async (req, res) => {
  const { provider, kind, item } = req.body || {}, plan = kind === 'plan', it = (plan ? PLANS : PACKS)[item];
  if (!it || !['paystack', 'stripe'].includes(provider)) return res.status(400).json({ error: 'Invalid purchase' });
  const u = one('SELECT * FROM users WHERE id=?', req.uid), ref = 'cai_' + crypto.randomBytes(12).toString('hex'), ngn = provider === 'paystack';
  try {
    let url;
    if (ngn) {
      if (!E.PAYSTACK_SECRET_KEY) throw new Error('Paystack is not configured');
      run('INSERT INTO payments(user_id,provider,kind,item,amount,currency,credits,reference) VALUES(?,?,?,?,?,?,?,?)', u.id, provider, kind, item, it.ngn, 'NGN', it.credits, ref);
      const r = await (await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: u.email, amount: it.ngn, currency: 'NGN', reference: ref, callback_url: `${BASE}/#/pay/${ref}` }) })).json();
      if (!r.status) throw new Error(r.message); url = r.data.authorization_url;
    } else {
      if (!stripe) throw new Error('Stripe is not configured');
      run('INSERT INTO payments(user_id,provider,kind,item,amount,currency,credits,reference) VALUES(?,?,?,?,?,?,?,?)', u.id, provider, kind, item, it.usd, 'USD', it.credits, ref);
      url = (await stripe.checkout.sessions.create({ mode: plan ? 'subscription' : 'payment', customer_email: u.email, client_reference_id: ref,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: it.usd, product_data: { name: `CreatorAI ${item}: ${it.credits} credits` }, ...(plan && { recurring: { interval: 'month' } }) } }],
        success_url: `${BASE}/#/pay/${ref}`, cancel_url: `${BASE}/#/credits` })).url;
    }
    res.json({ url });
  } catch (e) { console.error('checkout:', e.message); run("UPDATE payments SET status='failed' WHERE reference=?", ref); res.status(502).json({ error: 'Could not start checkout. Try again or use another method.' }); }
});
app.get('/api/pay/:ref/status', auth, async (req, res) => {
  let p = one('SELECT * FROM payments WHERE reference=? AND user_id=?', req.params.ref, req.uid); if (!p) return res.sendStatus(404);
  if (p.status === 'pending' && p.provider === 'paystack') { // confirm with Paystack directly, never trust the redirect alone
    try { const r = await (await fetch('https://api.paystack.co/transaction/verify/' + p.reference, { headers: { Authorization: 'Bearer ' + E.PAYSTACK_SECRET_KEY } })).json(); if (r.data) settlePaystack(r.data); } catch {}
    p = one('SELECT * FROM payments WHERE reference=?', p.reference);
  }
  res.json({ status: p.status, credits: p.credits });
});

app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Server error' }); });
app.listen(PORT, () => console.log('CreatorAI on ' + BASE));
