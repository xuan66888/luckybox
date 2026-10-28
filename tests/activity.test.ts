import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,livePool,testPassword} from './helpers.js';
import {activityLiveView} from '../src/activity-view.js';

test('activity is admin only, no-store, bounded and rejects malformed filters',async()=>{
 const f=await fixture();try{
  assert.equal((await f.client().request('/api/admin/activity')).status,401);
  assert.equal((await f.player.request('/api/admin/activity')).status,403);
  const r=await f.admin.request('/api/admin/activity');assert.equal(r.status,200);assert.match(r.headers.get('cache-control')!,/no-store/);assert.equal(r.data.refreshSeconds,5);
  assert.equal((await f.admin.request('/api/admin/activity?category=bad')).status,400);
  assert.equal((await f.admin.request('/api/admin/activity?q='+'x'.repeat(101))).status,400);
  assert.equal((await f.admin.request('/api/admin/activity?unknown=1')).status,400);
  for(let n=0;n<60;n++)f.store.audit(f.ids.admin,'admin_odds_update','pool-'+n,{version:n,password:'DO-NOT-RETURN',token:'DO-NOT-RETURN',quantity:1});
  const recent=(await f.admin.request('/api/admin/activity?category=catalog')).data;assert.equal(recent.items.length,50);assert.ok(recent.items.every((r:any)=>r.category==='catalog'));assert.ok(recent.items.every((r:any,i:number,a:any[])=>i===0||a[i-1].seq>r.seq));assert.equal(JSON.stringify(recent).includes('DO-NOT-RETURN'),false);
  assert.equal((await f.admin.request('/api/admin/activity?q=%25')).data.items.length,0);
  assert.equal((await f.admin.request('/api/admin/activity?q='+encodeURIComponent("' OR 1=1 --"))).data.items.length,0);
 }finally{await f.close();}
});
test('physical starter products are idempotent, private zero-stock drafts, never a public inventory claim',async()=>{
 const f=await fixture();try{
  assert.equal((await f.player.request('/api/admin/catalog/starter-drafts',{})).status,403);
  assert.equal((await f.admin.request('/api/admin/catalog/starter-drafts',{stock:999})).status,400);
  const key=randomUUID(),a=await f.admin.request('/api/admin/catalog/starter-drafts',{}, {key});assert.equal(a.status,200);assert.equal(a.data.created,3);assert.equal(a.data.publiclyAvailable,false);
  assert.deepEqual((await f.admin.request('/api/admin/catalog/starter-drafts',{}, {key})).data,a.data);
  assert.equal((await f.admin.request('/api/admin/catalog/starter-drafts',{})).data.created,0);
  const c=(await f.admin.request('/api/admin/catalog')).data;assert.equal(c.total,3);assert.ok(c.items.every((p:any)=>p.status==='draft'&&p.remaining===0&&p.prizes.length===1&&p.prizes[0].kind==='physical'&&p.prizes[0].remaining===0&&p.referenceSource.startsWith('https://kujiflip.tw/')));
  assert.equal((await f.player.request('/api/pools')).data.length,0);assert.equal((await f.player.request('/api/pools/'+c.items[0].id)).status,404);assert.equal((await f.admin.request('/api/admin/dashboard')).data.stats.physicalStock,0);
  const p=c.items[0];assert.equal((await f.admin.request('/api/admin/pools/'+p.id+'/odds',{expectedVersion:1,prizes:[{id:p.prizes[0].id,probabilityBps:10000}]})).status,200);
  assert.equal((await f.admin.request('/api/pools/'+p.id+'/open',{})).status,409);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM payment_orders')!.n,0);
  const events=(await f.admin.request('/api/admin/activity?category=catalog')).data.items;assert.equal(events.filter((r:any)=>r.action==='physical_drafts_created').length,1);
 }finally{await f.close();}
});
test('real registration/login/draw/payment records and ledger refresh from the main store only',async()=>{
 const f=await fixture();try{
  const c=f.client();assert.equal((await c.request('/api/auth/register',{email:'record@example.test',name:'紀錄玩家',password:testPassword})).status,201);
  await c.request('/api/auth/logout',{});await c.request('/api/auth/login',{email:'record@example.test',password:testPassword});
  const events=(await f.admin.request('/api/admin/activity?category=auth&q=record')).data.items;assert.ok(['register','login','logout'].every(action=>events.some((r:any)=>r.action===action)));assert.equal(JSON.stringify(events).includes(testPassword),false);
  const id=await livePool(f);assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1})).status,200);
  const t=Date.now();f.store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,trade_no,created_at,paid_at) VALUES(?,?,?,'stage',100,100,'paid',?,?,?)",'LOCAL-STAGE',f.ids.player,'3002607','LOCAL-TRADE',t,t);
  const d=(await f.admin.request('/api/admin/activity')).data;assert.equal(d.stats.paidTwdToday,0);assert.equal(d.stats.drawsToday,1);assert.equal(d.stats.spentToday,100);assert.equal(d.draws[0].cost,100);assert.equal(d.draws[0].prize,'收藏卡');assert.equal(d.payments[0].environment,'stage');assert.equal(d.ledger[0].delta,-100);assert.equal(d.items.some((r:any)=>r.action==='draw'),true);
  const html=activityLiveView({...d,items:[{id:'x',createdAt:t,action:'draw',actor:'<script>x</script>',email:'a@example.test',pool:'<img src=x>',target:'x',detail:{note:'<svg onload=x>'}}]});assert.equal(html.includes('<script>'),false);assert.equal(html.includes('<svg onload=x>'),false);assert.match(html,/&lt;script&gt;/);
 }finally{await f.close();}
});
