import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { fixture,physicalPool,livePool,testPassword } from './helpers.js';
process.env.QUIET_LOGS='true';

test('responsive member/security/checkout/admin campaigns at phone, tablet, desktop and landscape sizes',{timeout:180000},async()=>{
  const f=await fixture(),browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const out=process.env.ADMIN_EVIDENCE_DIR??'test-results/release';mkdirSync(out,{recursive:true});
  try{
    await livePool(f,{...physicalPool(20),name:'每抽必中手機體驗池',kind:'free',price:0});
    const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.origin);await page.locator('[data-action="login"]').first().click();await page.getByLabel('Email',{exact:true}).fill('player@example.test');await page.getByLabel('密碼',{exact:true}).fill(testPassword);await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    const overflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Document has horizontal overflow at '+JSON.stringify(page.viewportSize()));
    for(const [width,height]of [[320,640],[360,780],[390,844],[430,932],[768,1024],[1280,800],[844,390]]){
      await page.setViewportSize({width,height});await page.goto(f.origin+'/#community');await expect(page.getByRole('heading',{name:'會員中心',exact:true})).toBeVisible();await overflow();
      await expect(page.locator('.taskCard')).toHaveCount(4);for(const button of await page.locator('[data-action="claim-task"]').all())await expect(button).toBeDisabled();
      await page.screenshot({path:path.join(out,`member-${width}x${height}.png`),fullPage:true});
      await page.goto(f.origin+'/#account');await expect(page.getByRole('heading',{name:'登入與驗證',exact:true})).toBeVisible();await overflow();
      await expect(page.locator('[data-action="verify-phone"]')).toBeDisabled();await expect(page.locator('[data-action="google-link"]')).toBeDisabled();
      await page.goto(f.origin+'/#wallet');await expect(page.getByRole('heading',{name:'點數錢包',exact:true})).toBeVisible();await overflow();
      await page.goto(f.origin);await expect(page.locator('.liveTicker')).toBeVisible();await overflow();
      await page.locator('[data-action="pool"]').first().click();await expect(page.locator('dialog')).toBeVisible();await expect(page.locator('dialog')).toContainText('每抽必中手機體驗池');
      assert.ok(await page.locator('dialog').evaluate(n=>n.getBoundingClientRect().right<=innerWidth+1&&n.getBoundingClientRect().left>=-1));await page.locator('[data-action="close"]').click();
    }
    // The paid-draw gate remains server-side; missing provider UI is not a fake login/OTP.
    await page.goto(f.origin+'/#account');await page.locator('[data-action="verify-email"]').click();await page.locator('dialog').getByRole('button',{name:'寄送驗證信',exact:true}).click();await expect(page.locator('#toast')).toContainText('並未實際寄出');
    await page.locator('[data-action="logout"]').click();await page.goto(f.origin+'/admin/');await page.getByLabel('管理員 Email',{exact:true}).fill('admin@example.test');await page.getByLabel('管理員密碼',{exact:true}).fill(testPassword);await page.getByRole('button',{name:'登入管理中心',exact:true}).click();
    await page.locator('[data-action="admin-tab"][data-id="campaigns"]').click();await expect(page.getByRole('heading',{name:'VIP 與活動設定',exact:true})).toBeVisible();
    await page.getByLabel('等級名稱',{exact:true}).first().fill('測試收藏新星');await page.getByRole('button',{name:'儲存 VIP 與活動設定',exact:true}).click();await expect(page.locator('#toast')).toContainText('已儲存');
    assert.equal((await f.admin.request('/api/admin/campaigns')).data.settings.vip[0].name,'測試收藏新星');
    for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});await overflow();await page.screenshot({path:path.join(out,`campaigns-${width}.png`),fullPage:true});}
    await page.locator('[data-action="admin-tab"][data-id="security"]').click();await expect(page.getByRole('heading',{name:'服務與安全',exact:true})).toBeVisible();await overflow();
    await page.locator('[data-action="admin-tab"][data-id="refunds"]').click();await expect(page.getByRole('heading',{name:'付款對帳與退款',exact:true})).toBeVisible();assert.deepEqual(errors,[]);
  }finally{await browser.close();await f.close();}
});
