import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {SQLInputValue} from 'node:sqlite';
import {fixture,testPassword,type Fixture} from './helpers.js';
import {passwordHash,passwordMatches} from '../src/auth.js';
import {totp} from '../src/identity.js';

// Deterministically execute a concurrent administrative change after the credential
// snapshot is read but before async scrypt returns. Requests still use real HTTP.
function duringRead(f:Fixture,sqlMatch:string,arg:string,change:()=>void){
 const one=f.store.one.bind(f.store);let used=false;
 f.store.one=(sql:string,...args:SQLInputValue[])=>{
  const row=one(sql,...args);
  if(!used&&sql===sqlMatch&&args[0]===arg){used=true;queueMicrotask(change);}
  return row;
 };
 return ()=>used;
}
const races=[
 ['member promotion','login','player',"role='admin'"],
 ['member disable','login','player','disabled=1'],
 ['member email change','login','player',"email='changed@example.test'"],
 ['member password change','login','player','password_hash=?'],
 ['admin demotion','admin-login','admin',"role='player'"],
 ['admin disable','admin-login','admin','disabled=1'],
 ['admin email change','admin-login','admin',"email='changed-admin@example.test'"],
 ['admin password change','admin-login','admin','password_hash=?']
] as const;
for(const[name,endpoint,member,update]of races)test('in-flight password login cannot survive '+name,async()=>{
 const f=await fixture();try{
  f.config.identity.adminMfaRequired=true;
  const newHash=update.includes('?')?await passwordHash('Changed-local-fixture-123!'):'';
  const fired=duringRead(f,'SELECT * FROM users WHERE email=?',member+'@example.test',()=>f.store.tx(()=>{
   f.store.run('UPDATE users SET '+update+' WHERE id=?',...(update.includes('?')?[newHash]:[]),f.ids[member]);
   f.store.run('DELETE FROM sessions WHERE user_id=?',f.ids[member]);
  }));
  const client=f.client(),r=await client.request('/api/auth/'+endpoint,{email:member+'@example.test',password:testPassword});
  assert.ok(fired());assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);
  assert.equal((await client.request('/api/admin/dashboard')).status,401);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM sessions WHERE user_id=?',f.ids[member])!.n,0);
 }finally{await f.close();}
});

test('fresh login returns current non-security profile and points without needless rejection',async()=>{
 const f=await fixture();try{
  const fired=duringRead(f,'SELECT * FROM users WHERE email=?','player@example.test',()=>{
   f.store.run("UPDATE users SET name='Updated fixture' WHERE id=?",f.ids.player);
   f.store.balance(f.ids.player,7,'test_fixture','concurrent-credit');
  });
  const r=await f.client().request('/api/auth/login',{email:'player@example.test',password:testPassword});
  assert.ok(fired());assert.equal(r.status,200);assert.equal(r.data.user.name,'Updated fixture');assert.equal(r.data.user.points,10007);
 }finally{await f.close();}
});

test('email change revokes old reset and pending OAuth links, but not another member links',async()=>{
 const f=await fixture();try{
  await f.client().request('/api/auth/forgot',{email:'player@example.test'});
  await f.client().request('/api/auth/forgot',{email:'other@example.test'});
  const token=readFileSync(path.join(f.directory,'dev-mail',f.ids.player+'.txt'),'utf8').split('/').at(-1)!;
  for(const user of ['player','other'])f.store.run('INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)',user,'browser','verifier','nonce',f.ids[user],'local-session',Date.now()+10000);
  assert.equal((await f.admin.request('/api/admin/members/'+f.ids.player+'/profile',{email:'renamed@example.test',name:'Renamed'})).status,200);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM resets WHERE user_id=?',f.ids.player)!.n,0);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_states WHERE user_id=?',f.ids.player)!.n,0);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM resets WHERE user_id=?',f.ids.other)!.n,1);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_states WHERE user_id=?',f.ids.other)!.n,1);
  assert.equal((await f.client().request('/api/auth/reset',{token,password:'Changed-only-fixture-123!'})).status,400);
  assert.ok(await passwordMatches(testPassword,f.store.one('SELECT password_hash FROM users WHERE id=?',f.ids.player)!.password_hash));
  assert.equal((await f.client().request('/api/auth/forgot',{email:'renamed@example.test'})).status,200);
  const next=readFileSync(path.join(f.directory,'dev-mail',f.ids.player+'.txt'),'utf8').split('/').at(-1)!;
  assert.notEqual(next,token);assert.equal((await f.client().request('/api/auth/reset',{token:next,password:testPassword})).status,200);
 }finally{await f.close();}
});

test('name-only profile edit keeps a valid account-bound reset usable once',async()=>{
 const f=await fixture();try{
  await f.client().request('/api/auth/forgot',{email:'player@example.test'});
  const token=readFileSync(path.join(f.directory,'dev-mail',f.ids.player+'.txt'),'utf8').split('/').at(-1)!;
  await f.admin.request('/api/admin/members/'+f.ids.player+'/profile',{email:'player@example.test',name:'New name only'});
  assert.equal((await f.client().request('/api/auth/reset',{token,password:testPassword})).status,200);
  assert.equal((await f.client().request('/api/auth/reset',{token,password:testPassword})).status,400);
 }finally{await f.close();}
});

test('permission revocation clears reset/OAuth grants, disabled-account legacy tokens cannot reset',async()=>{
 const f=await fixture();try{
  await f.client().request('/api/auth/forgot',{email:'player@example.test'});
  const token=readFileSync(path.join(f.directory,'dev-mail',f.ids.player+'.txt'),'utf8').split('/').at(-1)!;
  f.store.run('INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)','pending','browser','verifier','nonce',f.ids.player,'local-session',Date.now()+10000);
  assert.equal((await f.admin.request('/api/admin/users/'+f.ids.player,{role:'player',disabled:true})).status,200);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM resets WHERE user_id=?',f.ids.player)!.n,0);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_states WHERE user_id=?',f.ids.player)!.n,0);
  assert.equal((await f.client().request('/api/auth/reset',{token,password:testPassword})).status,400);
  await f.client().request('/api/auth/forgot',{email:'other@example.test'});
  const legacy=readFileSync(path.join(f.directory,'dev-mail',f.ids.other+'.txt'),'utf8').split('/').at(-1)!;
  f.store.run('UPDATE users SET disabled=1 WHERE id=?',f.ids.other);
  assert.equal((await f.client().request('/api/auth/reset',{token:legacy,password:'Changed-only-fixture-123!'})).status,400);
  assert.ok(await passwordMatches(testPassword,f.store.one('SELECT password_hash FROM users WHERE id=?',f.ids.other)!.password_hash));
 }finally{await f.close();}
});

test('in-flight MFA setup cannot survive logout, password replacement or role revocation',async()=>{
 for(const change of ['logout','password','role']){
  const f=await fixture();try{
   f.config.identity.authSecret='ab'.repeat(32);
   const nextHash=await passwordHash('Changed-only-fixture-123!');
   const fired=duringRead(f,'SELECT * FROM users WHERE id=?',f.ids.admin,()=>{
    if(change==='logout')f.store.run('DELETE FROM sessions WHERE user_id=?',f.ids.admin);
    else if(change==='password')f.store.run('UPDATE users SET password_hash=? WHERE id=?',nextHash,f.ids.admin);
    else f.store.run("UPDATE users SET role='player' WHERE id=?",f.ids.admin);
   });
   const r=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});
   assert.ok(fired());assert.equal(r.status,change==='logout'?403:401);assert.equal('secret'in r.data,false);
   assert.equal(f.store.one('SELECT COUNT(*) n FROM admin_mfa')!.n,0);
  }finally{await f.close();}
 }
});

test('logout during MFA disable preserves enrollment and unused recovery codes',async()=>{
 const f=await fixture();try{
  f.config.identity.authSecret='ab'.repeat(32);
  const setup=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});assert.equal(setup.status,200);
  const enabled=await f.admin.request('/api/admin/mfa/enable',{code:totp(setup.data.secret)});assert.equal(enabled.status,200);
  const before=f.store.one('SELECT * FROM admin_mfa WHERE user_id=?',f.ids.admin)!;
  const fired=duringRead(f,'SELECT * FROM users WHERE id=?',f.ids.admin,()=>f.store.run('DELETE FROM sessions WHERE user_id=?',f.ids.admin));
  assert.equal((await f.admin.request('/api/admin/mfa/disable',{password:testPassword,code:enabled.data.recoveryCodes[0]})).status,403);
  assert.ok(fired());assert.deepEqual(f.store.one('SELECT * FROM admin_mfa WHERE user_id=?',f.ids.admin),before);
 }finally{await f.close();}
});
