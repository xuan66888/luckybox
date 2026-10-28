import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixture, physicalPool, testPassword } from './helpers.js';
process.env.QUIET_LOGS='true';

test('per-pool editor lists 31 actual items, searches items without dropping hidden odds, and forbids no-win in drafts',{timeout:90000},async()=>{
  const f=await fixture();
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try{
    const prizes=Array.from({length:31},(_,i)=>({name:i===30?'自訂保底獎':`實際上架物品 ${String(i+1).padStart(2,'0')}`,kind:'physical',image:'',value:100,redeemPoints:0,quantity:1}));
    const a=(await f.creator.request('/api/pools',{...physicalPool(),name:'限定物品清單 A',prizes})).data.id;
    const b=(await f.creator.request('/api/pools',{...physicalPool(),name:'另一獎池 B',prizes:prizes.slice(0,2)})).data.id;
    const pa=(await f.creator.request('/api/pools/'+a)).data;
    assert.equal((await f.admin.request('/api/admin/pools/'+a+'/odds',{expectedVersion:0,prizes:pa.prizes.map((p:any)=>({id:p.id,probabilityBps:p.name==='自訂保底獎'?5000:p.name.endsWith('01')?5000:0}))})).status,200);
    const before=(await f.creator.request('/api/pools/'+b)).data;
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.origin+'/admin/');await page.getByLabel('管理員 Email',{exact:true}).fill('admin@example.test');await page.getByLabel('管理員密碼',{exact:true}).fill(testPassword);await page.getByRole('button',{name:'登入管理中心',exact:true}).click();
    await page.locator('[data-action="admin-tab"][data-id="catalog"]').click();
    await page.locator(`[data-action="admin-odds"][data-id="${a}"]`).click();
    await expect(page.locator('[data-odds-scope]')).toContainText('限定物品清單 A');await expect(page.locator('[data-odds-scope]')).toHaveAttribute('data-odds-scope',a);
    await expect(page.locator('[data-odds-row]')).toHaveCount(31);
    await page.getByLabel('實際上架物品 01 機率 (%)',{exact:true}).fill('45');
    await page.getByLabel('搜尋此獎池的物品',{exact:true}).fill('自訂保底獎');
    await expect(page.locator('[data-odds-row]:visible')).toHaveCount(1);
    await page.getByLabel('自訂保底獎 機率 (%)',{exact:true}).fill('55');
    await expect(page.locator('[data-odds-total]')).toHaveText('機率合計：100.00%');
    const directory=process.env.ADMIN_EVIDENCE_DIR??'test-results/admin';mkdirSync(directory,{recursive:true});
    await page.screenshot({path:path.join(directory,'pool-scoped-winning-search.png')});
    await page.getByRole('button',{name:'儲存機率',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    const after=(await f.creator.request('/api/pools/'+a)).data;assert.equal(after.prizes.length,31);assert.equal(after.prizes.find((p:any)=>p.name==='自訂保底獎').weight_bps,5500);assert.equal(after.prizes.find((p:any)=>p.name.endsWith('01')).weight_bps,4500);
    assert.deepEqual((await f.creator.request('/api/pools/'+b)).data,before);
    await page.getByRole('button',{name:'建立獎池',exact:true}).click();await page.getByLabel('獎池名稱',{exact:true}).fill('每抽必中編輯測試');
    await page.locator('.prizeEditor').first().getByLabel('獎品名稱',{exact:true}).fill('任意自訂上架商品');
    await expect(page.locator('[data-action="add-no-win"]')).toHaveCount(0);
    await expect(page.locator('select[name="prizeKind"] option[value="none"]')).toHaveCount(0);
    await page.getByRole('button',{name:'＋ 新增獎項',exact:true}).click();
    await page.locator('.prizeEditor').last().getByLabel('獎品名稱',{exact:true}).fill('第四獎自訂收藏品');
    await page.getByRole('button',{name:'儲存草稿',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    const catalog=(await f.admin.request('/api/admin/catalog?q='+encodeURIComponent('每抽必中編輯測試'))).data;assert.equal(catalog.items[0].prizes.length,2);assert.equal(catalog.items[0].prizes.find((p:any)=>p.name==='第四獎自訂收藏品').kind,'physical');assert.deepEqual(errors,[]);
  }finally{await browser.close();await f.close();}
});