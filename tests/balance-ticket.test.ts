import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,livePool,physicalPool,testPassword} from './helpers.js';
import {sha256} from '../src/fairness.js';
import {totp} from '../src/identity.js';
import {homeView} from '../src/visual.js';
import {ticketSelectionView,paperTicketView,peelProgress} from '../src/paper-ticket.js';
const input={direction:'credit',amount:100,expectedBalance:10000,reason:'測試系統故障補點',reference:'LOCAL-ONLY',password:testPassword};
test('upcoming previews are public whitelisted names and credited physical product photographs, never live inventory or private fields',async()=>{
 const f=await fixture();try{assert.deepEqual((await f.client().request('/api/catalog/upcoming')).data.items,[]);await f.admin.request('/api/admin/catalog/starter-drafts',{});
 const r=await f.client().request('/api/catalog/upcoming');assert.equal(r.status,200);assert.equal(r.data.items.length,3);assert.ok(r.data.items.every((p:any)=>p.drawEnabled===false&&p.status==='coming_soon'&&p.image.endsWith('.svg')));
 assert.ok(r.data.items.every((p:any)=>Object.keys(p).sort().join(',')==='code,drawEnabled,image,name,photoCredit,photoSource,status'));
 assert.equal((await f.client().request('/api/pools')).data.length,0);assert.equal(f.store.one('SELECT SUM(remaining) n FROM pools')!.n,0);
 const html=homeView([],{user:null,page:'home',registration:true},r.data.items);assert.match(html,/實體商品參考照片/);assert.doesNotMatch(html,/概念示意/);assert.equal((html.match(/>查看商品</g)||[]).length,3);
 assert.equal((await f.player.request('/api/pools/'+(await f.admin.request('/api/admin/catalog')).data.items[0].id+'/draw',{quantity:1,oddsVersion:1})).status,409);
 }finally{await f.close();}
});
test('manual points are disabled by default and require admin, valid Origin, CSRF and current password',async()=>{
 const f=await fixture({adminBalanceAdjustments:true});try{const url='/api/admin/members/'+f.ids.player+'/balance-adjustments';
 assert.equal((await f.client().request(url,input)).status,401);assert.equal((await f.player.request(url,input)).status,403);
 assert.equal((await f.admin.request(url,input,{origin:'https://attacker.test'})).status,403);assert.equal((await f.admin.request(url,input,{csrf:'wrong'})).status,403);
 assert.equal((await f.admin.request(url,{...input,password:'incorrect'})).status,401);assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
 f.config.adminBalanceAdjustments=false;assert.equal((await f.admin.request(url,input)).status,503);
 }finally{await f.close();}
});
test('credit/debit atomically append ledger/audit/history, idempotency excludes secrets and never counts as cash/VIP',async()=>{
 const f=await fixture({adminBalanceAdjustments:true});try{const url='/api/admin/members/'+f.ids.player+'/balance-adjustments',key=randomUUID(),before=(await f.player.request('/api/me/community')).data.vip;
 const a=await f.admin.request(url,input,{key});assert.equal(a.status,200,JSON.stringify(a.data));assert.equal(a.data.after,10100);assert.equal(a.data.countsAsPayment,false);
 assert.deepEqual((await f.admin.request(url,{...input,otp:'IGNORED-NON-MFA'},{key})).data,a.data);
 assert.equal((await f.admin.request(url,{...input,amount:101},{key})).status,409);
 const b=await f.admin.request(url,{...input,direction:'debit',amount:40,expectedBalance:10100});assert.equal(b.status,200);assert.equal(b.data.after,10060);
 assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE kind='admin_adjustment'")!.n,2);assert.equal(f.store.one("SELECT COUNT(*) n FROM audit WHERE action='admin_balance_adjustment'")!.n,2);
 const history=(await f.admin.request(url)).data.items;assert.equal(history.length,2);assert.equal(history[0].actor_id,f.ids.admin);assert.equal(history[0].reason,input.reason);
 const safe={direction:'credit',amount:100,expectedBalance:10000,reason:input.reason,reference:input.reference};assert.equal(f.store.one('SELECT request_hash FROM idempotency WHERE key=?',key)!.request_hash,sha256(JSON.stringify(['POST',url,safe])));
 const recorded=JSON.stringify([f.store.all('SELECT * FROM audit'),f.store.all('SELECT * FROM idempotency'),history]);assert.equal(recorded.includes(testPassword),false);assert.equal(recorded.includes('IGNORED-NON-MFA'),false);
 assert.equal(f.store.one('SELECT COUNT(*) n FROM payment_orders')!.n,0);assert.deepEqual((await f.player.request('/api/me/community')).data.vip,before);
 assert.equal((await f.admin.request('/api/admin/activity?category=account')).data.items[0].action,'admin_balance_adjustment');
 for(const t of ['balance_adjustments','ledger','audit']){assert.throws(()=>f.store.run('DELETE FROM '+t));assert.throws(()=>f.store.run('UPDATE '+t+' SET created_at=0'));}
 }finally{await f.close();}
});
test('adjustments reject self, other admins, disabled users, bounds, extra fields, insufficient and stale balances',async()=>{
 const f=await fixture({adminBalanceAdjustments:true});try{const url='/api/admin/members/'+f.ids.player+'/balance-adjustments';
 for(const change of [{amount:0},{amount:-1},{amount:1.5},{amount:100001},{reason:'短'},{extra:true}])assert.equal((await f.admin.request(url,{...input,...change})).status,400);
 assert.equal((await f.admin.request('/api/admin/members/'+f.ids.admin+'/balance-adjustments',input)).status,403);
 f.store.run('UPDATE users SET disabled=1 WHERE id=?',f.ids.other);assert.equal((await f.admin.request('/api/admin/members/'+f.ids.other+'/balance-adjustments',input)).status,403);
 assert.equal((await f.admin.request(url,{...input,direction:'debit',amount:10001})).status,409);assert.equal((await f.admin.request(url,{...input,expectedBalance:1})).status,409);
 const concurrent=await Promise.all([f.admin.request(url,input),f.admin.request(url,{...input,amount:200})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
 assert.equal(f.store.one('SELECT COUNT(*) n FROM balance_adjustments')!.n,1);
 }finally{await f.close();}
});
test('write failure rolls back every balance/ledger/history/audit change',async()=>{
 const f=await fixture({adminBalanceAdjustments:true});try{f.store.db.exec("CREATE TRIGGER local_failure BEFORE INSERT ON balance_adjustments BEGIN SELECT RAISE(ABORT,'isolated test failure'); END;");
 assert.equal((await f.admin.request('/api/admin/members/'+f.ids.player+'/balance-adjustments',input)).status,500);
 assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE kind='admin_adjustment'")!.n,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM balance_adjustments')!.n,0);
 }finally{await f.close();}
});
test('reauth failures throttle and enrolled MFA required, consumed once, idempotent retry works',async()=>{
 const f=await fixture({adminBalanceAdjustments:true});try{const url='/api/admin/members/'+f.ids.player+'/balance-adjustments';
 for(let i=0;i<5;i++)assert.equal((await f.admin.request(url,{...input,password:'wrong'})).status,401);
 assert.equal((await f.admin.request(url,input)).status,429);f.store.run("DELETE FROM rate_limits WHERE key LIKE 'balance-reauth:%'");
 f.config.identity.authSecret='ab'.repeat(32);const setup=await f.admin.request('/api/admin/mfa/setup',{password:testPassword});assert.equal(setup.status,200);
 assert.equal((await f.admin.request('/api/admin/mfa/enable',{code:totp(setup.data.secret)})).status,200);
 assert.equal((await f.admin.request(url,input)).status,401);
 const otp=totp(setup.data.secret,Math.floor(Date.now()/30000)+1),key=randomUUID(),a=await f.admin.request(url,{...input,otp},{key});assert.equal(a.status,200,JSON.stringify(a.data));
 assert.deepEqual((await f.admin.request(url,{...input,otp},{key})).data,a.data);assert.equal((await f.admin.request(url,{...input,expectedBalance:10100,otp})).status,401);
 }finally{await f.close();}
});
test('paper selection and peel views are escaped, bounded, keyboard-accessible and have skip controls',()=>{
 assert.equal(peelProgress(-1),0);assert.equal(peelProgress(180),100);assert.equal(peelProgress(NaN),0);
 const select=ticketSelectionView(10,10000);assert.equal((select.match(/data-action="ticket-pick"/g)||[]).length,24);assert.match(select,/aria-pressed="false"/);assert.match(select,/不改變機率/);
 const paper=paperTicketView({name:'<script>bad</script>',ordinal:1,image:''},0,2);assert.equal(paper.includes('<script>'),false);assert.match(paper,/type="range"/);assert.match(paper,/aria-hidden="true"/);assert.match(paper,/全部揭曉/);
});
test('draw result GET and recovery are private, do not charge again, old POST contract remains unchanged',async()=>{
 const f=await fixture();try{const id=await livePool(f,physicalPool(2)),key=randomUUID();const a=await f.player.request('/api/pools/'+id+'/draw',{quantity:1},{key});assert.equal(a.status,200);
 const balance=f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points;
 assert.deepEqual((await f.player.request('/api/me/draw-requests/'+key)).data,a.data);assert.equal((await f.other.request('/api/me/draw-requests/'+key)).status,404);
 assert.equal((await f.other.request('/api/me/draws/'+a.data.results[0].id)).status,404);assert.equal((await f.player.request('/api/me/draws/'+a.data.results[0].id)).data.name,'收藏卡');
 assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,balance);assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,1);
 }finally{await f.close();}
});

test('selected cosmetic slots persist with results without controlling outcome, invalid selections never debit',async()=>{
 const f=await fixture();try{const id=await livePool(f,physicalPool(3));
 for(const presentationSlots of [[1,1],[25,2],[1]])assert.equal((await f.player.request('/api/pools/'+id+'/draw',{quantity:2,presentationSlots})).status,400);
 assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
 const key=randomUUID(),a=await f.player.request('/api/pools/'+id+'/draw',{quantity:2,presentationSlots:[2,6]},{key});assert.equal(a.status,200);assert.deepEqual(a.data.results.map((r:any)=>r.presentationSlot),[2,6]);
 assert.equal((await f.player.request('/api/me/draws/'+a.data.results[0].id)).data.presentationSlot,2);assert.deepEqual((await f.player.request('/api/me/draw-requests/'+key)).data,a.data);
 assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,2);assert.throws(()=>f.store.run('UPDATE draw_presentations SET slot=1'));
 }finally{await f.close();}
});

test('same-page preview is explicitly non-transactional and never claims an award or saved collection',()=>{
 const selection=ticketSelectionView(1,12,true);assert.match(selection,/不抽獎、不扣點、不發獎/);assert.equal((selection.match(/data-action="ticket-pick"/g)||[]).length,12);
 const paper=paperTicketView({preview:true,name:'商品展示位置（動畫預覽）',ordinal:0},0,1);assert.match(paper,/互動預覽 · 非抽獎結果/);assert.match(paper,/沒有商品入帳/);assert.equal(paper.includes('商品已保存'),false);
});
