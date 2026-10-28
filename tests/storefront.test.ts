import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {SQLInputValue} from 'node:sqlite';
import {OAuth2Client} from 'google-auth-library';
import {fixture,testPassword,physicalPool,type Fixture} from './helpers.js';
import {emptyStorefront,storefrontState,storefrontReady} from '../src/storefront-data.js';
import {publicInformationView,policyConsentView,storefrontAdminView} from '../src/storefront-view.js';
import {memberPage,needsMemberLogin,informationSection,informationVersion} from '../src/navigation.js';
import {authFields} from '../src/auth-view.js';

const content={...emptyStorefront,businessName:'隔離商店（不營運）',supportEmail:'support@example.test',supportHours:'僅本機驗收',shippingRegions:'隔離測試範圍',shippingSchedule:'此為測試，沒有配送',shippingFee:'此為測試，不收運費',terms:'隔離測試正文，不是對外使用條款。',privacy:'隔離測試正文，不蒐集真實客戶資料。',returns:'隔離測試正文，不代表實際退換貨承諾。'};
async function save(f:Fixture,body=content){const s=storefrontState(f.store);const r=await f.admin.request('/api/admin/storefront/draft',{expectedVersion:s.version,content:body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.version as number;}
async function publish(f:Fixture){const version=storefrontState(f.store).version;const r=await f.admin.request('/api/admin/storefront/publication',{expectedVersion:version,action:'publish',confirmed:true,operatorReviewed:true,password:testPassword});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.version as number;}

test('public storefront is empty until explicit publish; drafts and admin identifiers never leak',async()=>{
 const f=await fixture();try{
  const anonymous=f.client();assert.equal((await anonymous.request('/api/admin/storefront')).status,401);assert.equal((await f.player.request('/api/admin/storefront')).status,403);
  assert.deepEqual((await anonymous.request('/api/storefront')).data,{published:false,version:null,content:null,contentHash:null,publishedAt:null});
  const draft=await f.admin.request('/api/admin/storefront');assert.equal(draft.status,200);assert.deepEqual(draft.data.draft,emptyStorefront);assert.equal(draft.data.issues.length,9);
  await save(f,{...content,businessName:'PRIVATE DRAFT ONLY'});
  assert.equal((await anonymous.request('/api/storefront')).data.published,false);
  assert.ok(!JSON.stringify((await anonymous.request('/api/storefront')).data).includes('PRIVATE DRAFT ONLY'));
  assert.equal((await anonymous.request('/api/storefront/versions/1')).status,404);
 }finally{await f.close();}
});

test('draft writes require admin, Origin, CSRF, exact schema and optimistic version; retries do not overwrite',async()=>{
 const f=await fixture();try{
  const body={expectedVersion:0,content};
  assert.equal((await f.player.request('/api/admin/storefront/draft',body)).status,403);
  assert.equal((await f.admin.request('/api/admin/storefront/draft',body,{origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.admin.request('/api/admin/storefront/draft',body,{csrf:'wrong'})).status,403);
  assert.equal((await f.admin.request('/api/admin/storefront/draft',{...body,content:{...content,unknown:'extra'}})).status,400);
  assert.equal((await f.admin.request('/api/admin/storefront/draft',{...body,content:{...content,terms:'x'.repeat(12001)}})).status,400);
  const key=randomUUID(),a=await f.admin.request('/api/admin/storefront/draft',body,{key});assert.equal(a.status,200);
  assert.deepEqual((await f.admin.request('/api/admin/storefront/draft',body,{key})).data,a.data);
  assert.equal((await f.admin.request('/api/admin/storefront/draft',{...body,content:{...content,businessName:'stale'}})).status,409);
  assert.equal(storefrontState(f.store).draft.businessName,content.businessName);assert.equal(storefrontReady(f.store),false);
 }finally{await f.close();}
});

test('publication rejects incomplete content, missing confirmation and wrong reauthentication without creating a version',async()=>{
 const f=await fixture();try{
  await save(f,{...content,privacy:''});
  const body={expectedVersion:1,action:'publish',confirmed:true,operatorReviewed:true,password:testPassword};
  assert.equal((await f.admin.request('/api/admin/storefront/publication',{...body,confirmed:false})).status,400);
  assert.equal((await f.admin.request('/api/admin/storefront/publication',{...body,password:'wrong-password'})).status,401);
  assert.equal((await f.admin.request('/api/admin/storefront/publication',body)).status,400);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM storefront_publications')!.n,0);
  await save(f);const current={...body,expectedVersion:2};
  assert.equal((await f.admin.request('/api/admin/storefront/publication',{...current,operatorReviewed:undefined})).status,400);
  assert.equal(storefrontState(f.store).published,null);
 }finally{await f.close();}
});

test('publish snapshots are immutable; edits remain private until republished, withdrawn versions remain explicitly historical',async()=>{
 const f=await fixture();try{
  await save(f);const first=await publish(f),p=(await f.client().request('/api/storefront')).data;assert.equal(first,2);assert.equal(p.content.businessName,content.businessName);assert.ok(p.contentHash);assert.equal('published_by'in p,false);assert.equal('draft'in p,false);
  await save(f,{...content,businessName:'Changed private draft'});assert.equal((await f.client().request('/api/storefront')).data.content.businessName,content.businessName);
  const second=await publish(f);assert.equal(second,4);
  const old=(await f.client().request('/api/storefront/versions/'+first)).data;assert.equal(old.archived,true);assert.equal(old.contentHash,p.contentHash);
  assert.throws(()=>f.store.run("UPDATE storefront_publications SET content='x'"),/append-only/);assert.throws(()=>f.store.run('DELETE FROM storefront_publications'),/append-only/);
  const off=await f.admin.request('/api/admin/storefront/publication',{expectedVersion:second,action:'withdraw',confirmed:true,password:testPassword});assert.equal(off.status,200);
  assert.equal((await f.client().request('/api/storefront')).data.published,false);assert.equal((await f.client().request('/api/storefront/versions/'+second)).data.archived,true);
  assert.equal((await f.client().request('/api/storefront/versions/0')).status,400);
  assert.equal(storefrontReady(f.store),false);
 }finally{await f.close();}
});

test('logout during publication password verification cannot publish or consume a stale administrative session',async()=>{
 const f=await fixture();try{
  await save(f);const one=f.store.one.bind(f.store);let fired=false;
  f.store.one=(sql:string,...args:SQLInputValue[])=>{const row=one(sql,...args);if(!fired&&sql==='SELECT * FROM users WHERE id=?'&&args[0]===f.ids.admin){fired=true;queueMicrotask(()=>f.store.run('DELETE FROM sessions WHERE user_id=?',f.ids.admin));}return row;};
  const r=await f.admin.request('/api/admin/storefront/publication',{expectedVersion:1,action:'publish',confirmed:true,operatorReviewed:true,password:testPassword});
  assert.ok(fired);assert.equal(r.status,403);assert.equal(storefrontState(f.store).published,null);assert.equal(f.store.one('SELECT COUNT(*) n FROM storefront_publications')!.n,0);
 }finally{await f.close();}
});

test('registration with published policies requires explicit matching consent and records immutable server version/hash atomically',async()=>{
 const f=await fixture();try{
  await save(f);const version=await publish(f),body={email:'policy-member@example.test',name:'隔離會員',password:testPassword};
  assert.equal((await f.client().request('/api/auth/register',body)).status,400);
  assert.equal((await f.client().request('/api/auth/register',{...body,acceptedPolicies:false,storefrontVersion:version})).status,400);
  assert.equal((await f.client().request('/api/auth/register',{...body,acceptedPolicies:true,storefrontVersion:version+1})).status,409);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM users WHERE email=?',body.email)!.n,0);
  const keyBody={...body,acceptedPolicies:true,storefrontVersion:version},r=await f.client().request('/api/auth/register',keyBody);assert.equal(r.status,201);
  const row=f.store.one('SELECT * FROM user_policy_consents WHERE user_id=?',r.data.user.id)!;assert.equal(row.publication_version,version);assert.equal(row.content_hash,storefrontState(f.store).published!.contentHash);assert.equal(r.data.user.points,0);
  assert.throws(()=>f.store.run('DELETE FROM user_policy_consents'),/append-only/);
  await save(f,{...content,terms:'更新的隔離測試正文'});await publish(f);
  assert.equal((await f.client().request('/api/auth/register',{...keyBody,email:'stale-policy@example.test'})).status,409);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM users WHERE email=?','stale-policy@example.test')!.n,0);
 }finally{await f.close();}
});

test('Google signup state carries consent, rejects changed versions and records only a successful new-account consent',async()=>{
 const f=await fixture(),oldToken=OAuth2Client.prototype.getToken,oldVerify=OAuth2Client.prototype.verifyIdToken;let nonce='';let externalAttempts=0;const original=globalThis.fetch;
 try{
  await save(f);const first=await publish(f);Object.assign(f.config.identity,{googleId:'fixture-client',googleSecret:'fixture-only'});
  OAuth2Client.prototype.getToken=(async()=>({tokens:{id_token:'local-fixture-only'}})) as any;
  OAuth2Client.prototype.verifyIdToken=(async()=>({getPayload:()=>({sub:'local-google-subject',email:'google-new@example.test',email_verified:true,nonce})})) as any;
  globalThis.fetch=(input,init)=>{if(!String(input).startsWith(f.origin+'/')){externalAttempts++;throw Error('Unexpected provider network');}return original(input,init);};
  assert.equal((await f.client().request('/api/auth/google/start',{})).status,400);
  async function start(version:number){const r=await f.client().request('/api/auth/google/start',{acceptedPolicies:true,storefrontVersion:version});assert.equal(r.status,200);nonce=f.store.one('SELECT nonce FROM oauth_states ORDER BY rowid DESC LIMIT 1')!.nonce;return{state:new URL(r.data.url).searchParams.get('state')!,cookie:r.headers.get('set-cookie')!.split(';')[0]};}
  const old=await start(first);assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_policy_intents')!.n,1);
  await save(f,{...content,privacy:'更新的隔離隱私測試正文'});const current=await publish(f);
  let callback=await fetch(f.origin+'/auth/google/callback?state='+old.state+'&code=fixture',{headers:{Cookie:old.cookie},redirect:'manual'});
  assert.equal(callback.headers.get('location'),'/#google-error');assert.equal(f.store.one('SELECT COUNT(*) n FROM users WHERE email=?','google-new@example.test')!.n,0);
  const next=await start(current);callback=await fetch(f.origin+'/auth/google/callback?state='+next.state+'&code=fixture',{headers:{Cookie:next.cookie},redirect:'manual'});assert.equal(callback.headers.get('location'),'/auth/complete');
  const user=f.store.one('SELECT id FROM users WHERE email=?','google-new@example.test')!;assert.equal(f.store.one('SELECT publication_version FROM user_policy_consents WHERE user_id=?',user.id)!.publication_version,current);
  assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_policy_intents')!.n,0);assert.equal(externalAttempts,0);
 }finally{globalThis.fetch=original;OAuth2Client.prototype.getToken=oldToken;OAuth2Client.prototype.verifyIdToken=oldVerify;await f.close();}
});

test('production checkout/open/draw fail before charging without public information; withdrawing requires commerce to be closed',async()=>{
 const f=await fixture({production:true,paidDraws:true,ecpay:{enabled:true,mode:'production',merchantId:'1234567',hashKey:'LOCAL-ONLY-KEY-123',hashIV:'LOCAL-ONLY-IV-123',liveApproved:true}});try{
  const id=(await f.creator.request('/api/pools',physicalPool(2))).data.id;
  await f.creator.request('/api/pools/'+id+'/submit',{});await f.admin.request('/api/admin/pools/'+id+'/review',{approve:true,note:'隔離核對'});
  assert.equal((await f.creator.request('/api/pools/'+id+'/open',{})).status,503);
  f.store.run("UPDATE pools SET status='live' WHERE id=?",id);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1})).status,503);
  f.store.run('UPDATE users SET email_verified_at=?,phone_verified_at=? WHERE id=?',Date.now(),Date.now(),f.ids.player);
  Object.assign(f.config.identity,{turnstileSite:'fixture-site',turnstileSecret:'fixture-secret'});
  assert.equal((await f.player.request('/api/payments/ecpay',{amount:100})).status,503);assert.equal(f.store.one('SELECT COUNT(*) n FROM payment_orders')!.n,0);assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
  await save(f);const version=await publish(f);
  assert.equal((await f.player.request('/api/payments/ecpay',{amount:100})).status,200);
  assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1})).status,200);
  assert.equal((await f.admin.request('/api/admin/storefront/publication',{expectedVersion:version,action:'withdraw',confirmed:true,password:testPassword})).status,409);
  f.config.ecpay.enabled=false;f.config.paidDraws=false;
  assert.equal((await f.admin.request('/api/admin/storefront/publication',{expectedVersion:version,action:'withdraw',confirmed:true,password:testPassword})).status,200);
 }finally{await f.close();}
});

test('information routes are public, bounded, whitelist-only and distinguish archived versions',()=>{
 for(const section of ['contact','shipping','terms','privacy','returns']){assert.equal(memberPage('#info/'+section),'info');assert.equal(memberPage('#info/'+section+'/2'),'info');assert.equal(informationSection('#info/'+section),section);assert.equal(informationVersion('#info/'+section+'/2'),2);}
 assert.equal(needsMemberLogin('info',false),false);
 for(const hash of ['#info/admin','#info/terms/0','#info/terms/-1','#info/terms/2147483648','#info/contact?x=1','#info/terms/2/extra','#info/<script>'])assert.equal(memberPage(hash),'home');
});

test('public/editor/consent views escape content and do not invent business details, defaults or checked agreements',()=>{
 const empty=publicInformationView({published:false,content:null},'contact');assert.ok(empty.includes('營運資訊尚未公布'));assert.ok(!empty.includes('support@example.test'));
 const html=publicInformationView({published:true,version:2,publishedAt:Date.now(),content:{...content,terms:'<script>alert(1)</script>'}},'terms');assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 const consent=policyConsentView(2);assert.ok(consent.includes('/#info/terms/2'));assert.ok(consent.includes('target="_blank"'));assert.ok(consent.includes('name="acceptedPolicies" required'));assert.ok(!consent.includes(' checked'));assert.equal(policyConsentView(), '');assert.ok(authFields('register',2).includes('acceptedPolicies'));assert.ok(!authFields('member-login',2).includes('acceptedPolicies'));
 const editor=storefrontAdminView({draft:emptyStorefront,issues:['businessName'],version:0,published:null,hasUnpublishedChanges:true});assert.ok(editor.includes('儲存草稿（不公開）'));assert.ok(editor.includes('storefront-publish" disabled'));assert.ok(!editor.includes('support@example.test'));
});
