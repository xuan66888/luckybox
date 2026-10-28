import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdtempSync,mkdirSync,copyFileSync,readdirSync,rmSync}from'node:fs';import os from'node:os';import path from'node:path';
import{fixture,testPassword}from'./helpers.js';import{Store}from'../src/db.js';
function paid(store:Store,user:string,amount:number,environment='production'){
 const order='L'+randomUUID().replaceAll('-','').slice(0,18),now=Date.now();store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,trade_no,created_at,paid_at) VALUES(?,?,?,?,?,?,'paid',?,?,?)",order,user,'local',environment,amount,amount,order,now,now);store.balance(user,amount,'ecpay_topup',order);return order;
}
test('wallet and reconciliation are authenticated, admin-only, bounded and conserve every source',async()=>{
 const f=await fixture();try{assert.equal((await f.client().request('/api/me/wallet')).status,401);assert.equal((await f.player.request('/api/admin/reconciliation')).status,403);assert.equal((await f.admin.request('/api/admin/reconciliation?page=0')).status,400);assert.equal((await f.admin.request('/api/admin/reconciliation?extra=1')).status,400);
 const wallet=(await f.player.request('/api/me/wallet')).data;assert.equal(wallet.points,10000);assert.equal(wallet.lotBalance,10000);assert.equal(wallet.ledgerBalance,10000);assert.equal(wallet.conserved,true);assert.equal(wallet.balances.paid,0);assert.equal(wallet.balances.other,10000);assert.equal('email'in wallet,false);
 const admin=(await f.admin.request('/api/admin/reconciliation')).data;assert.equal(admin.accounts,4);assert.equal(admin.points,40000);assert.equal(admin.issues,0);assert.equal(admin.autoRepair,false);
 }finally{await f.close();}
});
test('FIFO spends oldest paid, reward and adjustment lots and records immutable debit allocations',async()=>{
 const f=await fixture();try{const user=f.ids.player;f.store.balance(user,-10000,'fixture_reset','reset');const order=paid(f.store,user,30);f.store.balance(user,40,'community_reward','reward');f.store.balance(user,50,'admin_adjustment','manual');f.store.balance(user,-45,'draw_payment','spend');
 const w=(await f.player.request('/api/me/wallet')).data;assert.equal(w.points,75);assert.equal(w.balances.paid,0);assert.equal(w.balances.reward,25);assert.equal(w.balances.adjustment,50);assert.equal(w.conserved,true);assert.equal(f.store.sourceBalance(user,{kind:'ecpay_topup',reference:order}),0);
 const a=f.store.all("SELECT a.points,p.category FROM point_allocations a JOIN ledger l ON l.id=a.debit_ledger_id JOIN point_lots p ON p.id=a.lot_id WHERE l.reference='spend' ORDER BY p.rowid");assert.deepEqual(a.map(r=>[r.category,r.points]),[['paid',30],['reward',15]]);
 assert.throws(()=>f.store.run('DELETE FROM point_allocations'));assert.throws(()=>f.store.run('UPDATE point_allocations SET points=1'));assert.throws(()=>f.store.run('UPDATE point_lots SET category=\'paid\''));assert.throws(()=>f.store.run('DELETE FROM point_lots'));
 }finally{await f.close();}
});
test('targeted source debit never substitutes reward, another order or another user, and never partially commits',async()=>{
 const f=await fixture();try{const user=f.ids.player,a=paid(f.store,user,100),b=paid(f.store,user,200),foreign=paid(f.store,f.ids.other,300);
 f.store.balance(user,-60,'source_test','take-a',{kind:'ecpay_topup',reference:a});assert.equal(f.store.sourceBalance(user,{kind:'ecpay_topup',reference:a}),40);const before=f.store.one('SELECT points FROM users WHERE id=?',user)!.points;
 assert.throws(()=>f.store.balance(user,-50,'source_test','over-a',{kind:'ecpay_topup',reference:a}));assert.throws(()=>f.store.balance(user,-1,'source_test','foreign',{kind:'ecpay_topup',reference:foreign}));assert.equal(f.store.one('SELECT points FROM users WHERE id=?',user)!.points,before);assert.equal(f.store.sourceBalance(user,{kind:'ecpay_topup',reference:b}),200);
 assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE reference IN('over-a','foreign')")!.n,0);assert.equal((await f.player.request('/api/me/wallet')).data.conserved,true);
 }finally{await f.close();}
});
test('standalone balance writes are atomic on duplicate credit, allocation failure and invalid paid receipt',async()=>{
 const f=await fixture();try{const u=f.ids.player;f.store.balance(u,5,'community_reward','once');assert.throws(()=>f.store.balance(u,5,'community_reward','once'));assert.throws(()=>f.store.balance(u,50,'ecpay_topup','missing-receipt'));
 f.store.db.exec("CREATE TRIGGER local_alloc_failure BEFORE INSERT ON point_allocations BEGIN SELECT RAISE(ABORT,'isolated allocation failure'); END;");assert.throws(()=>f.store.balance(u,-2,'test_debit','fail'));assert.equal(f.store.one('SELECT points FROM users WHERE id=?',u)!.points,10005);assert.equal(f.store.one("SELECT COUNT(*) n FROM ledger WHERE reference IN('fail','missing-receipt')")!.n,0);assert.equal((await f.player.request('/api/me/wallet')).data.conserved,true);
 }finally{await f.close();}
});
test('legacy migration preserves actual balance without inventing receipt provenance or new ledger entries',()=>{
 const temp=mkdtempSync(path.join(os.tmpdir(),'luckybox-lots-'));try{const old=path.join(temp,'old');mkdirSync(old);for(const n of readdirSync('migrations').filter(n=>n.endsWith('.sql')&&n<'009'))copyFileSync(path.join('migrations',n),path.join(old,n));const store=new Store(path.join(temp,'old.sqlite'));try{store.migrate(old);const u=randomUUID();store.run('INSERT INTO users(id,email,name,password_hash,points,created_at) VALUES(?,?,?,?,37,?)',u,'legacy@example.test','legacy','not-used',Date.now());store.run('INSERT INTO ledger VALUES(?,?,37,37,?,?,?)',randomUUID(),u,'old_unclassified','legacy',Date.now());store.migrate(path.resolve('migrations'));assert.equal(store.one('SELECT points FROM users WHERE id=?',u)!.points,37);assert.equal(store.one('SELECT COUNT(*) n FROM ledger')!.n,1);assert.equal(store.one('SELECT remaining FROM point_lots WHERE user_id=?',u)!.remaining,37);assert.equal(store.one('SELECT category FROM point_lots WHERE user_id=?',u)!.category,'legacy');assert.equal(store.sourceBalance(u,{kind:'ecpay_topup',reference:'unknown'}),0);store.balance(u,3,'community_reward','next');assert.equal(store.one('SELECT points FROM users WHERE id=?',u)!.points,40);}finally{store.close();}}finally{assert.ok(temp.startsWith(path.join(os.tmpdir(),'luckybox-lots-')));rmSync(temp,{recursive:true,force:true});}
});
test('mismatched lot balance is reported, blocks mutation and is not silently repaired',async()=>{
 const f=await fixture();try{const lot=f.store.one('SELECT id FROM point_lots WHERE user_id=?',f.ids.player)!;f.store.run('UPDATE point_lots SET remaining=remaining-1 WHERE id=?',lot.id);assert.throws(()=>f.store.balance(f.ids.player,1,'test','blocked'));const r=(await f.admin.request('/api/admin/reconciliation')).data;assert.equal(r.issues,1);assert.equal(r.autoRepair,false);assert.equal((await f.player.request('/api/me/wallet')).data.conserved,false);assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
 }finally{await f.close();}
});
test('stage payment and manual credits do not become paid lots or paid VIP',async()=>{
 const f=await fixture();try{paid(f.store,f.ids.player,100,'stage');f.store.balance(f.ids.player,50,'admin_adjustment','adjust');const w=(await f.player.request('/api/me/wallet')).data;assert.equal(w.balances.stage,100);assert.equal(w.balances.adjustment,50);assert.equal(w.balances.paid,0);assert.equal((await f.player.request('/api/me/community')).data.vip.netPaid,0);
 }finally{await f.close();}
});
test('full refund debits the actual order lot, not an earlier gift or another payment',async()=>{
 const f=await fixture();try{const order=paid(f.store,f.ids.player,100),other=paid(f.store,f.ids.player,200);const r=await f.player.request('/api/me/refunds',{orderNo:order,reason:'隔離測試退回未使用款項'});assert.equal(r.status,200);assert.equal((await f.admin.request('/api/admin/refunds/'+r.data.id+'/transition',{action:'prepare',expectedVersion:0,note:'隔離測試核對支付資格',password:testPassword,providerEligibilityReviewed:true})).status,200);const done=await f.admin.request('/api/admin/refunds/'+r.data.id+'/transition',{action:'complete',expectedVersion:1,note:'隔離測試確認退款結果',password:testPassword,providerAmount:100,providerOutcome:'confirmed_refunded',providerReference:'LOCAL-NO-MONEY-REFUND'});assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(f.store.sourceBalance(f.ids.player,{kind:'ecpay_topup',reference:order}),0);assert.equal(f.store.sourceBalance(f.ids.player,{kind:'ecpay_topup',reference:other}),200);assert.equal((await f.player.request('/api/me/wallet')).data.balances.other,10000);assert.equal((await f.player.request('/api/me/community')).data.vip.netPaid,200);
 }finally{await f.close();}
});

test('allocation history corruption is detected even when account and lot totals still match',async()=>{
 const f=await fixture();try{f.store.balance(f.ids.player,-10,'test_spend','history');f.store.db.exec('DROP TRIGGER point_allocations_no_delete');f.store.run("DELETE FROM point_allocations WHERE debit_ledger_id=(SELECT id FROM ledger WHERE reference='history')");const w=(await f.player.request('/api/me/wallet')).data;assert.equal(w.points,w.lotBalance);assert.equal(w.sourceHistoryIssues,2);assert.equal(w.conserved,false);assert.equal((await f.admin.request('/api/admin/reconciliation')).data.issues,1);assert.throws(()=>f.store.balance(f.ids.player,1,'test_credit','blocked'));
 }finally{await f.close();}
});
test('ledger mismatch blocks fresh mutations rather than accepting an apparently balanced lot total',async()=>{
 const f=await fixture();try{f.store.run('INSERT INTO ledger VALUES(?,?,7,10007,?,?,?)',randomUUID(),f.ids.player,'corrupt_fixture','untracked',Date.now());assert.throws(()=>f.store.balance(f.ids.player,1,'test_credit','must-not-repair'));const w=(await f.player.request('/api/me/wallet')).data;assert.equal(w.points,10000);assert.equal(w.ledgerBalance,10007);assert.equal(w.conserved,false);assert.equal((await f.admin.request('/api/admin/reconciliation')).data.autoRepair,false);
 }finally{await f.close();}
});
