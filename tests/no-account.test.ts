import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {authFields,mfaField} from '../src/auth-view.js';
import {fixture,testPassword,livePool,physicalPool} from './helpers.js';
import {defaultCampaign} from '../src/community.js';
import {totp} from '../src/identity.js';
const execute=promisify(execFile);

test('member login never shows administrator code, and MFA only appears after a valid-password challenge',async()=>{
  assert.ok(!authFields('member-login').includes('name="otp"'));
  assert.ok(!authFields('admin-login').includes('name="otp"'));
  assert.ok(authFields('register').includes('name="confirmPassword"'));
  assert.ok(mfaField().includes('name="otp"')&&mfaField().includes('required'));
  const f=await fixture();try{
    f.config.identity.authSecret='ac'.repeat(32);
    const setup=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});
    const enabled=await f.admin.request('/api/admin/mfa/enable',{code:totp(setup.data.secret)});assert.equal(enabled.status,200);
    const body={email:'admin@example.test',password:testPassword};
    const missing=await f.client().request('/api/auth/admin-login',body);
    assert.equal(missing.status,401);assert.equal(missing.data.code,'MFA_REQUIRED');assert.ok(!missing.data.csrf);
    const bad=await f.client().request('/api/auth/admin-login',{...body,password:'wrong-password'});
    assert.equal(bad.status,401);assert.equal(bad.data.code,undefined);
    const ok=await f.client().request('/api/auth/admin-login',{...body,otp:enabled.data.recoveryCodes[0]});assert.equal(ok.status,200);
    assert.equal((await f.client().request('/api/auth/admin-login',{...body,otp:enabled.data.recoveryCodes[0]})).status,401);
  }finally{await f.close();}
});

test('provider-free signup/login/logout preserves unverified status, zero gifts, privacy and admin separation',async()=>{
  const f=await fixture({paidDraws:false,manualTopups:false,devPoints:0});try{
    const c=f.client();const data={email:' NewUser@Example.Test ',name:'新註冊驗收',password:testPassword};
    const created=await c.request('/api/auth/register',data);assert.equal(created.status,201);assert.equal(created.data.user.points,0);assert.equal(created.data.user.role,'player');
    const security=await c.request('/api/me/security');assert.equal(security.data.emailVerified,false);assert.equal(security.data.phoneVerified,false);
    assert.equal((await c.request('/api/admin/dashboard')).status,403);
    assert.equal((await c.request('/api/auth/logout',{})).status,200);assert.equal((await c.request('/api/me/community')).status,401);
    assert.equal((await c.request('/api/auth/login',{email:' NEWUSER@EXAMPLE.TEST ',password:testPassword})).status,200);
    assert.equal((await f.client().request('/api/auth/register',{...data,email:'newuser@example.test'})).status,409);
    assert.equal((await f.client().request('/api/auth/register',{...data,email:'weak@example.test',password:'short'})).status,400);
    const member=await c.request('/api/me/community');assert.equal(member.status,200);assert.equal(member.data.vip.netPaid,0);assert.equal(member.data.tasks.length,4);
    assert.equal((await c.request('/api/me/tasks/claim',{task:'daily_visit'})).status,503);
    f.config.registration=false;assert.equal((await f.client().request('/api/auth/register',{...data,email:'closed@example.test'})).status,403);
  }finally{await f.close();}
});

test('provider-free sandbox completes free draw, mission reward, notification and duplicate-claim protection',async()=>{
  const f=await fixture({devPoints:0});try{
    const client=f.client();assert.equal((await client.request('/api/auth/register',{email:'task@example.test',name:'任務驗收',password:testPassword})).status,201);
    const c=structuredClone(defaultCampaign);c.rewardsEnabled=true;c.dailyBudget=20;
    assert.equal((await f.admin.request('/api/admin/campaigns',{version:0,settings:c})).status,200);
    const id=await livePool(f,{...physicalPool(2),kind:'free',price:0});
    assert.equal((await client.request('/api/pools/'+id+'/draw',{quantity:1})).status,200);
    assert.equal((await client.request('/api/me/tasks/claim',{task:'first_draw'})).status,200);
    assert.equal((await client.request('/api/me/tasks/claim',{task:'first_draw'})).status,409);
    const community=(await client.request('/api/me/community')).data;assert.equal(community.notifications.length,1);assert.equal(community.tasks.find((t:any)=>t.id==='first_draw').claimed,true);
    assert.equal((await client.request('/api/auth/me')).data.user.points,10);
    const live=(await f.client().request('/api/community/live')).data;assert.equal(live.events.length,1);assert.ok(!JSON.stringify(live).includes('task@example.test'));
  }finally{await f.close();}
});

test('operations status stays admin-only; stale and corrupt records never claim success',async()=>{
  const f=await fixture();try{
    assert.equal((await f.client().request('/api/admin/operations')).status,401);
    assert.equal((await f.player.request('/api/admin/operations')).status,403);
    const folder=path.join(f.directory,'ops');mkdirSync(folder);
    writeFileSync(path.join(folder,'health.json'),JSON.stringify({ok:true,checkedAt:new Date(Date.now()-3600000).toISOString(),secret:'must-not-leak'}));
    writeFileSync(path.join(folder,'backup.json'),'{bad json');
    const status=await f.admin.request('/api/admin/operations');assert.equal(status.status,200);assert.equal(status.data.health.stale,true);assert.equal(status.data.backup.ok,false);assert.ok(!JSON.stringify(status.data).includes('must-not-leak'));
  }finally{await f.close();}
});

test('scheduled operations exercise healthy, failed, recovered and verified backup states without providers',async()=>{
  const f=await fixture();try{
    const env={...process.env,DATA_DIR:f.directory,BACKUP_DIR:path.join(f.directory,'backups'),HEALTH_ORIGIN:f.origin};
    const call=(mode:string,overrides={})=>execute(process.execPath,['scripts/operations.mjs',mode],{env:{...env,...overrides},timeout:40000});
    assert.equal(JSON.parse((await call('health')).stdout).ok,true);
    await assert.rejects(call('health',{HEALTH_ORIGIN:'http://127.0.0.1:1'}));
    assert.equal(JSON.parse(readFileSync(path.join(f.directory,'ops','health.json'),'utf8')).ok,false);
    assert.equal(JSON.parse((await call('health')).stdout).consecutiveFailures,0);
    const backup=JSON.parse((await call('backup')).stdout);assert.equal(backup.ok,true);assert.equal(backup.restoreHashes,'match');assert.equal(backup.offHostCopyVerified,false);
    const status=(await f.admin.request('/api/admin/operations')).data;assert.equal(status.health.ok,true);assert.equal(status.backup.integrity,'ok');
  }finally{await f.close();}
});
