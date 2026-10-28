import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fixture, testPassword } from './helpers.js';
process.env.QUIET_LOGS = 'true';

test('ECPay wallet: explicit stage warning and actual external POST form, no real charge', {timeout:60000}, async () => {
  const f = await fixture({ecpay:{enabled:true,mode:'stage',merchantId:'3002607',hashKey:'pwFHCqoQZGmho4w6',hashIV:'EkRm7iFT261dpevs',liveApproved:false}});
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    let submitted: URLSearchParams | undefined;
    // Intercept only in this isolated test: no request/card details reach ECPay.
    await page.route('https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5', async route => {
      assert.equal(route.request().method(),'POST');
      submitted = new URLSearchParams(route.request().postData() ?? '');
      await route.fulfill({status:200,contentType:'text/html',body:'<h1>Isolated checkout POST captured</h1>'});
    });
    await page.goto(f.origin);
    await page.getByRole('button',{name:'登入 / 註冊',exact:true}).click();
    await page.getByLabel('Email',{exact:true}).fill('player@example.test');
    await page.getByLabel('密碼',{exact:true}).fill(testPassword);
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await expect(page.locator('dialog')).not.toBeVisible();
    await page.locator('button.wallet[data-page="wallet"]').click();
    await expect(page.getByText('綠界測試環境：僅測試點數，不代表真實收款。NT$1＝1點。',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'綠界信用卡儲值',exact:true}).click();
    await page.getByLabel('儲值金額 NT$',{exact:true}).fill('100');
    await page.getByRole('button',{name:'前往綠界付款',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Isolated checkout POST captured'})).toBeVisible();
    assert.equal(submitted?.get('TotalAmount'),'100');
    assert.equal(submitted?.get('MerchantID'),'3002607');
    assert.equal(submitted?.get('ChoosePayment'),'Credit');
    assert.equal(submitted?.has('HashKey'),false);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?',f.ids.player)!.points,10000);
    assert.equal(f.store.one('SELECT status FROM payment_orders')!.status,'pending');
  } finally {await browser.close();await f.close();}
});
