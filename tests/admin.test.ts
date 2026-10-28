import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, physicalPool, livePool, testPassword } from './helpers.js';
import { dashboard } from '../src/admin.js';
import { effectiveOdds, pickWeighted } from '../src/weighted.js';

test('dedicated admin login rejects normal accounts and creates only admin sessions',async()=>{
  const f=await fixture();
  try{
    const c=f.client();
    assert.equal((await c.request('/api/auth/admin-login',{email:'player@example.test',password:testPassword})).status,401);
    assert.equal((await c.request('/api/admin/dashboard')).status,401);
    assert.equal((await c.request('/api/auth/admin-login',{email:'admin@example.test',password:'wrong-password'})).status,401);
    assert.equal((await c.request('/api/auth/admin-login',{email:'admin@example.test',password:testPassword})).status,200);
    assert.equal((await c.request('/api/admin/dashboard')).status,200);
  }finally{await f.close();}
});

test('admin dashboard has real OHLC/curves, no player access and no test receipts counted as cash',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.player.request('/api/admin/dashboard')).status,403);
    assert.equal((await f.client().request('/api/admin/dashboard')).status,401);
    const now=Date.now(),t=now-1000;
    f.store.tx(()=>{f.store.balance(f.ids.player,100,'admin_metric_test','one');f.store.balance(f.ids.player,-50,'admin_metric_test','two');});
    const data=dashboard(f.store,'24h',now+2000),last=data.series.find(s=>s.events>0)!;
    assert.equal(data.series.length,24);
    assert.equal(last.open,0);assert.equal(last.high,40100);assert.equal(last.low,0);assert.equal(last.close,40050);
    assert.equal(data.stats.users,4);assert.equal(data.stats.points,40050);
    f.store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,trade_no,created_at,paid_at) VALUES (?,?,?,'stage',100,100,'paid',?,?,?)",'TESTSTAGE',f.ids.player,'3002607','STAGETRADE',t,t);
    const response=await f.admin.request('/api/admin/dashboard?period=7d');
    assert.equal(response.status,200);assert.equal(response.data.series.length,7);
    assert.equal(response.data.stats.paidTwd,0);assert.equal(response.data.stats.stagePaidTwd,100);
    assert.equal((await f.admin.request('/api/admin/dashboard?period=invalid')).status,400);
  }finally{await f.close();}
});
test('admin member creation, pagination, search, profile and role session revocation',async()=>{
  const f=await fixture();
  try{
    const body={email:'new-admin@example.test',name:'第二管理員',password:testPassword,role:'admin'};
    assert.equal((await f.player.request('/api/admin/members',body)).status,403);
    const key=randomUUID(),created=await f.admin.request('/api/admin/members',body,{key});
    assert.equal(created.status,200);
    assert.equal((await f.admin.request('/api/admin/members',body,{key})).data.id,created.data.id);
    assert.equal((await f.admin.request('/api/admin/members',body)).status,409);
    const member=await f.admin.request('/api/admin/members/'+created.data.id);
    assert.equal(member.data.points,0);assert.equal('password_hash' in member.data,false);
    const list=await f.admin.request('/api/admin/members?role=admin&q='+encodeURIComponent('第二'));
    assert.equal(list.data.total,1);assert.equal(list.data.items[0].id,created.data.id);
    assert.equal((await f.admin.request('/api/admin/members?q=%25')).data.total,0);
    assert.equal((await f.admin.request('/api/admin/members?q='+encodeURIComponent("' OR 1=1 --"))).data.total,0);
    assert.equal((await f.admin.request('/api/admin/members/'+created.data.id+'/profile',{email:'renamed@example.test',name:'新管理名稱'})).status,200);
    const login=f.client();assert.equal((await login.request('/api/auth/login',{email:'renamed@example.test',password:testPassword})).status,200);
    assert.equal((await login.request('/api/admin/dashboard')).status,200);
    assert.equal((await f.admin.request('/api/admin/users/'+created.data.id,{role:'player',disabled:false})).status,200);
    assert.equal((await login.request('/api/admin/dashboard')).status,401);
    assert.equal((await f.admin.request('/api/admin/users/'+f.ids.admin,{role:'player',disabled:true})).status,409);
    const audit=f.store.all("SELECT detail FROM audit WHERE action='admin_member_create'");
    assert.ok(audit.every(a=>!a.detail.includes(testPassword)));
  }finally{await f.close();}
});
test('admin catalog supports item CRUD before review and searchable live inventory',async()=>{
  const f=await fixture();
  try{
    const p=(await f.creator.request('/api/pools',physicalPool(3))).data.id;
    const prizes=[{name:'大獎',kind:'physical',image:'',value:1000,redeemPoints:0,quantity:1},{name:'二獎',kind:'physical',image:'',value:500,redeemPoints:0,quantity:2},{name:'三獎',kind:'physical',image:'',value:100,redeemPoints:0,quantity:7}];
    assert.equal((await f.player.request('/api/admin/pools/'+p+'/prizes',{prizes})).status,403);
    assert.equal((await f.admin.request('/api/admin/pools/'+p+'/prizes',{prizes})).status,200);
    const catalog=(await f.admin.request('/api/admin/catalog?q='+encodeURIComponent('大獎'))).data;
    assert.equal(catalog.total,1);assert.equal(catalog.items[0].prizes.length,3);assert.equal(catalog.items[0].total,10);
    await f.creator.request('/api/pools/'+p+'/submit',{});
    assert.equal((await f.admin.request('/api/admin/pools/'+p+'/prizes',{prizes})).status,409);
  }finally{await f.close();}
});
test('weighted odds choose explicit probabilities, exclude sold out and do not use quantity weights',()=>{
  const p=[{id:'grand',remaining:100,weight_bps:100},{id:'second',remaining:1,weight_bps:900},{id:'third',remaining:50,weight_bps:9000}];
  assert.equal(pickWeighted(p,()=>0).id,'grand');
  assert.equal(pickWeighted(p,()=>99).id,'grand');
  assert.equal(pickWeighted(p,()=>100).id,'second');
  assert.equal(pickWeighted(p,()=>1000).id,'third');
  assert.equal(pickWeighted(p,()=>9999).id,'third');
  p[2].remaining=0;assert.equal(effectiveOdds(p)[0].effectiveProbability,.1);assert.equal(effectiveOdds(p)[2].effectiveProbability,0);
  assert.throws(()=>pickWeighted(p.map(x=>({...x,weight_bps:0}))));
});
test('live item probabilities change actual results; zero percent, stale versions and old proof are handled correctly',async()=>{
  const f=await fixture();
  try{
    const pool=await livePool(f,{...physicalPool(),prizes:[{name:'大獎',kind:'physical',image:'',value:1000,redeemPoints:0,quantity:3},{name:'二獎',kind:'physical',image:'',value:500,redeemPoints:0,quantity:3},{name:'三獎',kind:'physical',image:'',value:100,redeemPoints:0,quantity:3}]});
    const items=f.store.all('SELECT id,name FROM prizes WHERE pool_id=? ORDER BY id',pool);
    const odds=(name:string)=>({expectedVersion:0,prizes:items.map(p=>({id:p.id,probabilityBps:p.name===name?10000:0}))});
    assert.equal((await f.player.request('/api/admin/pools/'+pool+'/odds',odds('三獎'))).status,403);
    const invalid=odds('三獎');invalid.prizes[0].probabilityBps=99;
    assert.equal((await f.admin.request('/api/admin/pools/'+pool+'/odds',invalid)).status,400);
    assert.equal((await f.admin.request('/api/admin/pools/'+pool+'/odds',odds('三獎'))).status,200);
    const detail=(await f.player.request('/api/pools/'+pool)).data;
    assert.equal(detail.draw_mode,'weighted');assert.equal(detail.odds_version,1);assert.equal('commitment' in detail,false);
    assert.equal(detail.prizes.find((p:any)=>p.name==='三獎').effectiveProbability,1);
    assert.equal((await f.player.request('/api/pools/'+pool+'/draw',{quantity:1})).status,409);
    const drawn=await f.player.request('/api/pools/'+pool+'/draw',{quantity:3,oddsVersion:1});
    assert.equal(drawn.status,200);assert.ok(drawn.data.results.every((p:any)=>p.name==='三獎'));
    const balance=f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points;
    assert.equal((await f.player.request('/api/pools/'+pool+'/draw',{quantity:1,oddsVersion:1})).status,409);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,balance);
    const switched={...odds('大獎'),expectedVersion:1};
    assert.equal((await f.admin.request('/api/admin/pools/'+pool+'/odds',switched)).status,200);
    assert.equal((await f.admin.request('/api/admin/pools/'+pool+'/odds',switched)).status,409);
    const next=await f.player.request('/api/pools/'+pool+'/draw',{quantity:1,oddsVersion:2});
    assert.equal(next.data.results[0].name,'大獎');
    const proof=(await f.player.request('/api/pools/'+pool+'/proof')).data;
    assert.equal(proof.verifiable,false);assert.equal(proof.algorithm,'weighted-live-v1');
    assert.ok(f.store.one("SELECT id FROM audit WHERE action='admin_odds_update'"));
  }finally{await f.close();}
});
