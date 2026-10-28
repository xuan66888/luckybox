import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { readConfig, type Config } from '../src/config.js';
import { passwordHash } from '../src/auth.js';
import assert from 'node:assert/strict';
export const testPassword = 'Automated-test-only-password-123!';
const hash = passwordHash(testPassword);
export async function fixture(overrides: Partial<Config> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'luckybox-test-'));
  const config = { ...readConfig({ NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_ORIGIN:'http://localhost:3000' }), paidDraws:true, manualTopups:true, holdHours:0, ...overrides };
  const store = new Store(config.dbFile); store.migrate(path.resolve('migrations'));
  const ids: Record<string,string> = {};
  for (const [name, role] of [['admin','admin'],['creator','creator'],['player','player'],['other','player']]) {
    const id = randomUUID(); ids[name] = id;
    store.run('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',id,`${name}@example.test`,name,await hash,role,Date.now());
    store.tx(() => store.balance(id,10000,'test_fixture',id));
  }
  const app = createApp(store,config,path.resolve('dist/public'));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  const origin = `http://127.0.0.1:${address.port}`; config.origin = origin;
  function client() {
    let cookie = '', csrf = '';
    return {
      async request(url: string, body?: any, options: { key?: string; origin?: string; csrf?: string; contentType?: string; raw?: BodyInit; method?: string } = {}) {
        const res = await fetch(origin + url,{ method:options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),headers:{Cookie:cookie,Origin:options.origin ?? origin,'X-CSRF-Token':options.csrf ?? csrf,'Idempotency-Key':options.key ?? randomUUID(),...(body !== undefined || options.raw !== undefined ? {'Content-Type':options.contentType ?? 'application/json'} : {})},body:options.raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
        const setCookie = res.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
        const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
        if (data.csrf) csrf = data.csrf;
        return {status:res.status,data,headers:res.headers};
      },
      async login(name: string) { const result = await this.request('/api/auth/login',{email:`${name}@example.test`,password:testPassword}); assert.equal(result.status,200,JSON.stringify(result.data)); return result; }
    };
  }
  const admin = client(), creator = client(), player = client(), other = client();
  await admin.login('admin'); await creator.login('creator'); await player.login('player'); await other.login('other');
  return {store,config,ids,admin,creator,player,other,client,origin,directory,
    async close() { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); app.locals.demoStore?.close(); store.close(); assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(),'luckybox-test-'))); rmSync(directory,{recursive:true,force:true}); }
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const physicalPool = (quantity = 1) => ({ name:'收藏測試池',description:'真實資料庫測試',cover:'',descriptionImages:[],kind:'paid',price:100,prizes:[{name:'收藏卡',kind:'physical',value:500,redeemPoints:50,quantity,image:''}] });
export async function livePool(f: Fixture, data: any = physicalPool()) {
  let result = await f.creator.request('/api/pools',data); assert.equal(result.status,200,JSON.stringify(result.data)); const id = result.data.id;
  result = await f.creator.request(`/api/pools/${id}/submit`,{}); assert.equal(result.status,200,JSON.stringify(result.data));
  result = await f.admin.request(`/api/admin/pools/${id}/review`,{approve:true,note:'測試核實庫存'}); assert.equal(result.status,200,JSON.stringify(result.data));
  result = await f.creator.request(`/api/pools/${id}/open`,{}); assert.equal(result.status,200,JSON.stringify(result.data)); return id as string;
}
