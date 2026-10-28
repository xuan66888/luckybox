import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { checkMacValue } from '../src/ecpay.js';
import { readConfig } from '../src/config.js';

const ec = {enabled:true,mode:'stage' as const,merchantId:'3002607',hashKey:'pwFHCqoQZGmho4w6',hashIV:'EkRm7iFT261dpevs',liveApproved:false};
test('ECPay: independent official SHA256 vector', () => {
  assert.equal(checkMacValue({TradeDesc:'促銷方案',PaymentType:'aio',MerchantTradeDate:'2023/03/12 15:30:23',MerchantTradeNo:'ecpay20230312153023',MerchantID:'3002607',ReturnURL:'https://www.ecpay.com.tw/receive.php',ItemName:'Apple iphone 15',TotalAmount:'30000',ChoosePayment:'ALL',EncryptType:'1'},ec.hashKey,ec.hashIV),'6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840');
});
test('ECPay: secure defaults and live gates', () => {
  assert.equal(readConfig({}).ecpay.enabled,false);
  assert.throws(() => readConfig({ECPAY_ENABLED:'true'}));
  const env = {ECPAY_ENABLED:'true',ECPAY_MODE:'production',ECPAY_MERCHANT_ID:'3002607',ECPAY_HASH_KEY:ec.hashKey,ECPAY_HASH_IV:ec.hashIV,NODE_ENV:'production',PUBLIC_ORIGIN:'https://shop.example.com',ECPAY_LIVE_APPROVED:'true'};
  assert.throws(() => readConfig(env));
  assert.throws(() => readConfig({...env,ECPAY_MERCHANT_ID:'1234567',ECPAY_LIVE_APPROVED:'false'}));
  assert.throws(() => readConfig({...env,ECPAY_MODE:'stage'}));
});
test('ECPay: disabled payments fail closed', async () => {
  const f = await fixture();
  try { assert.equal((await f.player.request('/api/payments/ecpay',{amount:100})).status,503); }
  finally {await f.close();}
});
test('ECPay: checkout validation, ownership, CSRF and idempotency', async () => {
  const f = await fixture({ecpay:ec});
  try {
    assert.equal((await f.client().request('/api/payments/ecpay',{amount:100})).status,401);
    assert.equal((await f.player.request('/api/payments/ecpay',{amount:100},{csrf:'wrong'})).status,403);
    assert.equal((await f.player.request('/api/payments/ecpay',{amount:100},{origin:'https://attacker.test'})).status,403);
    for (const body of [{amount:0},{amount:20001},{amount:1.1},{amount:'100'},{amount:100,points:10000}]) assert.equal((await f.player.request('/api/payments/ecpay',body)).status,400);
    const key = randomUUID();
    const a = await f.player.request('/api/payments/ecpay',{amount:100},{key});
    assert.equal(a.status,200);
    assert.equal(a.data.points,100); assert.equal(a.data.fields.TotalAmount,'100');
    assert.equal(a.data.action,'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5');
    assert.equal(a.data.fields.ReturnURL,f.origin+'/payments/ecpay/notify');
    assert.equal(a.data.fields.ChoosePayment,'Credit');
    assert.equal(a.data.fields.CheckMacValue,checkMacValue(a.data.fields,ec.hashKey,ec.hashIV));
    assert.equal(JSON.stringify(a.data).includes(ec.hashKey),false);
    const b = await f.player.request('/api/payments/ecpay',{amount:100},{key});
    assert.equal(b.data.orderNo,a.data.orderNo);
    assert.equal((await f.player.request('/api/payments/ecpay',{amount:101},{key})).status,409);
    assert.equal((await f.other.request('/api/me/payments')).data.length,0);
    assert.equal((await f.player.request('/api/me/payments')).data.length,1);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
  } finally {await f.close();}
});
test('ECPay: signed callbacks, simulation, retry, concurrent replay and atomic credit', async () => {
  const f = await fixture({ecpay:ec});
  try {
    const order = (await f.player.request('/api/payments/ecpay',{amount:100})).data;
    const base = {MerchantID:ec.merchantId,MerchantTradeNo:order.orderNo,TradeNo:'T1234567890',TradeAmt:'100',RtnCode:'1',SimulatePaid:'0'};
    async function notify(change: Record<string,string> = {}, corrupt = false) {
      const fields: Record<string,string> = {...base,...change};
      fields.CheckMacValue = corrupt ? '0'.repeat(64) : checkMacValue(fields,ec.hashKey,ec.hashIV);
      const r = await fetch(f.origin+'/payments/ecpay/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
      return {status:r.status,text:await r.text()};
    }
    const balance = () => f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points;
    assert.equal((await notify({},true)).status,400);
    assert.equal((await notify({TradeAmt:'99'})).status,400);
    assert.equal((await notify({MerchantID:'1234567'})).status,400);
    assert.equal((await notify({SimulatePaid:''})).status,400);
    assert.equal((await notify({MerchantTradeNo:'UNKNOWN'})).status,404);
    assert.deepEqual(await notify({SimulatePaid:'1'}),{status:200,text:'1|OK'});
    assert.equal(balance(),10000);
    assert.deepEqual(await notify({RtnCode:'10100248'}),{status:200,text:'1|OK'});
    assert.equal(balance(),10000);
    const results = await Promise.all(Array.from({length:5},() => notify()));
    assert.ok(results.every(r => r.status===200 && r.text==='1|OK'));
    assert.equal(balance(),10100);
    assert.equal(f.store.one("SELECT count(*) n FROM ledger WHERE kind='ecpay_topup'")!.n,1);
    assert.equal((await notify({TradeNo:'DIFFERENT'})).status,409);
    assert.equal(balance(),10100);
    const next = (await f.player.request('/api/payments/ecpay',{amount:100})).data;
    assert.equal((await notify({MerchantTradeNo:next.orderNo})).status,500);
    assert.equal(balance(),10100);
    assert.equal(f.store.one('SELECT status FROM payment_orders WHERE order_no=?',next.orderNo)!.status,'pending');
    // A ledger failure must roll the order back to pending, allowing a corrected retry.
    f.store.db.exec("CREATE TRIGGER test_credit_failure BEFORE INSERT ON ledger WHEN NEW.kind='ecpay_topup' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.equal((await notify({MerchantTradeNo:next.orderNo,TradeNo:'NEWTRANSACTION'})).status,500);
    assert.equal(balance(),10100);
    assert.equal(f.store.one('SELECT status FROM payment_orders WHERE order_no=?',next.orderNo)!.status,'pending');
    f.store.db.exec('DROP TRIGGER test_credit_failure');
    assert.deepEqual(await notify({MerchantTradeNo:next.orderNo,TradeNo:'NEWTRANSACTION'}),{status:200,text:'1|OK'});
    assert.equal(balance(),10200);
  } finally {await f.close();}
});
