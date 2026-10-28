import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {ensurePracticePool} from '../src/practice.js';
import {poolDetailView,drawResultView,poolCardView} from '../src/visual.js';
const seed=(f:Awaited<ReturnType<typeof fixture>>)=>f.store.tx(()=>ensurePracticePool(f.store,'admin@example.test')).id as string;
test('main-site test pool is listed and idempotently created without fake commercial inventory or revenue',async()=>{
 const f=await fixture({paidDraws:false,manualTopups:false});try{
  const id=seed(f);assert.equal(seed(f),id);
  const p=(await f.client().request('/api/pools')).data.find((p:any)=>p.id===id);
  assert.equal(p.testOnly,true);assert.equal(p.price,0);assert.equal(p.prizes.length,3);assert.equal(p.prizes.reduce((s:number,r:any)=>s+r.weight_bps,0),10000);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM pools')!.n,0);
  assert.match(poolCardView(p),/不扣點・不出貨/);assert.match(poolDetailView(p,'test'),/測試籤數，不是實體庫存/);
  assert.equal((await f.client().request('/api/admin/practice')).status,401);assert.equal((await f.player.request('/api/admin/practice')).status,403);
 }finally{await f.close();}
});
test('repeat test draws use server odds and saved ticket positions; no points, physical entitlement, shipping, tasks or live winner ticker',async()=>{
 const f=await fixture({paidDraws:false,manualTopups:false});try{
  const id=seed(f),url='/api/pools/'+id+'/draw',key=randomUUID(),body={quantity:3,oddsVersion:1,presentationSlots:[2,5,8]};
  assert.equal((await f.client().request(url,body)).status,401);
  assert.equal((await f.player.request(url,body,{origin:'https://attacker.test'})).status,403);
  assert.equal((await f.player.request(url,body,{csrf:'bad'})).status,403);
  const a=await f.player.request(url,body,{key});assert.equal(a.status,200);assert.equal(a.data.testOnly,true);assert.equal(a.data.points,10000);
  assert.deepEqual((await f.player.request(url,body,{key})).data,a.data);assert.equal((await f.player.request(url,{...body,quantity:2},{key})).status,409);
  assert.equal((await f.player.request(url,{quantity:1,oddsVersion:1})).status,200);
  const list=(await f.player.request('/api/me/draws')).data;assert.equal(list.length,4);assert.ok(list.every((d:any)=>d.testOnly));
  const replay=await f.player.request('/api/me/draws/'+a.data.results[0].id);assert.equal(replay.data.presentationSlot,2);assert.equal((await f.other.request('/api/me/draws/'+a.data.results[0].id)).status,404);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM collection')!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM shipments')!.n,0);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM ledger')!.n,4);assert.equal(f.store.one('SELECT COUNT(*) n FROM payment_orders')!.n,0);
  assert.equal((await f.player.request('/api/collection/'+a.data.results[0].id+'/redeem',{})).status,404);
  assert.equal((await f.client().request('/api/community/live')).data.events.length,0);
  const d=(await f.admin.request('/api/admin/activity')).data;assert.equal(d.stats.drawsToday,0);assert.equal(d.testDrawsToday,4);assert.equal(d.testDraws.length,4);
  assert.match(drawResultView(a.data.results),/不扣點、不發放實體商品/);
  assert.equal((await f.admin.request('/api/admin/practice')).data.count,4);
 }finally{await f.close();}
});
test('test pool odds are independently editable, version checked, and cannot be converted into a paid pool',async()=>{
 const f=await fixture({paidDraws:false});try{
  const id=seed(f),p=(await f.client().request('/api/pools/'+id)).data,prize=p.prizes[0];
  const body={expectedVersion:1,prizes:p.prizes.map((r:any)=>({id:r.id,probabilityBps:r.id===prize.id?10000:0}))};
  assert.equal((await f.player.request('/api/admin/pools/'+id+'/odds',body)).status,403);
  assert.equal((await f.admin.request('/api/admin/pools/'+id+'/odds',body)).status,200);
  assert.equal((await f.admin.request('/api/admin/pools/'+id+'/odds',body)).status,409);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:1})).status,409);
  const r=await f.player.request('/api/pools/'+id+'/draw',{quantity:10,oddsVersion:2});assert.equal(r.status,200);assert.ok(r.data.results.every((r:any)=>r.prizeId===prize.id));
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:2,price:100})).status,400);
  assert.equal((await f.admin.request('/api/pools/'+id+'/open',{})).status,404);
  f.store.run("UPDATE practice_pools SET status='cancelled' WHERE id=?",id);
  assert.equal((await f.client().request('/api/pools')).data.length,0);
  assert.equal((await f.client().request('/api/pools/'+id)).status,404);
  assert.equal((await f.player.request('/api/me/draws/'+r.data.results[0].id)).status,200);
 }finally{await f.close();}
});
