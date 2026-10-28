import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import {fixture,testPassword} from './helpers.js';
import {ensurePracticePool} from '../src/practice.js';
import {practiceAdminView} from '../src/practice-view.js';
import {totp} from '../src/identity.js';
const body={action:'hide',expectedVersion:1,confirmed:true,password:testPassword};
const seed=(f:Awaited<ReturnType<typeof fixture>>)=>f.store.tx(()=>ensurePracticePool(f.store,'admin@example.test')).id as string;

test('practice hide/reopen requires admin, Origin/CSRF, strict confirmation and current password; failures are limited',async()=>{
 const f=await fixture();try{
  const id=seed(f),url='/api/admin/practice/'+id+'/status';
  assert.equal((await f.client().request(url,body)).status,401);assert.equal((await f.player.request(url,body)).status,403);
  assert.equal((await f.admin.request(url,body,{origin:'https://evil.invalid'})).status,403);assert.equal((await f.admin.request(url,body,{csrf:'bad'})).status,403);
  assert.equal((await f.admin.request(url,{...body,confirmed:false})).status,400);assert.equal((await f.admin.request(url,{...body,action:'delete'})).status,400);assert.equal((await f.admin.request(url,{...body,price:100})).status,400);
  for(let i=0;i<5;i++)assert.equal((await f.admin.request(url,{...body,password:'wrong'})).status,401);
  const limited=await f.admin.request(url,body);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'900');
  assert.equal(f.store.one('SELECT status FROM practice_pools WHERE id=?',id)!.status,'live');
 }finally{await f.close();}
});

test('hiding removes public entry but retains admin history; reopening preserves tickets and odds and invalidates old draw versions',async()=>{
 const f=await fixture({paidDraws:false});try{
  const id=seed(f),url='/api/admin/practice/'+id+'/status',key=randomUUID();
  const first=await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:1,presentationSlots:[4]});assert.equal(first.status,200);
  const before=f.store.all('SELECT id,quantity,remaining,weight_bps FROM practice_prizes WHERE pool_id=? ORDER BY id',id);
  const hidden=await f.admin.request(url,body,{key});assert.equal(hidden.status,200);assert.equal(hidden.data.version,2);assert.deepEqual((await f.admin.request(url,body,{key})).data,hidden.data);
  assert.equal((await f.client().request('/api/pools')).data.length,0);assert.equal((await f.player.request('/api/pools/'+id)).status,404);assert.equal((await f.admin.request('/api/pools/'+id)).status,200);
  const admin=await f.admin.request('/api/admin/practice');assert.equal(admin.data.pools.length,1);assert.equal(admin.data.pools[0].status,'cancelled');assert.equal(admin.data.refreshSeconds,5);assert.ok(admin.data.generatedAt);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:2})).status,409);
  assert.equal((await f.player.request('/api/me/draws/'+first.data.results[0].id)).status,200);
  assert.equal((await f.admin.request(url,{...body,action:'restore'})).status,409);
  const restored=await f.admin.request(url,{...body,action:'restore',expectedVersion:2});assert.equal(restored.status,200);assert.equal(restored.data.version,3);
  const visible=(await f.client().request('/api/pools')).data[0];assert.equal(visible.remaining,9999);assert.equal(visible.testOnly,true);assert.equal(visible.price,0);
  assert.deepEqual(f.store.all('SELECT id,quantity,remaining,weight_bps FROM practice_prizes WHERE pool_id=? ORDER BY id',id),before);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:1})).status,409);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:3})).status,200);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM collection')!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM ledger')!.n,4);
 }finally{await f.close();}
});

test('status change cannot revive exhausted pools or silently undo another operator odds update',async()=>{
 const f=await fixture();try{
  const id=seed(f),url='/api/admin/practice/'+id+'/status',p=(await f.admin.request('/api/pools/'+id)).data;
  assert.equal((await f.admin.request('/api/admin/pools/'+id+'/odds',{expectedVersion:1,prizes:p.prizes.map((r:any)=>({id:r.id,probabilityBps:r.weight_bps}))})).status,200);
  assert.equal((await f.admin.request(url,body)).status,409);
  assert.equal((await f.admin.request(url,{...body,expectedVersion:2})).status,200);
  f.store.run('UPDATE practice_pools SET remaining=0 WHERE id=?',id);
  assert.equal((await f.admin.request(url,{...body,action:'restore',expectedVersion:3})).status,409);
  assert.equal(f.store.one('SELECT status FROM practice_pools WHERE id=?',id)!.status,'cancelled');
 }finally{await f.close();}
});

test('logout or credentials revoked during asynchronous status password verification cannot change the pool',async()=>{
 for(const revoke of ['logout','email','role','disabled','password']){
  const f=await fixture();try{
   const id=seed(f),one=f.store.one.bind(f.store);let fired=false;
   f.store.one=(sql:string,...args:SQLInputValue[])=>{const row=one(sql,...args);if(!fired&&sql==='SELECT * FROM users WHERE id=?'&&args[0]===f.ids.admin){fired=true;queueMicrotask(()=>{
    if(revoke==='logout')f.store.run('DELETE FROM sessions WHERE user_id=?',f.ids.admin);
    if(revoke==='email')f.store.run("UPDATE users SET email='renamed-admin@example.test' WHERE id=?",f.ids.admin);
    if(revoke==='role')f.store.run("UPDATE users SET role='player' WHERE id=?",f.ids.admin);
    if(revoke==='disabled')f.store.run('UPDATE users SET disabled=1 WHERE id=?',f.ids.admin);
    if(revoke==='password')f.store.run("UPDATE users SET password_hash='revoked' WHERE id=?",f.ids.admin);
   });}return row;};
   const r=await f.admin.request('/api/admin/practice/'+id+'/status',body);assert.ok(fired);assert.ok([401,403].includes(r.status),revoke+': '+r.status);
   assert.equal(f.store.one('SELECT status FROM practice_pools WHERE id=?',id)!.status,'live');
  }finally{await f.close();}
 }
});

test('enrolled administrator MFA is required and a valid code authorizes only one idempotent status transition',async()=>{
 const f=await fixture();try{
  const id=seed(f),url='/api/admin/practice/'+id+'/status';f.config.identity.authSecret='ab'.repeat(32);
  const setup=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});assert.equal(setup.status,200);
  assert.equal((await f.admin.request('/api/admin/mfa/enable',{code:totp(setup.data.secret)})).status,200);
  const missing=await f.admin.request(url,body);assert.equal(missing.status,401);assert.equal(missing.data.code,'MFA_REQUIRED');
  const otp=totp(setup.data.secret,Math.floor(Date.now()/30000)+1),key=randomUUID();
  const first=await f.admin.request(url,{...body,otp},{key});assert.equal(first.status,200);
  assert.deepEqual((await f.admin.request(url,{...body,otp},{key})).data,first.data);
  assert.equal((await f.admin.request(url,{...body,action:'restore',expectedVersion:2,otp})).status,401);
 }finally{await f.close();}
});

test('old test results remain replayable by owner after 200 newer results without leaking to another member',async()=>{
 const f=await fixture();try{
  const pool=seed(f),prize=f.store.one('SELECT id FROM practice_prizes WHERE pool_id=?',pool)!.id,id=randomUUID();
  f.store.tx(()=>{for(let n=0;n<201;n++)f.store.run('INSERT INTO practice_draws VALUES(?,?,?,?,?,?,?)',n===0?id:randomUUID(),pool,f.ids.player,prize,n,4,Date.now()+n);f.store.run('UPDATE practice_pools SET remaining=remaining-201 WHERE id=?',pool);f.store.run('UPDATE practice_prizes SET remaining=remaining-201 WHERE id=?',prize);});
  assert.equal((await f.player.request('/api/me/draws')).data.length,200);
  assert.equal((await f.player.request('/api/me/draws/'+id)).status,200);assert.equal((await f.other.request('/api/me/draws/'+id)).status,404);
 }finally{await f.close();}
});

test('practice admin UI labels test capacity honestly, escapes source data and exposes reversible controls only',()=>{
 const p={id:'one',name:'<script>bad</script>',status:'cancelled',remaining:5,total:10,odds_version:2,prizes:[{name:'<img onerror=bad>',image:'/assets/ref.svg',quantity:10,remaining:5,weight_bps:10000,effectiveProbability:1}]};
 const html=practiceAdminView({pools:[p],draws:[{created_at:1,player:'<script>player</script>',email:'x@example.test',prize:'test',slot:4}],count:1});
 assert.match(html,/不是實體庫存/);assert.match(html,/不刪除|不清除/);assert.match(html,/恢復到首頁/);assert.match(html,/data-practice-count/);assert.doesNotMatch(html,/<script>|onerror=bad>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/建立獎池|加入實體商品草稿/);
});
