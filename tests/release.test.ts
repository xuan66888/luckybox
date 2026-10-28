import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture,physicalPool,livePool,testPassword } from './helpers.js';
import { defaultCampaign,qualifyReferral,vipState,paymentCommunity } from '../src/community.js';
import { totp } from '../src/identity.js';

test('every successful draw awards a prize; legacy no-win pools fail before charging',async()=>{
  const f=await fixture();try{
    const none={name:'未中獎',kind:'none',value:0,redeemPoints:0,quantity:2,image:''};
    assert.equal((await f.creator.request('/api/pools',{...physicalPool(),prizes:[none]})).status,400);
    const id=await livePool(f,physicalPool(5)),before=f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points;
    f.store.run("UPDATE prizes SET kind='none',value=0,redeem_points=0 WHERE pool_id=?",id);
    assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:1})).status,409);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,before);
    assert.equal(f.store.one('SELECT COUNT(*) n FROM draws WHERE pool_id=?',id)!.n,0);
    assert.ok(!(await f.client().request('/api/pools')).data.some((p:any)=>p.id===id));
    const wins=await livePool(f,{...physicalPool(2),prizes:[{name:'必得點數',kind:'points',value:10,redeemPoints:0,quantity:2,image:''}]});
    const result=await f.player.request('/api/pools/'+wins+'/draw',{quantity:2});assert.equal(result.status,200);assert.ok(result.data.results.every((r:any)=>r.kind==='points'));assert.equal(result.data.results.length,2);
  }finally{await f.close();}
});
test('local email tokens are account-bound, single-use and reset after admin changes email',async()=>{
  const f=await fixture();try{
    const sent=await f.player.request('/api/me/security/email/send',{});assert.equal(sent.status,200);assert.equal(sent.data.localOnly,true);
    const url=readFileSync(path.join(f.directory,'dev-mail',f.ids.player+'-verify.txt'),'utf8'),token=url.split('/').at(-1)!;
    assert.equal((await f.other.request('/api/me/security/email/confirm',{token})).status,400);
    assert.equal((await f.player.request('/api/me/security/email/confirm',{token})).status,200);
    assert.equal((await f.player.request('/api/me/security/email/confirm',{token})).status,400);
    assert.equal((await f.player.request('/api/me/security')).data.emailVerified,true);
    assert.equal((await f.admin.request('/api/admin/members/'+f.ids.player+'/profile',{email:'changed@example.test',name:'changed'})).status,200);
    assert.equal(f.store.one('SELECT email_verified_at FROM users WHERE id=?',f.ids.player)!.email_verified_at,null);
  }finally{await f.close();}
});
test('missing providers fail closed; Google starts PKCE with bound short-lived state, not embedded secrets',async()=>{
  const f=await fixture();try{
    assert.equal((await f.client().request('/api/auth/google/start',{})).status,503);
    assert.equal((await f.player.request('/api/me/security/phone/send',{phone:'+886912345678'})).status,503);
    f.config.identity.googleId='fixture-client-id';f.config.identity.googleSecret='fixture-only-secret';
    const start=await f.player.request('/api/auth/google/start',{link:true});assert.equal(start.status,200);
    const url=new URL(start.data.url);assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('nonce'));assert.ok(url.searchParams.get('code_challenge'));assert.ok(!JSON.stringify(start.data).includes('fixture-only-secret'));
    assert.equal(f.store.one('SELECT COUNT(*) n FROM oauth_states WHERE user_id=?',f.ids.player)!.n,1);
    const bad=await fetch(f.origin+'/auth/google/callback?state='+'0'.repeat(64)+'&code=bad',{redirect:'manual'});assert.equal(bad.status,303);assert.equal(bad.headers.get('location'),'/#google-error');
    assert.equal(f.store.one('SELECT COUNT(*) n FROM identities')!.n,0);
  }finally{await f.close();}
});
test('Twilio adapter confirms only a stored phone challenge and rejects duplicate phone ownership',async()=>{
  const f=await fixture(),original=globalThis.fetch;let calls=0;
  try{
    Object.assign(f.config.identity,{twilioSid:'AC'+'a'.repeat(32),twilioToken:'fixture',twilioService:'VA'+'b'.repeat(32)});
    globalThis.fetch=async(input,init)=>{if(String(input).startsWith('https://verify.twilio.com/')){calls++;const body=String(init!.body);assert.ok(body.includes('To=%2B886912345678'));return new Response(JSON.stringify({status:String(input).endsWith('VerificationCheck')?'approved':'pending'}),{headers:{'Content-Type':'application/json'}});}return original(input,init);};
    assert.equal((await f.player.request('/api/me/security/phone/confirm',{code:'123456'})).status,400);
    assert.equal((await f.player.request('/api/me/security/phone/send',{phone:'+886912345678'})).status,200);
    assert.equal((await f.player.request('/api/me/security/phone/confirm',{code:'123456'})).status,200);
    assert.equal((await f.player.request('/api/me/security')).data.phoneVerified,true);
    assert.equal((await f.other.request('/api/me/security/phone/send',{phone:'+886912345678'})).status,409);assert.equal(calls,2);
  }finally{globalThis.fetch=original;await f.close();}
});
test('Turnstile checks server action/hostname and rejects missing/incorrect tokens',async()=>{
  const f=await fixture(),original=globalThis.fetch;let hostname='evil.example',action='register';
  try{
    Object.assign(f.config.identity,{turnstileSite:'fixture-site',turnstileSecret:'fixture-secret'});
    globalThis.fetch=async(input,init)=>String(input).startsWith('https://challenges.cloudflare.com/')?new Response(JSON.stringify({success:true,hostname,action}),{headers:{'Content-Type':'application/json'}}):original(input,init);
    const body={email:'captcha@example.test',name:'captcha',password:testPassword};
    assert.equal((await f.client().request('/api/auth/register',body)).status,400);
    assert.equal((await f.client().request('/api/auth/register',{...body,captchaToken:'token'})).status,400);
    hostname=new URL(f.origin).hostname;action='login';assert.equal((await f.client().request('/api/auth/register',{...body,captchaToken:'token'})).status,400);
    action='register';assert.equal((await f.client().request('/api/auth/register',{...body,captchaToken:'token'})).status,201);
  }finally{globalThis.fetch=original;await f.close();}
});
test('admin MFA encrypts secrets, rejects replay and gates both login routes with single-use recovery',async()=>{
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',1),'287082');
  const f=await fixture();try{
    f.config.identity.authSecret='ab'.repeat(32);
    const setup=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});assert.equal(setup.status,200);
    assert.ok(!f.store.one('SELECT secret FROM admin_mfa WHERE user_id=?',f.ids.admin)!.secret.includes(setup.data.secret));
    const code=totp(setup.data.secret),enabled=await f.admin.request('/api/admin/mfa/enable',{code});assert.equal(enabled.status,200);assert.equal(enabled.data.recoveryCodes.length,8);
    const login={email:'admin@example.test',password:testPassword};
    assert.equal((await f.client().request('/api/auth/admin-login',login)).status,401);
    assert.equal((await f.client().request('/api/auth/login',{...login,otp:code})).status,401);
    const recovery=enabled.data.recoveryCodes[0];assert.equal((await f.client().request('/api/auth/admin-login',{...login,otp:recovery})).status,200);
    assert.equal((await f.client().request('/api/auth/login',{...login,otp:recovery})).status,401);
  }finally{await f.close();}
});
test('campaigns require admin and version match; task conditions, once-only claims and daily budget enforced',async()=>{
  const f=await fixture();try{
    assert.equal((await f.player.request('/api/admin/campaigns')).status,403);
    const c=structuredClone(defaultCampaign);assert.equal((await f.player.request('/api/me/tasks/claim',{task:'daily_visit'})).status,503);
    c.rewardsEnabled=true;c.dailyBudget=1;
    assert.equal((await f.admin.request('/api/admin/campaigns',{version:0,settings:c})).status,200);
    assert.equal((await f.admin.request('/api/admin/campaigns',{version:0,settings:c})).status,409);
    assert.equal((await f.player.request('/api/me/tasks/claim',{task:'first_draw'})).status,409);
    const key=randomUUID(),claim=await f.player.request('/api/me/tasks/claim',{task:'daily_visit'},{key});assert.equal(claim.status,200);
    assert.deepEqual((await f.player.request('/api/me/tasks/claim',{task:'daily_visit'},{key})).data,claim.data);
    assert.equal((await f.player.request('/api/me/tasks/claim',{task:'daily_visit'})).status,409);
    assert.equal((await f.other.request('/api/me/tasks/claim',{task:'daily_visit'})).status,409);
    assert.equal(f.store.one("SELECT SUM(delta) total FROM ledger WHERE kind='community_reward'")!.total,1);
    assert.equal((await f.player.request('/api/me/community')).data.notifications.length,1);
  }finally{await f.close();}
});
test('VIP excludes stage and completed refunds; invitation rewards need verified first real payment and do not duplicate',async()=>{
  const f=await fixture();try{
    const c=structuredClone(defaultCampaign);c.rewardsEnabled=true;c.referral.enabled=true;
    assert.equal((await f.admin.request('/api/admin/campaigns',{version:0,settings:c})).status,200);
    const code=(await f.player.request('/api/me/community')).data.code;
    assert.equal((await f.player.request('/api/me/referral',{code})).status,400);
    assert.equal((await f.other.request('/api/me/referral',{code})).status,200);
    assert.equal((await f.other.request('/api/me/referral',{code})).status,409);
    const insert=(id:string,mode:string,amount:number)=>f.store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,created_at,paid_at,trade_no) VALUES(?,?,?,?,?,?,'paid',?,?,?)",id,f.ids.other,'fixture',mode,amount,amount,Date.now(),Date.now(),id);
    insert('stageFixture','stage',5000);f.store.tx(()=>paymentCommunity(f.store,f.ids.other,'stage'));assert.equal(vipState(f.store,f.ids.other).netPaid,0);
    insert('realFixture','production',1000);f.store.tx(()=>qualifyReferral(f.store,f.ids.other));assert.equal(f.store.one('SELECT rewarded_at FROM referrals WHERE invitee_id=?',f.ids.other)!.rewarded_at,null);
    f.store.run('UPDATE users SET email_verified_at=?,phone_verified_at=?,phone=? WHERE id=?',Date.now(),Date.now(),'+886900000001',f.ids.player);f.store.run('UPDATE users SET email_verified_at=?,phone_verified_at=?,phone=? WHERE id=?',Date.now(),Date.now(),'+886900000002',f.ids.other);
    f.store.tx(()=>qualifyReferral(f.store,f.ids.other));f.store.tx(()=>qualifyReferral(f.store,f.ids.other));
    assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE kind='community_reward'")!.n,2);assert.equal(vipState(f.store,f.ids.other).tier.threshold,1000);
    assert.equal((await f.client().request('/api/community/live')).data.events.length,0);
    const pool=await livePool(f,physicalPool(2));assert.equal((await f.player.request('/api/pools/'+pool+'/draw',{quantity:1})).status,200);
    const live=(await f.client().request('/api/community/live')).data;assert.equal(live.events.length,1);assert.equal(live.events[0].name,'p＊＊');assert.ok(!JSON.stringify(live).includes('player@example'));
  }finally{await f.close();}
});
test('manual refund register never pretends to call provider; restores VIP and debits only unspent payment once',async()=>{
  const f=await fixture();try{
    const order='refundFixture';f.store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,created_at,paid_at,trade_no) VALUES(?,?,?,'production',1000,1000,'paid',?,?,?)",order,f.ids.player,'fixture',Date.now(),Date.now(),order);
    f.store.tx(()=>f.store.balance(f.ids.player,1000,'ecpay_topup',order));assert.equal(vipState(f.store,f.ids.player).netPaid,1000);
    const r=await f.player.request('/api/me/refunds',{orderNo:order,reason:'測試全額退款流程'});assert.equal(r.status,200);
    assert.equal((await f.admin.request('/api/admin/refunds/'+r.data.id+'/review',{approve:true,providerReference:''})).status,410);
    assert.equal((await f.admin.request('/api/admin/refunds/'+r.data.id+'/transition',{action:'prepare',expectedVersion:0,note:'隔離測試已核對支付資格',password:testPassword,providerEligibilityReviewed:true})).status,200);
    const key=randomUUID(),body={action:'complete',expectedVersion:1,note:'隔離測試確認退款紀錄',password:testPassword,providerAmount:1000,providerOutcome:'confirmed_refunded',providerReference:'FIXTURE-REFUND-ONLY'};
    assert.equal((await f.admin.request('/api/admin/refunds/'+r.data.id+'/transition',body,{key})).status,200);
    assert.equal((await f.admin.request('/api/admin/refunds/'+r.data.id+'/transition',body,{key})).status,200);
    assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE kind='payment_refund'")!.n,1);assert.equal(vipState(f.store,f.ids.player).netPaid,0);
  }finally{await f.close();}
});
test('concurrent weighted draws never oversell, duplicate collectible or charge rejected attempts',async()=>{
  const f=await fixture();try{
    const id=await livePool(f,physicalPool(20)),p=(await f.creator.request('/api/pools/'+id)).data;
    assert.equal((await f.admin.request('/api/admin/pools/'+id+'/odds',{expectedVersion:0,prizes:[{id:p.prizes[0].id,probabilityBps:10000}]})).status,200);
    const results=await Promise.all(Array.from({length:50},()=>f.player.request('/api/pools/'+id+'/draw',{quantity:1,oddsVersion:1})));
    assert.equal(results.filter(r=>r.status===200).length,20);assert.equal(results.filter(r=>r.status===409).length,30);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,8000);assert.equal(f.store.one('SELECT remaining FROM prizes WHERE pool_id=?',id)!.remaining,0);
    assert.equal(f.store.one('SELECT COUNT(*) n FROM draws WHERE pool_id=?',id)!.n,20);assert.equal((await f.player.request('/api/me/collection')).data.length,20);
  }finally{await f.close();}
});
test('dashboard stock excludes canceled pools rather than inflating inventory with historical demos',async()=>{
  const f=await fixture();try{const id=(await f.creator.request('/api/pools',physicalPool(4))).data.id;
    assert.equal((await f.admin.request('/api/admin/dashboard')).data.stats.physicalStock,4);
    assert.equal((await f.admin.request('/api/admin/pools/'+id+'/cancel',{note:'保留歷史但排除可用庫存'})).status,200);
    assert.equal((await f.admin.request('/api/admin/dashboard')).data.stats.physicalStock,0);
  }finally{await f.close();}
});
