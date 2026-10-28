import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fixture} from './helpers.js';
import {readConfig} from '../src/config.js';
import {createApp} from '../src/app.js';

test('retired demo links go to the main site and cannot receive old mock payments',async()=>{
 const f=await fixture({demoEnabled:true});try{
  for(const route of ['/demo','/demo/','/demo/api/config']){const r=await fetch(f.origin+route,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/');assert.match(r.headers.get('set-cookie')!,/lb_demo_session=;/);assert.match(r.headers.get('set-cookie')!,/Path=\/demo/);}
  assert.equal((await f.client().request('/demo/api/demo/orders',{amount:1000})).status,410);
  assert.equal((await f.player.request('/api/demo/orders',{amount:1000})).status,404);
  const c=(await f.client().request('/api/config')).data;assert.equal(c.demo,false);assert.equal(c.demoAvailable,false);
  assert.equal(existsSync(path.join(f.directory,'demo')),false);
  assert.equal((await f.admin.request('/api/admin/dashboard')).status,200);
 }finally{await f.close();}
});
test('legacy demo environment cannot start a separate service',()=>{
 assert.equal(readConfig({DEMO_ENABLED:'true'}).demoEnabled,false);
 assert.throws(()=>readConfig({DEMO_MODE:'true',APP_BASE_PATH:'/demo'}),/retired/);
});
test('explicit legacy runtime override is rejected without changing main database',async()=>{
 const f=await fixture();try{
  assert.throws(()=>createApp(f.store,{...f.config,demoMode:true,basePath:'/demo'},path.resolve('dist/public')),/retired/);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM users')!.n,4);
  assert.equal(f.store.one('SELECT SUM(points) n FROM users')!.n,40000);
 }finally{await f.close();}
});
