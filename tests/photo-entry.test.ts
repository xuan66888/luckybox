import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.js';
import {starterProducts} from '../src/starter-catalog.js';
import {adminFrame,membersView,catalogView} from '../src/admin-view.js';
import {sha256} from '../src/fairness.js';

test('physical reference photos preserve original raster bytes and carry verifiable primary-source attribution',()=>{
 const sources=JSON.parse(readFileSync('docs/PRODUCT_PHOTO_SOURCES.json','utf8'));
 assert.equal(sources.length,3);
 for(const s of sources){
  const svg=readFileSync(s.asset,'utf8');assert.equal(sha256(svg),s.assetSha256);
  const payload=svg.match(/href="data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)"/);assert.ok(payload);
  const bytes=Buffer.from(payload[2],'base64');assert.equal(bytes.length,s.bytes);assert.equal(sha256(bytes),s.sha256);
  assert.match(svg,/非本店實拍/);assert.doesNotMatch(svg,/<script|https?:\/\/[^<]*onload=/);
  assert.equal(starterProducts.find(p=>p.code===s.code)?.photoSource,s.page);
 }
});

test('admin catalog references only the matched physical starter item and never overwrites user uploads or creates stock',async()=>{
 const f=await fixture({paidDraws:false});try{
  await f.admin.request('/api/admin/catalog/starter-drafts',{});
  let d=(await f.admin.request('/api/admin/catalog')).data;
  assert.ok(d.items.every((p:any)=>p.remaining===0&&p.prizes[0].image===''&&p.prizes[0].referenceImage.startsWith('/assets/reference-')));
  assert.match(catalogView(d,''),/實體商品參考照片，非本店實拍/);
  const id=d.items[0].id;
  f.store.run("UPDATE prizes SET name='自訂商品' WHERE pool_id=?",id);
  d=(await f.admin.request('/api/admin/catalog')).data;
  assert.equal(d.items.find((p:any)=>p.id===id).prizes[0].referenceImage,undefined);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:1})).status,409);
  assert.equal(f.store.one('SELECT SUM(remaining) n FROM pools')!.n,0);
 }finally{await f.close();}
});

test('manual credit/debit has its own admin navigation and clear member action, but admin accounts only show history',()=>{
 assert.match(adminFrame('balances',''),/data-id="balances"[^>]*>[\s\S]*?人工加扣點/);
 const d={items:[{id:'player',name:'P',email:'p@example.test',role:'player',points:0,created_at:1},{id:'admin',name:'A',email:'a@example.test',role:'admin',points:0,created_at:1}],total:2,page:1,pageCount:1};
 const view=membersView(d,false,'','','admin',true,true);
 assert.match(view,/<h2>人工加扣點<\/h2>/);
 assert.match(view,/data-action="admin-balance" data-id="player"[^>]*>加點／扣點/);
 assert.match(view,/data-action="admin-balance" data-id="admin"[^>]*>查看調點紀錄/);
 assert.doesNotMatch(view,/調點／紀錄/);
});
