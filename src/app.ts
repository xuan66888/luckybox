import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { Store, HttpError, requireRow } from './db.js';
import type { Config } from './config.js';
import { sha256, ticketOrder } from './fairness.js';
import { authMiddleware, requireAuth, requireAdmin, passwordHash, passwordMatches, passwordSchema, publicUser, newSession, cookieName } from './auth.js';

const idSchema = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const imageRef = z.union([z.literal(''), z.string().regex(/^\/uploads\/[a-f0-9-]{36}\.webp$/)]);
const contentSchema = z.object({ description: z.string().max(12000), cover: imageRef, descriptionImages: z.array(imageRef).max(12) }).strict();
const prizeSchema = z.object({ name: text(120), kind: z.enum(['physical','points','none']), image: imageRef.default(''), value: z.number().int().min(0).max(1000000), redeemPoints: z.number().int().min(0).max(1000000), quantity: z.number().int().min(1).max(10000) }).strict();
const poolSchema = contentSchema.extend({ name: text(120), kind: z.enum(['paid','free']), price: z.number().int().min(0).max(100000), prizes: z.array(prizeSchema).min(1).max(30) }).strict();
const getId = (req: Request) => idSchema.parse(req.params.id);
const currentUser = (req: Request) => { if (!req.user) throw new HttpError(401, '請先登入'); return req.user; };
function assert(condition: unknown, message: string, status = 409): asserts condition { if (!condition) throw new HttpError(status, message); }

export function createApp(store: Store, config: Config, publicDir: string) {
  const app = express();
  mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
  app.disable('x-powered-by');
  app.set('trust proxy', config.proxyHops);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.production ? [] : null } }, strictTransportSecurity: config.production ? { maxAge: 31536000 } : false }));
  app.use((req, res, next) => {
    const requestId = randomUUID(), start = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => { if (process.env.QUIET_LOGS !== 'true') console.log(JSON.stringify({ requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start })); });
    next();
  });
  const limit = (namespace: string, max: number, windowMs: number, user = false) => (req: Request, res: Response, next: NextFunction) => {
    const key = `${namespace}:${sha256(user && req.user ? req.user.id : req.ip ?? 'unknown')}`;
    const count = store.tx(() => {
      store.run('DELETE FROM rate_limits WHERE expires_at<?', Date.now());
      store.run('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', key, Date.now() + windowMs);
      return requireRow(store.one('SELECT count FROM rate_limits WHERE key=?', key)).count;
    });
    if (count > max) { res.setHeader('Retry-After', Math.ceil(windowMs / 1000)); throw new HttpError(429, '操作過於頻繁，請稍後再試'); }
    next();
  };
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) => { store.one('SELECT name FROM schema_migrations LIMIT 1'); res.json({ status: 'ready' }); });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', limit('api', 600, 60000));
  app.use(authMiddleware(store, config));
  app.use('/api', (req, _res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if (req.get('Origin') !== config.origin || req.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, '來源驗證失敗');
      if (req.session && req.get('X-CSRF-Token') !== req.session.csrf) throw new HttpError(403, 'CSRF 驗證失敗，請重新整理');
      if (req.path !== '/uploads' && !req.is('application/json')) throw new HttpError(415, '請使用 JSON');
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));

  function mutation(req: Request, res: Response, operation: () => unknown) {
    const user = currentUser(req), key = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/).parse(req.get('Idempotency-Key'));
    const hash = sha256(JSON.stringify([req.method, req.originalUrl, req.body]));
    const result = store.tx(() => {
      const existing = store.one('SELECT * FROM idempotency WHERE user_id=? AND key=?', user.id, key);
      if (existing) { assert(existing.request_hash === hash, '同一請求識別碼不能重複用於不同操作'); return JSON.parse(existing.response); }
      // Re-check identity inside the write transaction, including concurrent role revocation.
      const fresh = requireRow(store.one('SELECT * FROM users WHERE id=? AND disabled=0', user.id));
      assert(fresh.role === user.role, '帳戶權限已變更，請重新整理', 403);
      const data = operation();
      store.run('INSERT INTO idempotency VALUES (?,?,?,?,?)', user.id, key, hash, JSON.stringify(data), Date.now());
      return data;
    });
    res.json(result);
  }
  function ownedPool(req: Request) {
    const p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req)));
    assert(p.owner_id === currentUser(req).id || req.user?.role === 'admin', '不能修改其他人的獎池', 403);
    return p;
  }
  function checkImages(req: Request, refs: string[]) {
    for (const ref of refs.filter(Boolean)) {
      const image = requireRow(store.one('SELECT * FROM uploads WHERE id=?', ref.slice(9, -5)));
      assert(image.owner_id === currentUser(req).id || req.user?.role === 'admin', '不能使用其他人的上傳檔案', 403);
    }
  }
  function poolView(p: any, privateView = false) {
    const { seed: _seed, pending_content: pending, service_request: service, ...rest } = p;
    if (!privateView) { delete rest.review_note; delete rest.reserve_points; }
    return { ...rest, descriptionImages: JSON.parse(p.description_images), pendingContent: privateView && pending ? JSON.parse(pending) : null,
      serviceRequest: privateView && service ? JSON.parse(service) : null, prizes: store.all('SELECT * FROM prizes WHERE pool_id=? ORDER BY id', p.id) };
  }

  app.get('/api/config', (_req, res) => res.json({ production: config.production, registration: config.registration, paidDraws: config.paidDraws, manualTopups: config.manualTopups, passwordReset: !!config.smtp.host || !config.production, feeBps: config.feeBps, holdHours: config.holdHours }));
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, csrf: req.session?.csrf ?? null }));
  app.post('/api/auth/register', limit('auth', 12, 15 * 60000), async (req, res) => {
    assert(config.registration, '目前暫停新會員註冊', 403);
    const data = z.object({ email: z.email().max(254).transform(v => v.toLowerCase()), name: text(60), password: passwordSchema }).strict().parse(req.body);
    const hash = await passwordHash(data.password), id = randomUUID();
    store.tx(() => {
      assert(!store.one('SELECT id FROM users WHERE email=?', data.email), '無法建立帳戶，請改用登入或密碼重設', 409);
      store.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)', id, data.email, data.name, hash, Date.now());
      if (config.devPoints) store.balance(id, config.devPoints, 'dev_grant', id);
      store.audit(id, 'register', id);
    });
    if (req.session) store.run('DELETE FROM sessions WHERE token_hash=?', req.session.token_hash);
    res.status(201).json({ csrf: newSession(store, config, id, res), user: publicUser(requireRow(store.one('SELECT * FROM users WHERE id=?', id))) });
  });
  app.post('/api/auth/login', limit('auth', 12, 15 * 60000), async (req, res) => {
    const data = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }).strict().parse(req.body);
    const user = store.one('SELECT * FROM users WHERE email=?', data.email);
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = await passwordMatches(data.password, user?.password_hash ?? dummy);
    if (!valid || !user || user.disabled) throw new HttpError(401, '帳號或密碼錯誤');
    if (req.session) store.run('DELETE FROM sessions WHERE token_hash=?', req.session.token_hash);
    res.json({ csrf: newSession(store, config, user.id, res), user: publicUser(user) });
  });
  app.post('/api/auth/logout', requireAuth, (req, res) => { store.run('DELETE FROM sessions WHERE token_hash=?', req.session!.token_hash); res.clearCookie(cookieName(config), { path: '/', secure: config.production, httpOnly: true, sameSite: 'strict' }); res.json({ ok: true }); });
  app.post('/api/auth/forgot', limit('reset', 4, 3600000), async (req, res) => {
    const { email } = z.object({ email: z.email().max(254) }).strict().parse(req.body);
    assert(!!config.smtp.host || !config.production, '密碼重設郵件服務尚未設定，請聯絡官方', 503);
    const user = store.one('SELECT id FROM users WHERE email=? AND disabled=0', email);
    if (user) {
      const token = randomBytes(32).toString('hex');
      store.tx(() => { store.run('DELETE FROM resets WHERE user_id=? OR expires_at<?', user.id, Date.now()); store.run('INSERT INTO resets VALUES (?,?,?)', sha256(token), user.id, Date.now() + 30 * 60000); });
      const url = `${config.origin}/#reset/${token}`;
      if (config.smtp.host) {
        try {
          await nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, requireTLS: !config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined, connectionTimeout: 10000, socketTimeout: 15000 }).sendMail({ from: config.smtp.from, to: email, subject: 'LUCKYBOX 密碼重設', text: `請於 30 分鐘內開啟連結重設密碼：\n${url}\n若非本人申請，請忽略。` });
        } catch (_error) { store.run('DELETE FROM resets WHERE token_hash=?', sha256(token)); console.error(JSON.stringify({ event: 'smtp_failed' })); }
      } else {
        mkdirSync(path.join(config.dataDir, 'dev-mail'), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(config.dataDir, 'dev-mail', `${user.id}.txt`), url, { mode: 0o600 });
      }
    }
    res.json({ ok: true, message: '若帳號存在，我們將寄送重設連結。' });
  });
  app.post('/api/auth/reset', limit('reset-confirm', 10, 3600000), async (req, res) => {
    const data = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: passwordSchema }).strict().parse(req.body);
    const hash = await passwordHash(data.password);
    store.tx(() => {
      const reset = store.one('SELECT * FROM resets WHERE token_hash=? AND expires_at>?', sha256(data.token), Date.now());
      assert(reset, '重設連結無效或已過期', 400);
      store.run('UPDATE users SET password_hash=? WHERE id=?', hash, reset.user_id);
      store.run('DELETE FROM resets WHERE user_id=?', reset.user_id); store.run('DELETE FROM sessions WHERE user_id=?', reset.user_id);
      store.audit(reset.user_id, 'password_reset', reset.user_id);
    });
    res.json({ ok: true });
  });

  app.get('/api/pools', (_req, res) => res.json(store.all("SELECT p.*,u.name creator FROM pools p JOIN users u ON u.id=p.owner_id WHERE p.status IN ('approved','live','sold_out','settled') ORDER BY p.created_at DESC LIMIT 200").map(p => poolView(p))));
  app.get('/api/pools/:id', (req, res) => {
    const p = requireRow(store.one('SELECT p.*,u.name creator FROM pools p JOIN users u ON u.id=p.owner_id WHERE p.id=?', getId(req)));
    const owner = p.owner_id === req.user?.id || req.user?.role === 'admin';
    assert(owner || ['approved','live','sold_out','settled'].includes(p.status), '找不到獎池', 404);
    res.json(poolView(p, owner));
  });
  app.get('/api/pools/:id/proof', (req, res) => {
    const p = requireRow(store.one("SELECT * FROM pools WHERE id=? AND status IN ('approved','live','sold_out','settled')", getId(req)));
    res.json({ algorithm: 'hmac-sha256-fisher-yates-v1', commitment: p.commitment, manifest: p.manifest, manifestHash: p.manifest_hash, seed: p.remaining === 0 ? p.seed : null,
      draws: store.all('SELECT id,ordinal,prize_id FROM draws WHERE pool_id=? ORDER BY ordinal', p.id) });
  });
  app.get('/api/creator/pools', requireAuth, (req, res) => res.json(store.all('SELECT * FROM pools WHERE owner_id=? ORDER BY created_at DESC LIMIT 200', currentUser(req).id).map(p => poolView(p, true))));
  app.post('/api/creator/request', requireAuth, (req, res) => mutation(req, res, () => { assert(currentUser(req).role === 'player', '帳戶已有開池權限'); store.run('UPDATE users SET creator_requested=1 WHERE id=?', currentUser(req).id); return { ok: true }; }));
  app.post('/api/pools', requireAuth, (req, res) => mutation(req, res, () => {
    assert(['creator','admin'].includes(currentUser(req).role), '需先申請創作者權限', 403);
    const data = poolSchema.parse(req.body), id = randomUUID(), total = data.prizes.reduce((s, p) => s + p.quantity, 0);
    assert(total <= 10000, '總抽數不可超過 10,000', 400);
    assert(data.kind === 'free' ? data.price === 0 : data.price > 0, '免費池價格必須為 0，付費池價格必須大於 0', 400);
    for (const p of data.prizes) { assert(p.kind !== 'none' || (p.value === 0 && p.redeemPoints === 0), '未中獎項目不可含有點數', 400); assert(p.kind !== 'points' || (p.value > 0 && p.redeemPoints === 0), '點數獎的 value 必須大於 0，兌點必須為 0', 400); }
    checkImages(req, [data.cover, ...data.descriptionImages, ...data.prizes.map(p => p.image)]);
    store.run("INSERT INTO pools(id,owner_id,name,description,cover,description_images,status,kind,price,total,remaining,fee_bps,created_at) VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?)", id, currentUser(req).id, data.name, data.description, data.cover, JSON.stringify(data.descriptionImages), data.kind, data.price, total, total, config.feeBps, Date.now());
    for (const p of data.prizes) store.run('INSERT INTO prizes VALUES (?,?,?,?,?,?,?,?,?)', randomUUID(), id, p.name, p.kind, p.image, p.value, p.redeemPoints, p.quantity, p.quantity);
    store.audit(currentUser(req).id, 'pool_create', id); return { id };
  }));
  app.post('/api/pools/:id/submit', requireAuth, (req, res) => mutation(req, res, () => {
    const p = ownedPool(req); assert(['draft','rejected'].includes(p.status), '只有草稿或已拒絕獎池可以送審');
    const reserve = requireRow(store.one("SELECT SUM(quantity * CASE WHEN kind='points' THEN value ELSE redeem_points END) total FROM prizes WHERE pool_id=?", p.id)).total;
    assert(reserve <= 100000000, '獎池點數準備金超出上限', 400);
    if (reserve) store.balance(p.owner_id, -reserve, 'pool_reserve', `${p.id}:${randomUUID()}`);
    store.run("UPDATE pools SET status='pending',reserve_points=?,review_note='' WHERE id=?", reserve, p.id);
    store.audit(currentUser(req).id, 'pool_submit', p.id); return { ok: true };
  }));
  app.post('/api/pools/:id/open', requireAuth, (req, res) => mutation(req, res, () => {
    const p = ownedPool(req); assert(p.status === 'approved', '獎池尚未核准或已開池');
    assert(p.kind === 'free' || config.paidDraws, '付費抽獎目前未啟用', 503);
    store.run("UPDATE pools SET status='live' WHERE id=?", p.id); store.audit(currentUser(req).id, 'pool_open', p.id); return { ok: true };
  }));
  app.post('/api/pools/:id/content', requireAuth, (req, res) => mutation(req, res, () => {
    const p = ownedPool(req), data = contentSchema.parse(req.body); checkImages(req, [data.cover, ...data.descriptionImages]);
    assert(!['settled','cancelled'].includes(p.status), '此獎池已封存');
    if (currentUser(req).role === 'admin' || ['draft','rejected'].includes(p.status)) {
      store.run('UPDATE pools SET description=?,cover=?,description_images=?,pending_content=NULL WHERE id=?', data.description, data.cover, JSON.stringify(data.descriptionImages), p.id);
    } else store.run('UPDATE pools SET pending_content=? WHERE id=?', JSON.stringify(data), p.id);
    store.audit(currentUser(req).id, 'content_submit', p.id); return { ok: true };
  }));
  app.post('/api/pools/:id/service', requireAuth, (req, res) => mutation(req, res, () => {
    const p = ownedPool(req), data = z.object({ verification: z.enum(['identity','inventory']), officialFulfillment: z.boolean(), note: text(1000) }).strict().parse(req.body);
    assert(!['sold_out','settled','cancelled'].includes(p.status), '此獎池已封存');
    assert(!store.one('SELECT c.id FROM collection c JOIN prizes r ON r.id=c.prize_id WHERE r.pool_id=? LIMIT 1', p.id), '抽出實體商品後不可變更履約方式');
    store.run('UPDATE pools SET service_request=? WHERE id=?', JSON.stringify(data), p.id); return { ok: true };
  }));

  app.post('/api/pools/:id/draw', requireAuth, limit('draw', 60, 60000, true), (req, res) => mutation(req, res, () => {
    const user = currentUser(req), p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req)));
    const { quantity } = z.object({ quantity: z.number().int().min(1).max(10) }).strict().parse(req.body);
    assert(user.role !== 'admin' && p.owner_id !== user.id, '官方或開池者不可參與此抽獎', 403);
    assert(p.status === 'live', '獎池尚未開放或已結束'); assert(p.remaining >= quantity, '剩餘抽數不足');
    assert(p.kind === 'free' || config.paidDraws, '付費抽獎目前未啟用', 503);
    if (p.kind === 'free') { assert(quantity === 1, '免費池每次限一抽', 400); assert(!store.one('SELECT 1 FROM free_claims WHERE pool_id=? AND user_id=?', p.id, user.id), '每個帳戶限領取一次'); store.run('INSERT INTO free_claims VALUES (?,?)', p.id, user.id); }
    const cost = p.price * quantity, requestId = randomUUID();
    if (cost) store.balance(user.id, -cost, 'draw_payment', requestId);
    const results = [];
    let reserveUsed = 0;
    for (let i = 0; i < quantity; i++) {
      const ordinal = p.total - p.remaining + i;
      const prize = requireRow(store.one('SELECT r.* FROM tickets t JOIN prizes r ON r.id=t.prize_id WHERE t.pool_id=? AND t.ordinal=?', p.id, ordinal));
      const id = randomUUID();
      assert(prize.remaining > 0, '獎品庫存異常');
      store.run('INSERT INTO draws VALUES (?,?,?,?,?,?,?)', id, p.id, user.id, prize.id, ordinal, p.price, Date.now());
      store.run('UPDATE prizes SET remaining=remaining-1 WHERE id=? AND remaining>0', prize.id);
      if (prize.kind === 'points') { store.balance(user.id, prize.value, 'prize_points', id); reserveUsed += prize.value; }
      if (prize.kind === 'physical') store.run("INSERT INTO collection(id,draw_id,user_id,prize_id,status) VALUES (?,?,?,?,'available')", randomUUID(), id, user.id, prize.id);
      results.push({ id, ordinal, prizeId: prize.id, name: prize.name, kind: prize.kind, value: prize.value, image: prize.image });
    }
    store.run("UPDATE pools SET remaining=remaining-?,revenue_points=revenue_points+?,reserve_points=reserve_points-?,status=CASE WHEN remaining=? THEN 'sold_out' ELSE status END,closed_at=CASE WHEN remaining=? THEN ? ELSE NULL END WHERE id=?", quantity, cost, reserveUsed, quantity, quantity, Date.now(), p.id);
    store.audit(user.id, 'draw', p.id, { quantity, cost, drawIds: results.map(r => r.id) });
    return { results, points: requireRow(store.one('SELECT points FROM users WHERE id=?', user.id)).points };
  }));

  app.get('/api/me/collection', requireAuth, (req, res) => res.json(store.all('SELECT c.*,r.name,r.image,r.redeem_points,p.name pool_name,p.fulfillment,p.owner_id FROM collection c JOIN prizes r ON r.id=c.prize_id JOIN pools p ON p.id=r.pool_id WHERE c.user_id=? ORDER BY c.rowid DESC LIMIT 500', currentUser(req).id)));
  app.get('/api/me/draws', requireAuth, (req, res) => res.json(store.all('SELECT d.*,r.name,p.name pool_name FROM draws d JOIN prizes r ON r.id=d.prize_id JOIN pools p ON p.id=d.pool_id WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 200', currentUser(req).id)));
  app.get('/api/me/ledger', requireAuth, (req, res) => res.json(store.all('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200', currentUser(req).id)));
  app.post('/api/collection/:id/redeem', requireAuth, (req, res) => mutation(req, res, () => {
    const user = currentUser(req), c = requireRow(store.one('SELECT c.*,r.pool_id,r.redeem_points FROM collection c JOIN prizes r ON r.id=c.prize_id WHERE c.id=? AND c.user_id=?', getId(req), user.id));
    assert(c.status === 'available' && c.redeem_points > 0, '此獎品無法兌點');
    store.run("UPDATE collection SET status='redeemed' WHERE id=?", c.id);
    store.run('UPDATE pools SET reserve_points=reserve_points-? WHERE id=?', c.redeem_points, c.pool_id);
    store.balance(user.id, c.redeem_points, 'prize_redeem', c.id); store.audit(user.id, 'redeem', c.id); return { ok: true };
  }));
  app.post('/api/shipments', requireAuth, (req, res) => mutation(req, res, () => {
    const user = currentUser(req), data = z.object({ itemIds: z.array(idSchema).min(1).max(50), name: text(80), phone: z.string().regex(/^[+0-9 ()-]{7,30}$/), address: text(500) }).strict().parse(req.body);
    assert(new Set(data.itemIds).size === data.itemIds.length, '獎品清單不可重複', 400);
    const items = data.itemIds.map(id => requireRow(store.one('SELECT c.*,p.owner_id,p.fulfillment FROM collection c JOIN prizes r ON r.id=c.prize_id JOIN pools p ON p.id=r.pool_id WHERE c.id=? AND c.user_id=?', id, user.id)));
    assert(items.every(c => c.status === 'available'), '部分商品已兌換或申請出貨');
    assert(items.every(c => c.fulfillment === items[0].fulfillment && (c.fulfillment === 'official' || c.owner_id === items[0].owner_id)), '請按同一出貨單位分開申請', 400);
    const id = randomUUID(); store.run("INSERT INTO shipments(id,user_id,name,phone,address,status,created_at) VALUES (?,?,?,?,?,'requested',?)", id, user.id, data.name, data.phone, data.address, Date.now());
    for (const c of items) store.run("UPDATE collection SET status='shipping',shipment_id=? WHERE id=?", id, c.id);
    store.audit(user.id, 'shipping_request', id, { itemIds: data.itemIds }); return { id };
  }));
  app.get('/api/me/shipments', requireAuth, (req, res) => res.json(store.all('SELECT * FROM shipments WHERE user_id=? ORDER BY created_at DESC LIMIT 200', currentUser(req).id)));
  app.get('/api/fulfillment/shipments', requireAuth, (req, res) => {
    const user = currentUser(req); assert(['creator','admin'].includes(user.role), '無出貨權限', 403);
    const rows = user.role === 'admin' ? store.all('SELECT * FROM shipments ORDER BY created_at DESC LIMIT 200') : store.all("SELECT DISTINCT s.* FROM shipments s JOIN collection c ON c.shipment_id=s.id JOIN prizes r ON r.id=c.prize_id JOIN pools p ON p.id=r.pool_id WHERE p.owner_id=? AND p.fulfillment='creator' ORDER BY s.created_at DESC LIMIT 200", user.id);
    res.json(rows.map(s => ({ ...s, items: store.all('SELECT r.name,c.id FROM collection c JOIN prizes r ON r.id=c.prize_id WHERE c.shipment_id=?', s.id) })));
  });
  app.post('/api/shipments/:id/ship', requireAuth, (req, res) => mutation(req, res, () => {
    const user = currentUser(req), s = requireRow(store.one('SELECT * FROM shipments WHERE id=?', getId(req)));
    const pools = store.all('SELECT DISTINCT p.owner_id,p.fulfillment FROM collection c JOIN prizes r ON r.id=c.prize_id JOIN pools p ON p.id=r.pool_id WHERE c.shipment_id=?', s.id);
    assert(user.role === 'admin' || (user.role === 'creator' && pools.every(p => p.owner_id === user.id && p.fulfillment === 'creator')), '無此出貨單操作權限', 403);
    const data = z.object({ carrier: text(60), tracking: z.string().regex(/^[A-Za-z0-9-]{4,80}$/) }).strict().parse(req.body);
    assert(s.status === 'requested', '出貨單已處理');
    store.run("UPDATE shipments SET status='shipped',carrier=?,tracking=? WHERE id=?", data.carrier, data.tracking, s.id); store.run("UPDATE collection SET status='shipped' WHERE shipment_id=?", s.id); store.audit(user.id, 'shipment_sent', s.id); return { ok: true };
  }));
  app.post('/api/shipments/:id/receive', requireAuth, (req, res) => mutation(req, res, () => {
    const s = requireRow(store.one('SELECT * FROM shipments WHERE id=? AND user_id=?', getId(req), currentUser(req).id)); assert(s.status === 'shipped', '商品尚未出貨');
    store.run("UPDATE shipments SET status='delivered' WHERE id=?", s.id); store.run("UPDATE collection SET status='delivered' WHERE shipment_id=?", s.id); store.audit(currentUser(req).id, 'shipment_received', s.id); return { ok: true };
  }));

  app.get('/api/me/topups', requireAuth, (req, res) => res.json(store.all('SELECT * FROM topups WHERE user_id=? ORDER BY created_at DESC LIMIT 100', currentUser(req).id)));
  app.post('/api/topups', requireAuth, (req, res) => mutation(req, res, () => {
    assert(config.manualTopups, '儲值服務尚未啟用', 503);
    const data = z.object({ points: z.number().int().min(1).max(100000), reference: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).transform(x => x.toUpperCase()) }).strict().parse(req.body);
    assert(!store.one('SELECT id FROM topups WHERE reference=?', data.reference), '付款參考碼已登記');
    const id = randomUUID(); store.run("INSERT INTO topups(id,user_id,points,reference,status,created_at) VALUES (?,?,?,?,'pending',?)", id, currentUser(req).id, data.points, data.reference, Date.now()); return { id, status: 'pending' };
  }));
  app.get('/api/creator/settlements', requireAuth, (req, res) => res.json(store.all('SELECT * FROM settlements WHERE owner_id=? ORDER BY created_at DESC LIMIT 100', currentUser(req).id)));
  function assertSettlement(p: any) {
    assert(p.status === 'sold_out', '只有全部抽完的獎池可以結算');
    assert(p.closed_at + config.holdHours * 3600000 <= Date.now(), '尚未到結算等待期');
    assert(!store.one("SELECT c.id FROM collection c JOIN prizes r ON r.id=c.prize_id WHERE r.pool_id=? AND c.status NOT IN ('redeemed','delivered') LIMIT 1", p.id), '仍有未完成兌點或收貨的商品');
  }
  app.post('/api/pools/:id/settlement', requireAuth, (req, res) => mutation(req, res, () => {
    const p = ownedPool(req); assertSettlement(p); assert(!store.one('SELECT id FROM settlements WHERE pool_id=?', p.id), '此池已申請結算');
    const id = randomUUID(), fee = Math.floor(p.revenue_points * p.fee_bps / 10000);
    store.run("INSERT INTO settlements(id,pool_id,owner_id,gross_points,fee_points,reserve_returned,status,created_at) VALUES (?,?,?,?,?,?,'requested',?)", id, p.id, p.owner_id, p.revenue_points, fee, p.reserve_points, Date.now()); return { id };
  }));

  app.post('/api/uploads', requireAuth, limit('upload', 20, 3600000, true), express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '5mb' }), async (req, res) => {
    assert(Buffer.isBuffer(req.body) && req.body.length > 0, '僅接受 PNG、JPEG、WebP 圖片', 415);
    const user = currentUser(req); assert(['creator','admin'].includes(user.role), '只有創作者及官方可以上傳', 403);
    let output: Buffer;
    try {
      const decoder = sharp(req.body, { limitInputPixels: 20000000, animated: false, failOn: 'warning' });
      const meta = await decoder.metadata(); assert(['jpeg','png','webp'].includes(meta.format ?? '') && (meta.pages ?? 1) === 1, '不支援此圖片格式', 400);
      output = await decoder.rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    } catch (_error) { throw new HttpError(400, '圖片損壞、格式不符或尺寸超過 2,000 萬像素'); }
    const id = randomUUID(), file = path.join(config.uploadDir, `${id}.webp`);
    try {
      store.tx(() => {
        const fresh = requireRow(store.one('SELECT role,disabled FROM users WHERE id=?', user.id)); assert(!fresh.disabled && ['creator','admin'].includes(fresh.role), '權限已取消', 403);
        const used = requireRow(store.one('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) count FROM uploads WHERE owner_id=?', user.id));
        assert(used.bytes + output.length <= 100 * 1024 * 1024 && used.count < 500, '上傳配額已滿');
        writeFileSync(file, output, { flag: 'wx', mode: 0o600 });
        store.run('INSERT INTO uploads VALUES (?,?,?,?)', id, user.id, output.length, Date.now());
      });
    } catch (error) { try { unlinkSync(file); } catch (_ignored) { /* No file was written. */ } throw error; }
    res.status(201).json({ url: `/uploads/${id}.webp` });
  });

  app.use('/api/admin', requireAuth, requireAdmin);
  app.get('/api/admin/users', (_req, res) => res.json(store.all('SELECT id,email,name,role,disabled,creator_requested,points,created_at FROM users ORDER BY created_at DESC LIMIT 200')));
  app.post('/api/admin/users/:id', (req, res) => mutation(req, res, () => {
    const user = requireRow(store.one('SELECT * FROM users WHERE id=?', getId(req))), actor = currentUser(req);
    const data = z.object({ role: z.enum(['player','creator','admin']), disabled: z.boolean() }).strict().parse(req.body);
    assert(user.id !== actor.id, '不可修改自己的管理員權限');
    if (user.role === 'creator' && data.role !== 'creator' && data.role !== 'admin') assert(!store.one("SELECT id FROM pools WHERE owner_id=? AND status NOT IN ('settled','cancelled','rejected','draft') LIMIT 1", user.id), '此創作者仍有進行中的獎池，請先完成履約');
    store.run('UPDATE users SET role=?,disabled=?,creator_requested=0 WHERE id=?', data.role, Number(data.disabled), user.id);
    store.run('DELETE FROM sessions WHERE user_id=?', user.id); store.audit(actor.id, 'user_permissions', user.id, data); return { ok: true };
  }));
  app.get('/api/admin/pools', (_req, res) => res.json(store.all('SELECT p.*,u.name creator FROM pools p JOIN users u ON u.id=p.owner_id ORDER BY p.created_at DESC LIMIT 200').map(p => poolView(p, true))));
  app.post('/api/admin/pools/:id/review', (req, res) => mutation(req, res, () => {
    const p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req))), data = z.object({ approve: z.boolean(), note: text(1000) }).strict().parse(req.body);
    assert(p.status === 'pending', '此獎池不在待審核狀態'); assert(p.owner_id !== currentUser(req).id, '不可審核自己建立的獎池', 403);
    if (data.approve) {
      const prizes = store.all('SELECT id,name,kind,image,value,redeem_points,quantity FROM prizes WHERE pool_id=? ORDER BY id', p.id);
      const seed = randomBytes(32).toString('hex'), manifest = JSON.stringify(prizes);
      const tickets = ticketOrder(seed, prizes.map(p => ({ id: p.id, quantity: p.quantity })));
      tickets.forEach((prizeId, ordinal) => store.run('INSERT INTO tickets VALUES (?,?,?)', p.id, ordinal, prizeId));
      store.run("UPDATE pools SET status='approved',seed=?,commitment=?,manifest=?,manifest_hash=?,review_note=? WHERE id=?", seed, sha256(seed), manifest, sha256(manifest), data.note, p.id);
    } else {
      if (p.reserve_points) store.balance(p.owner_id, p.reserve_points, 'reserve_release', randomUUID());
      store.run("UPDATE pools SET status='rejected',reserve_points=0,review_note=? WHERE id=?", data.note, p.id);
    }
    store.audit(currentUser(req).id, 'pool_review', p.id, data); return { ok: true };
  }));
  app.post('/api/admin/pools/:id/content-review', (req, res) => mutation(req, res, () => {
    const p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req))), { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    assert(p.pending_content, '沒有待審核的修改');
    if (approve) { const d = contentSchema.parse(JSON.parse(p.pending_content)); store.run('UPDATE pools SET description=?,cover=?,description_images=? WHERE id=?', d.description, d.cover, JSON.stringify(d.descriptionImages), p.id); }
    store.run('UPDATE pools SET pending_content=NULL WHERE id=?', p.id); store.audit(currentUser(req).id, 'content_review', p.id, { approve }); return { ok: true };
  }));
  app.post('/api/admin/pools/:id/service-review', (req, res) => mutation(req, res, () => {
    const p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req))), { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    assert(p.service_request, '沒有待審核申請');
    if (approve) {
      assert(!store.one('SELECT c.id FROM collection c JOIN prizes r ON r.id=c.prize_id WHERE r.pool_id=? LIMIT 1', p.id), '已產生實體獎品，不可更改履約單位');
      const d = JSON.parse(p.service_request); store.run('UPDATE pools SET verification=?,fulfillment=? WHERE id=?', d.verification, d.officialFulfillment ? 'official' : 'creator', p.id);
    }
    store.run('UPDATE pools SET service_request=NULL WHERE id=?', p.id); store.audit(currentUser(req).id, 'service_review', p.id, { approve }); return { ok: true };
  }));
  app.post('/api/admin/pools/:id/cancel', (req, res) => mutation(req, res, () => {
    const p = requireRow(store.one('SELECT * FROM pools WHERE id=?', getId(req))), { note } = z.object({ note: text(1000) }).strict().parse(req.body);
    assert(!['cancelled','settled'].includes(p.status) && p.remaining === p.total, '已有抽獎紀錄的池不可刪除或取消');
    if (p.reserve_points) store.balance(p.owner_id, p.reserve_points, 'pool_cancel', p.id);
    store.run("UPDATE pools SET status='cancelled',reserve_points=0,review_note=? WHERE id=?", note, p.id); store.audit(currentUser(req).id, 'pool_cancel', p.id, { note }); return { ok: true };
  }));
  app.get('/api/admin/topups', (_req, res) => res.json(store.all('SELECT t.*,u.email FROM topups t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 200')));
  app.post('/api/admin/topups/:id/review', (req, res) => mutation(req, res, () => {
    const t = requireRow(store.one('SELECT * FROM topups WHERE id=?', getId(req))), { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    assert(config.manualTopups, '儲值服務未啟用', 503); assert(t.status === 'pending', '儲值單已處理'); assert(t.user_id !== currentUser(req).id, '不可審核自己的儲值', 403);
    if (approve) store.balance(t.user_id, t.points, 'manual_topup', t.id);
    store.run('UPDATE topups SET status=?,reviewed_by=? WHERE id=?', approve ? 'approved' : 'rejected', currentUser(req).id, t.id); store.audit(currentUser(req).id, 'topup_review', t.id, { approve }); return { ok: true };
  }));
  app.get('/api/admin/settlements', (_req, res) => res.json(store.all('SELECT * FROM settlements ORDER BY created_at DESC LIMIT 200')));
  app.post('/api/admin/settlements/:id/approve', (req, res) => mutation(req, res, () => {
    const s = requireRow(store.one('SELECT * FROM settlements WHERE id=?', getId(req))), p = requireRow(store.one('SELECT * FROM pools WHERE id=?', s.pool_id));
    assert(s.status === 'requested', '結算單已處理'); assert(s.owner_id !== currentUser(req).id, '不可審核自己的結算', 403); assertSettlement(p);
    const net = s.gross_points - s.fee_points + s.reserve_returned;
    if (net) store.balance(s.owner_id, net, 'pool_settlement', s.id);
    store.run("UPDATE settlements SET status='approved',reviewed_by=? WHERE id=?", currentUser(req).id, s.id); store.run("UPDATE pools SET status='settled',reserve_points=0 WHERE id=?", p.id); store.audit(currentUser(req).id, 'settlement_approve', s.id); return { ok: true };
  }));
  app.get('/api/admin/audit', (_req, res) => res.json(store.all('SELECT * FROM audit ORDER BY created_at DESC,rowid DESC LIMIT 300')));
  app.get('/api/admin/pools/:id/draws', (req, res) => res.json(store.all('SELECT d.*,u.email,u.name player,r.name prize FROM draws d JOIN users u ON u.id=d.user_id JOIN prizes r ON r.id=d.prize_id WHERE d.pool_id=? ORDER BY ordinal LIMIT 10000', getId(req))));
  app.use('/api', (_req, _res) => { throw new HttpError(404, 'API 不存在'); });
  app.use('/uploads', express.static(config.uploadDir, { dotfiles: 'deny', index: false, maxAge: '1y', immutable: true, setHeaders(res) { res.setHeader('Content-Type', 'image/webp'); } }));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  app.use((_req, res) => res.status(404).json({ error: '找不到頁面' }));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: '輸入資料格式不正確', fields: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error.type === 'entity.too.large') { res.status(413).json({ error: '檔案或資料超過大小限制' }); return; }
    if (error.type === 'entity.parse.failed') { res.status(400).json({ error: 'JSON 格式不正確' }); return; }
    console.error(JSON.stringify({ event: 'request_error', code: error.code ?? 'unknown', message: error.message }));
    res.status(500).json({ error: '伺服器暫時無法完成操作，請保留請求識別碼並聯絡官方' });
  });
  return app;
}
