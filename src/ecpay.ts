import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { paymentCommunity } from './community.js';
import { HttpError, requireRow, type Store } from './db.js';
import {requirePublishedStorefront} from './storefront-data.js';

type Fields = Record<string, string>;
export const ecpayEndpoint = (config: Config) => `https://payment${config.ecpay.mode === 'stage' ? '-stage' : ''}.ecpay.com.tw/Cashier/AioCheckOut/V5`;

// ECPay AIO SHA256: alphabetical case-insensitive sort and .NET-style URL encoding.
// Official independent test vector: https://developers.ecpay.com.tw/2902/
export function checkMacValue(fields: Fields, hashKey: string, hashIV: string) {
  const names = Object.keys(fields).filter(k => k.toLowerCase() !== 'checkmacvalue')
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  const raw = `HashKey=${hashKey}&${names.map(k => `${k}=${fields[k]}`).join('&')}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw).replace(/%20/g, '+').replace(/~/g, '%7e').replace(/'/g, '%27').toLowerCase();
  return createHash('sha256').update(encoded).digest('hex').toUpperCase();
}
export function validMac(fields: Fields, config: Config) {
  const mac = fields.CheckMacValue;
  if (!mac || !/^[A-Fa-f0-9]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(mac.toUpperCase()), Buffer.from(checkMacValue(fields, config.ecpay.hashKey, config.ecpay.hashIV)));
}
function available(config: Config) {
  if (!config.ecpay.enabled) throw new HttpError(503, '綠界付款尚未啟用');
}
export function createCheckout(store: Store, config: Config, userId: string, input: unknown) {
  available(config);
  if(config.production){const u=requireRow(store.one('SELECT email_verified_at,phone_verified_at FROM users WHERE id=?',userId));if(!u.email_verified_at||!u.phone_verified_at)throw new HttpError(403,'正式儲值前須完成 Email 與手機驗證');if(!config.identity.turnstileSite||!config.identity.turnstileSecret)throw new HttpError(503,'正式收款前須設定防機器人驗證');}
  if(config.production)requirePublishedStorefront(store);
  const { amount } = z.object({ amount: z.number().int().min(1).max(20000) }).strict().parse(input);
  // Server is authoritative: NT$1 = 1 point, client cannot choose points or merchant settings.
  const orderNo = 'LB' + randomBytes(9).toString('hex');
  const now = Date.now();
  store.run("INSERT INTO payment_orders(order_no,user_id,merchant_id,environment,amount,points,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)",
    orderNo, userId, config.ecpay.merchantId, config.ecpay.mode, amount, amount, now);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(now).replace(/-/g, '/');
  const fields: Fields = {
    MerchantID: config.ecpay.merchantId, MerchantTradeNo: orderNo, MerchantTradeDate: date,
    PaymentType:'aio', TotalAmount:String(amount), TradeDesc: config.ecpay.mode === 'stage' ? 'LUCKYBOX test points' : 'LUCKYBOX points',
    ItemName:`LUCKYBOX ${amount} points`, ReturnURL:`${config.origin}/payments/ecpay/notify`,
    ClientBackURL:`${config.origin}/#wallet`, ChoosePayment:'Credit', EncryptType:'1'
  };
  fields.CheckMacValue = checkMacValue(fields, config.ecpay.hashKey, config.ecpay.hashIV);
  store.audit(userId, 'ecpay_order_created', orderNo, { amount, points:amount, mode:config.ecpay.mode });
  return { orderNo, amount, points:amount, mode:config.ecpay.mode, action:ecpayEndpoint(config), fields };
}

// Exact exception to browser Origin/CSRF checks: only a bounded, signed server callback.
// Browser return URLs never modify balances. Never credit ECPay "SimulatePaid=1" messages.
export function installEcpayNotify(app: Express, store: Store, config: Config) {
  app.post('/payments/ecpay/notify', express.urlencoded({extended:false, limit:'16kb', parameterLimit:64}), (req, res) => {
    res.type('text/plain').setHeader('Cache-Control', 'no-store');
    try {
      available(config);
      if (!req.is('application/x-www-form-urlencoded')) throw new HttpError(415, 'Invalid content type');
      const body = req.body;
      if (!body || Object.values(body).some(v => typeof v !== 'string') || Object.keys(body).length > 64) throw new HttpError(400, 'Invalid fields');
      const fields = body as Fields;
      if (!validMac(fields, config)) throw new HttpError(400, 'Invalid signature');
      if (fields.MerchantID !== config.ecpay.merchantId || !/^[A-Za-z0-9]{1,20}$/.test(fields.MerchantTradeNo ?? '') ||
          !/^[1-9][0-9]{0,7}$/.test(fields.TradeAmt ?? '') || !/^[A-Za-z0-9]{1,20}$/.test(fields.TradeNo ?? '') ||
          !/^[0-9]{1,10}$/.test(fields.RtnCode ?? '') || !['0','1'].includes(fields.SimulatePaid)) throw new HttpError(400, 'Invalid notification');
      store.tx(() => {
        const order = requireRow(store.one('SELECT * FROM payment_orders WHERE order_no=?', fields.MerchantTradeNo));
        if (order.merchant_id !== fields.MerchantID || order.environment !== config.ecpay.mode || order.amount !== Number(fields.TradeAmt)) throw new HttpError(400, 'Order mismatch');
        if (fields.SimulatePaid === '1') { store.audit(null, 'ecpay_simulation_ignored', order.order_no); return; }
        if (fields.RtnCode !== '1') { store.audit(null, 'ecpay_payment_not_successful', order.order_no, {code:fields.RtnCode}); return; }
        if (order.status === 'paid') {
          if (order.trade_no !== fields.TradeNo) throw new HttpError(409, 'Transaction mismatch');
          return;
        }
        store.run("UPDATE payment_orders SET status='paid',trade_no=?,paid_at=? WHERE order_no=? AND status='pending'", fields.TradeNo, Date.now(), order.order_no);
        store.balance(order.user_id, order.points, 'ecpay_topup', order.order_no);
        paymentCommunity(store,order.user_id,order.environment);
        store.audit(null, 'ecpay_payment_credited', order.order_no, {amount:order.amount,points:order.points,mode:order.environment});
      });
      res.status(200).send('1|OK');
    } catch (error) {
      // Do not echo the provider payload, secrets, personal data, or internal exceptions.
      const code = error instanceof HttpError ? error.status : 500;
      res.status(code).send('0|Rejected');
    }
  });
}
