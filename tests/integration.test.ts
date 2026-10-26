import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fixture, livePool, physicalPool, testPassword, type Fixture } from './helpers.js';
import { sha256, ticketOrder } from '../src/fairness.js';
import { readConfig } from '../src/config.js';
import { Store } from '../src/db.js';
process.env.QUIET_LOGS = 'true';
const check = (name: string, fn: (f: Fixture) => Promise<void>) => test(name, async () => { const f = await fixture(); try { await fn(f); } finally { await f.close(); } });
check('registration hashes passwords, rejects role injection and persists a real session',async f => {
  const client = f.client(); let r = await client.request('/api/auth/register',{email:'new@example.test',name:'New user',password:testPassword,role:'admin'}); assert.equal(r.status,400);
  r = await client.request('/api/auth/register',{email:'new@example.test',name:'New user',password:testPassword}); assert.equal(r.status,201); assert.equal(r.data.user.role,'player'); assert.equal(r.data.user.points,0);
  assert.match(r.headers.get('set-cookie')!,/HttpOnly/); assert.match(r.headers.get('set-cookie')!,/SameSite=Strict/);
  const row = f.store.one('SELECT * FROM users WHERE email=?','new@example.test')!; assert.notEqual(row.password_hash,testPassword);
  assert.equal((await client.request('/api/auth/me')).data.user.id,row.id);
  assert.equal((await client.request('/api/auth/logout',{})).status,200); assert.equal((await client.request('/api/auth/me')).data.user,null);
});
check('CSRF, origin, JSON validation and admin routes reject hostile requests',async f => {
  assert.equal((await f.player.request('/api/admin/users')).status,403);
  assert.equal((await f.client().request('/api/admin/users')).status,401);
  assert.equal((await f.player.request('/api/creator/request',{}, {csrf:'invalid'})).status,403);
  assert.equal((await f.player.request('/api/creator/request',{}, {origin:'https://evil.test'})).status,403);
  assert.equal((await f.player.request('/api/creator/request',{}, {contentType:'text/plain'})).status,415);
  const r = await f.client().request('/health/live'); assert.equal(r.status,200); assert.match(r.headers.get('content-security-policy')!,/script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'),'nosniff'); assert.equal(r.headers.get('access-control-allow-origin'),null);
});
check('creator approval is enforced server-side and role changes invalidate sessions',async f => {
  assert.equal((await f.player.request('/api/pools',physicalPool())).status,403);
  assert.equal((await f.player.request('/api/creator/request',{})).status,200);
  assert.equal((await f.admin.request(`/api/admin/users/${f.ids.player}`,{role:'creator',disabled:false})).status,200);
  assert.equal((await f.player.request('/api/auth/me')).data.user,null);
  await f.player.login('player'); assert.equal((await f.player.request('/api/pools',physicalPool())).status,200);
  assert.equal((await f.admin.request(`/api/admin/users/${f.ids.admin}`,{role:'player',disabled:true})).status,409);
});
check('unreviewed pools cannot be drawn, listed publicly or modified by other players',async f => {
  const r = await f.creator.request('/api/pools',physicalPool()); const id = r.data.id;
  assert.equal((await f.player.request(`/api/pools/${id}`)).status,404); assert.equal((await f.client().request('/api/pools')).data.length,0);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1})).status,409);
  assert.equal((await f.other.request(`/api/pools/${id}/content`,{description:'hijack',cover:'',descriptionImages:[]})).status,403);
  assert.equal((await f.creator.request(`/api/pools/${id}/open`,{})).status,409);
});
check('submission freezes exact liabilities and rejection returns them exactly once',async f => {
  const id = (await f.creator.request('/api/pools',physicalPool(3))).data.id;
  const key = randomUUID(); assert.equal((await f.creator.request(`/api/pools/${id}/submit`,{}, {key})).status,200);
  assert.equal((await f.creator.request(`/api/pools/${id}/submit`,{}, {key})).status,200);
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.creator)!.points,9850);
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/review`,{approve:false,note:'庫存未確認'})).status,200);
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.creator)!.points,10000);
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/review`,{approve:false,note:'再試'})).status,409);
});
check('parallel duplicate draw requests debit only once and return the same draw',async f => {
  const id = await livePool(f,physicalPool(5)), key = randomUUID();
  const responses = await Promise.all(Array.from({length:8},() => f.player.request(`/api/pools/${id}/draw`,{quantity:1},{key})));
  responses.forEach(r => { assert.equal(r.status,200); assert.deepEqual(r.data,responses[0].data); });
  assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,1); assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,9900);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:2},{key})).status,409);
});
check('competing requests for the final prize never oversell or double debit',async f => {
  const id = await livePool(f);
  const results = await Promise.all([f.player.request(`/api/pools/${id}/draw`,{quantity:1}),f.other.request(`/api/pools/${id}/draw`,{quantity:1})]);
  assert.deepEqual(results.map(r => r.status).sort(),[200,409]);
  assert.equal(f.store.one('SELECT remaining FROM pools WHERE id=?',id)!.remaining,0);
  assert.equal(f.store.one('SELECT SUM(points) n FROM users WHERE id IN (?,?)',f.ids.player,f.ids.other)!.n,19900);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,1);
});
check('insufficient funds roll back draws, inventory, ledgers and idempotency',async f => {
  const data = physicalPool(); data.price = 10001; const id = await livePool(f,data), key = randomUUID();
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1},{key})).status,409);
  assert.equal(f.store.one('SELECT remaining FROM pools WHERE id=?',id)!.remaining,1); assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,0);
  assert.equal(f.store.one('SELECT 1 FROM idempotency WHERE key=?',key),undefined);
});
check('negative, fractional, oversized and forged draw inputs are rejected',async f => {
  const id = await livePool(f,physicalPool(20));
  for (const quantity of [-1,0,0.5,11,'1']) assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity})).status,400);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1,prizeId:'jackpot',cost:0})).status,400);
  assert.equal((await f.creator.request(`/api/pools/${id}/draw`,{quantity:1})).status,403);
  assert.equal((await f.admin.request(`/api/pools/${id}/draw`,{quantity:1})).status,403);
});
check('free drops enforce one claim per account and preserve finite prize inventory',async f => {
  const data = physicalPool(4); data.kind = 'free'; data.price = 0; const id = await livePool(f,data);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1})).status,200);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1})).status,409);
  assert.equal((await f.other.request(`/api/pools/${id}/draw`,{quantity:2})).status,400);
  assert.equal(f.store.one('SELECT remaining FROM pools WHERE id=?',id)!.remaining,3);
});
check('commitment hides seed before sell-out and fully verifies ordered finite draws after',async f => {
  const data = physicalPool(2); data.prizes.push({name:'點數',kind:'points',value:75,redeemPoints:0,quantity:2,image:''});
  const id = await livePool(f,data); const publicPool = (await f.client().request(`/api/pools/${id}`)).data;
  assert.equal(publicPool.seed,undefined); const before = (await f.client().request(`/api/pools/${id}/proof`)).data; assert.equal(before.seed,null);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:4})).status,200);
  const proof = (await f.client().request(`/api/pools/${id}/proof`)).data;
  assert.equal(sha256(proof.seed),before.commitment); assert.equal(sha256(proof.manifest),proof.manifestHash);
  assert.deepEqual(ticketOrder(proof.seed,JSON.parse(proof.manifest)),proof.draws.map((d: any) => d.prize_id));
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,9750);
  assert.equal(f.store.one('SELECT reserve_points FROM pools WHERE id=?',id)!.reserve_points,100);
});
check('content changes wait for review; admin changes never alter prize or price terms',async f => {
  const id = await livePool(f); const update = {description:'修改內容 <script>alert(1)</script>',cover:'',descriptionImages:[]};
  assert.equal((await f.creator.request(`/api/pools/${id}/content`,update)).status,200);
  assert.equal((await f.player.request(`/api/pools/${id}`)).data.description,'真實資料庫測試');
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/content-review`,{approve:true})).status,200);
  assert.equal((await f.player.request(`/api/pools/${id}`)).data.description,update.description);
  assert.equal((await f.admin.request(`/api/pools/${id}/content`,{...update,price:0})).status,400);
});
check('shipment authorization, fulfillment separation and redeem race protect each asset',async f => {
  const id = await livePool(f); await f.player.request(`/api/pools/${id}/draw`,{quantity:1});
  const item = (await f.player.request('/api/me/collection')).data[0];
  assert.equal((await f.other.request(`/api/collection/${item.id}/redeem`,{})).status,404);
  const body = {itemIds:[item.id],name:'測試收件人',phone:'0912345678',address:'測試地址 123 號'};
  assert.equal((await f.other.request('/api/shipments',body)).status,404);
  const results = await Promise.all([f.player.request('/api/shipments',body),f.player.request(`/api/collection/${item.id}/redeem`,{})]);
  assert.deepEqual(results.map(r => r.status).sort(),[200,409]);
  if (results[0].status === 200) {
    const sid = results[0].data.id;
    assert.equal((await f.other.request(`/api/shipments/${sid}/ship`,{carrier:'郵局',tracking:'TEST12345'})).status,403);
    assert.equal((await f.creator.request(`/api/shipments/${sid}/ship`,{carrier:'郵局',tracking:'TEST12345'})).status,200);
    assert.equal((await f.player.request(`/api/collection/${item.id}/redeem`,{})).status,409);
    assert.equal((await f.player.request(`/api/shipments/${sid}/receive`,{})).status,200);
  }
});
check('official shipment details stay hidden from creators and can only be shipped by admin',async f => {
  const id = await livePool(f);
  assert.equal((await f.creator.request(`/api/pools/${id}/service`,{verification:'inventory',officialFulfillment:true,note:'庫存已交接'})).status,200);
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/service-review`,{approve:true})).status,200);
  await f.player.request(`/api/pools/${id}/draw`,{quantity:1}); const item = (await f.player.request('/api/me/collection')).data[0];
  const sid = (await f.player.request('/api/shipments',{itemIds:[item.id],name:'收件人',phone:'0912345678',address:'測試地址'})).data.id;
  assert.equal((await f.creator.request('/api/fulfillment/shipments')).data.length,0);
  assert.equal((await f.creator.request(`/api/shipments/${sid}/ship`,{carrier:'X',tracking:'1234'})).status,403);
  assert.equal((await f.admin.request(`/api/shipments/${sid}/ship`,{carrier:'郵局',tracking:'1234'})).status,200);
});
check('settlement blocks outstanding liabilities then releases net and reserve exactly once',async f => {
  const id = await livePool(f); await f.player.request(`/api/pools/${id}/draw`,{quantity:1});
  assert.equal((await f.creator.request(`/api/pools/${id}/settlement`,{})).status,409);
  const item = (await f.player.request('/api/me/collection')).data[0]; await f.player.request(`/api/collection/${item.id}/redeem`,{});
  const r = await f.creator.request(`/api/pools/${id}/settlement`,{}); assert.equal(r.status,200); const key = randomUUID();
  assert.equal((await f.admin.request(`/api/admin/settlements/${r.data.id}/approve`,{}, {key})).status,200);
  assert.equal((await f.admin.request(`/api/admin/settlements/${r.data.id}/approve`,{}, {key})).status,200);
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.creator)!.points,10045); // 10000 - 50 reserve + 95 revenue
  assert.equal(f.store.one('SELECT status FROM pools WHERE id=?',id)!.status,'settled');
});
check('manual topup requires review, unique receipt and an independent administrator',async f => {
  const body = {points:500,reference:'BANK-20260001'}, r = await f.player.request('/api/topups',body); assert.equal(r.status,200);
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
  assert.equal((await f.other.request('/api/topups',body)).status,409);
  assert.equal((await f.player.request(`/api/admin/topups/${r.data.id}/review`,{approve:true})).status,403);
  const results = await Promise.all([f.admin.request(`/api/admin/topups/${r.data.id}/review`,{approve:true}),f.admin.request(`/api/admin/topups/${r.data.id}/review`,{approve:true})]);
  assert.deepEqual(results.map(r => r.status).sort(),[200,409]); assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10500);
});
check('admin cannot self-approve pools and cannot delete pools with draws',async f => {
  const self = (await f.admin.request('/api/pools',physicalPool())).data.id; await f.admin.request(`/api/pools/${self}/submit`,{});
  assert.equal((await f.admin.request(`/api/admin/pools/${self}/review`,{approve:true,note:'self'})).status,403);
  const id = await livePool(f); await f.player.request(`/api/pools/${id}/draw`,{quantity:1});
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/cancel`,{note:'cannot delete'})).status,409);
});
check('image uploads decode/re-encode, reject spoofed files and prevent cross-owner use',async f => {
  const png = await sharp({create:{width:20,height:20,channels:3,background:'#5f39ff'}}).png().toBuffer();
  const r = await f.creator.request('/api/uploads',undefined,{raw:new Uint8Array(png),contentType:'image/png'}); assert.equal(r.status,201,JSON.stringify(r.data));
  const response = await fetch(f.origin + r.data.url); assert.equal(response.headers.get('content-type'),'image/webp');
  assert.equal((await f.creator.request('/api/uploads',undefined,{raw:'<script>alert(1)</script>',contentType:'image/png'})).status,400);
  assert.equal((await f.creator.request('/api/uploads',undefined,{raw:'<svg/>',contentType:'image/svg+xml'})).status,415);
  assert.equal((await f.player.request('/api/uploads',undefined,{raw:new Uint8Array(png),contentType:'image/png'})).status,403);
  await f.admin.request(`/api/admin/users/${f.ids.other}`,{role:'creator',disabled:false}); await f.other.login('other');
  assert.equal((await f.other.request('/api/pools',{...physicalPool(),cover:r.data.url})).status,403);
});
check('password reset tokens expire, are single-use and revoke all sessions',async f => {
  const client = f.client(); assert.equal((await client.request('/api/auth/forgot',{email:'player@example.test'})).status,200);
  const files = readdirSync(path.join(f.directory,'dev-mail')); assert.equal(files.length,1);
  const token = readFileSync(path.join(f.directory,'dev-mail',files[0]),'utf8').split('/').at(-1)!;
  assert.equal((await client.request('/api/auth/reset',{token,password:'New-automated-test-password-234!'})).status,200);
  assert.equal((await f.player.request('/api/auth/me')).data.user,null);
  assert.equal((await client.request('/api/auth/reset',{token,password:testPassword})).status,400);
  assert.equal((await client.request('/api/auth/login',{email:'player@example.test',password:testPassword})).status,401);
});
check('login brute force is rate-limited with a retry delay',async f => {
  const client = f.client(); let response;
  for (let i = 0; i < 10; i++) response = await client.request('/api/auth/login',{email:'nobody@example.test',password:'wrong'});
  assert.equal(response!.status,429); assert.ok(response!.headers.get('retry-after'));
});
check('oversized uploads, malformed JSON and private source paths fail safely',async f => {
  assert.equal((await f.creator.request('/api/uploads',undefined,{raw:new Uint8Array(5*1024*1024+1),contentType:'image/png'})).status,413);
  assert.equal((await f.player.request('/api/creator/request',undefined,{raw:'{"broken":',contentType:'application/json'})).status,400);
  assert.equal((await f.client().request('/.env')).status,404);
  assert.equal((await f.client().request('/src/app.ts')).status,404);
  assert.equal((await f.client().request('/reference/app.js')).status,404);
});
check('pool validation rejects unbacked rewards, excess tickets and remote image URLs',async f => {
  const data = physicalPool();
  assert.equal((await f.creator.request('/api/pools',{...data,cover:'https://evil.test/tracker.png'})).status,400);
  assert.equal((await f.creator.request('/api/pools',{...data,prizes:[{...data.prizes[0],kind:'none',value:1}]})).status,400);
  assert.equal((await f.creator.request('/api/pools',{...data,prizes:[{...data.prizes[0],quantity:10000},{...data.prizes[0],quantity:1}]})).status,400);
  const id = (await f.creator.request('/api/pools',{...data,prizes:[{...data.prizes[0],redeemPoints:10001}]})).data.id;
  assert.equal((await f.creator.request(`/api/pools/${id}/submit`,{})).status,409);
  assert.equal(f.store.one('SELECT status FROM pools WHERE id=?',id)!.status,'draft');
});
check('disabled accounts cannot act using an existing session',async f => {
  assert.equal((await f.admin.request(`/api/admin/users/${f.ids.player}`,{role:'player',disabled:true})).status,200);
  assert.equal((await f.player.request('/api/creator/request',{})).status,401);
  assert.equal((await f.player.request('/api/auth/login',{email:'player@example.test',password:testPassword})).status,401);
});
check('settlement waiting period applies even after every asset is resolved',async f => {
  const id = await livePool(f); await f.player.request(`/api/pools/${id}/draw`,{quantity:1});
  const item = (await f.player.request('/api/me/collection')).data[0]; await f.player.request(`/api/collection/${item.id}/redeem`,{});
  f.config.holdHours = 48;
  assert.equal((await f.creator.request(`/api/pools/${id}/settlement`,{})).status,409);
});
check('cancelled untouched pools return reserve once and never become drawable',async f => {
  const id = await livePool(f); const key = randomUUID();
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/cancel`,{note:'取消未抽獎池'},{key})).status,200);
  assert.equal((await f.admin.request(`/api/admin/pools/${id}/cancel`,{note:'取消未抽獎池'},{key})).status,200);
  assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.creator)!.points,10000);
  assert.equal((await f.player.request(`/api/pools/${id}/draw`,{quantity:1})).status,409);
});
check('password reset explicitly rejects expired tokens',async f => {
  const token = 'a'.repeat(64);
  f.store.run('INSERT INTO resets VALUES (?,?,?)',sha256(token),f.ids.player,Date.now()-1);
  assert.equal((await f.client().request('/api/auth/reset',{token,password:testPassword})).status,400);
});
check('migration is idempotent, data persists across connections, audit and ledger are append-only',async f => {
  f.store.migrate(path.resolve('migrations')); const second = new Store(f.config.dbFile);
  try { assert.equal(second.one('SELECT COUNT(*) n FROM users')!.n,4); assert.equal(second.one('PRAGMA integrity_check')!.integrity_check,'ok'); } finally { second.close(); }
  assert.throws(() => f.store.run('UPDATE ledger SET delta=999'),/append-only/);
  f.store.audit(f.ids.admin,'test','test'); assert.throws(() => f.store.run('DELETE FROM audit'),/append-only/);
  assert.equal(f.store.all('PRAGMA foreign_key_check').length,0);
});
test('production rejects HTTP origins and development credit grants',() => {
  assert.throws(() => readConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'http://example.test'}),/HTTPS/);
  assert.throws(() => readConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://example.test',DEV_INITIAL_POINTS:'100'}),/forbidden/);
  const config = readConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://example.test'}); assert.equal(config.paidDraws,false); assert.equal(config.manualTopups,false);
});
