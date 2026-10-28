import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, physicalPool } from './helpers.js';

test('up to 100 actual named items/results per pool, with every draw winning, are accepted and editable',async()=>{
  const f=await fixture();
  try{
    const prizes=Array.from({length:100},(_,i)=>({name:i===99?'自訂保底物品':`自訂上架物品 ${i+1}`,kind:'physical',image:'',value:100,redeemPoints:0,quantity:1}));
    const tooMany=await f.creator.request('/api/pools',{...physicalPool(),prizes:[...prizes,prizes[0]]});assert.equal(tooMany.status,400);
    const created=await f.creator.request('/api/pools',{...physicalPool(),name:'一百個實際上架結果',prizes});assert.equal(created.status,200);
    const id=created.data.id;
    assert.equal((await f.admin.request('/api/admin/pools/'+id+'/prizes',{prizes})).status,200);
    const pool=(await f.creator.request('/api/pools/'+id)).data;assert.equal(pool.prizes.length,100);assert.equal(pool.prizes.at(-1).kind,'physical');
    const odds=pool.prizes.map((p:any)=>({id:p.id,probabilityBps:p.name==='自訂保底物品'?10000:0}));
    assert.equal((await f.admin.request('/api/admin/pools/'+id+'/odds',{expectedVersion:pool.odds_version,prizes:odds})).status,200);
    const updated=(await f.creator.request('/api/pools/'+id)).data;
    assert.equal(updated.prizes.find((p:any)=>p.name==='自訂保底物品').effectiveProbability,1);
    const invalid=[...prizes];invalid[99]={...invalid[99],kind:'none',value:0};
    assert.equal((await f.admin.request('/api/admin/pools/'+id+'/prizes',{prizes:invalid})).status,400);
  }finally{await f.close();}
});

test('item probabilities are scoped to one pool; winning draw creates collectible and isolates other pools',async()=>{
  const f=await fixture();
  try{
    const data={...physicalPool(),kind:'free',price:0,prizes:[{name:'自訂限定模型',kind:'physical',image:'',value:100,redeemPoints:0,quantity:2},{name:'自訂保底物品',kind:'physical',image:'',value:0,redeemPoints:0,quantity:5}]};
    const a=(await f.creator.request('/api/pools',{...data,name:'獎池 A'})).data.id,b=(await f.creator.request('/api/pools',{...data,name:'獎池 B'})).data.id;
    const pa=(await f.creator.request('/api/pools/'+a)).data,pb=(await f.creator.request('/api/pools/'+b)).data;
    const aOdds=pa.prizes.map((p:any)=>({id:p.id,probabilityBps:p.name==='自訂保底物品'?10000:0}));
    const bOdds=pb.prizes.map((p:any)=>({id:p.id,probabilityBps:p.name==='自訂保底物品'?1000:9000}));
    assert.equal((await f.admin.request('/api/admin/pools/'+b+'/odds',{expectedVersion:0,prizes:bOdds})).status,200);
    const before=(await f.creator.request('/api/pools/'+b)).data;
    assert.equal((await f.admin.request('/api/admin/pools/'+a+'/odds',{expectedVersion:0,prizes:aOdds})).status,200);
    const after=(await f.creator.request('/api/pools/'+b)).data;assert.deepEqual(after,before);
    const wrong=aOdds.map((p:any,i:number)=>i===0?{...p,id:pb.prizes[0].id}:p);
    assert.equal((await f.admin.request('/api/admin/pools/'+a+'/odds',{expectedVersion:1,prizes:wrong})).status,400);
    assert.equal((await f.creator.request('/api/pools/'+a+'/submit',{})).status,200);
    assert.equal((await f.admin.request('/api/admin/pools/'+a+'/review',{approve:true,note:'隔離的每抽必中測試'})).status,200);
    assert.equal((await f.creator.request('/api/pools/'+a+'/open',{})).status,200);
    const draw=await f.player.request('/api/pools/'+a+'/draw',{quantity:1,oddsVersion:1});assert.equal(draw.status,200);
    assert.equal(draw.data.results[0].kind,'physical');assert.equal(draw.data.results[0].name,'自訂保底物品');assert.equal(draw.data.points,10000);
    assert.equal((await f.player.request('/api/me/collection')).data.length,1);
    assert.equal(f.store.one("SELECT count(*) n FROM ledger WHERE user_id=? AND kind='prize_points'",f.ids.player)!.n,0);
    assert.deepEqual((await f.creator.request('/api/pools/'+b)).data,before);
  }finally{await f.close();}
});