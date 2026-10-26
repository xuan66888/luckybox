import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fixture, testPassword } from './helpers.js';
process.env.QUIET_LOGS = 'true';

test('desktop and mobile UI: create, review, open, draw, redeem, ship and settle', { timeout:120000 }, async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}) });
  const errors: string[] = [];
  try {
    const creator = await browser.newPage({viewport:{width:1440,height:1000}}), admin = await browser.newPage(), player = await browser.newPage();
    const login = async (page: Page, name: string) => {
      page.on('pageerror',e => errors.push(e.message));
      page.on('console',m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
      page.on('dialog',d => { void d.accept(); });
      await page.goto(f.origin); await page.getByRole('button',{name:'登入 / 註冊',exact:true}).click();
      await page.getByLabel('Email',{exact:true}).fill(`${name}@example.test`); await page.getByLabel('密碼',{exact:true}).fill(testPassword);
      await page.getByRole('button',{name:'登入',exact:true}).click(); await expect(page.locator('dialog')).not.toBeVisible();
    };
    await login(creator,'creator'); await login(admin,'admin'); await login(player,'player');
    await creator.getByRole('button',{name:'創作者中心',exact:true}).click(); await creator.getByRole('button',{name:'＋ 建立獎池',exact:true}).click();
    await creator.getByLabel('獎池名稱',{exact:true}).fill('UI 驗證收藏池'); await creator.getByLabel('商品 / 活動介紹',{exact:true}).fill('測試商品介紹 <img src=x onerror=alert(1)>');
    await creator.getByLabel('獎品名稱',{exact:true}).fill('實體收藏卡'); await creator.getByLabel('數量',{exact:true}).fill('2');
    await creator.getByLabel('實體商品兌點額',{exact:true}).fill('50'); await creator.getByRole('button',{name:'儲存草稿',exact:true}).click();
    await expect(creator.locator('dialog')).not.toBeVisible(); await creator.getByRole('button',{name:'送審',exact:true}).click();
    await expect(creator.getByText('待審核',{exact:true}).first()).toBeVisible();
    await admin.getByRole('button',{name:'管理後台',exact:true}).click(); await admin.getByRole('button',{name:'核准',exact:true}).click();
    await admin.getByLabel('審核 / 取消原因',{exact:true}).fill('已核實測試庫存'); await admin.getByRole('button',{name:'確認送出',exact:true}).click();
    await expect(admin.locator('dialog')).not.toBeVisible();
    await creator.getByRole('button',{name:'創作者中心',exact:true}).click(); await creator.getByRole('button',{name:'開放抽獎',exact:true}).click();
    await expect(creator.getByText('開放中',{exact:true}).first()).toBeVisible();
    await player.getByRole('button',{name:'探索獎池',exact:true}).click(); await player.getByRole('button',{name:'查看獎池',exact:true}).click();
    await expect(player.getByText('測試商品介紹 <img src=x onerror=alert(1)>',{exact:true})).toBeVisible();
    await player.getByRole('button',{name:'確認抽獎',exact:true}).click(); await expect(player.getByRole('heading',{name:'抽獎結果'})).toBeVisible();
    await player.getByRole('button',{name:'查看收藏',exact:true}).click(); await player.getByRole('button',{name:'兌換 50 pt',exact:true}).click();
    await expect(player.getByText('已兌點',{exact:true}).first()).toBeVisible();
    const other = await browser.newPage({viewport:{width:390,height:844}}); await login(other,'other');
    await other.getByRole('button',{name:'查看獎池',exact:true}).click(); await other.getByRole('button',{name:'確認抽獎',exact:true}).click();
    await other.getByRole('button',{name:'查看收藏',exact:true}).click(); await other.getByRole('button',{name:'申請出貨',exact:true}).click();
    await other.getByLabel('收件人',{exact:true}).fill('測試玩家'); await other.getByLabel('電話',{exact:true}).fill('0912345678'); await other.getByLabel('完整收件地址',{exact:true}).fill('測試城市 測試路 123 號');
    await other.getByRole('button',{name:'送出出貨申請',exact:true}).click(); await expect(other.locator('dialog')).not.toBeVisible();
    await creator.getByRole('button',{name:'創作者中心',exact:true}).click(); await creator.getByRole('button',{name:'登記出貨',exact:true}).click();
    await creator.getByLabel('物流公司',{exact:true}).fill('測試物流'); await creator.getByLabel('追蹤號碼',{exact:true}).fill('TEST123456');
    await creator.getByRole('button',{name:'確認已交寄',exact:true}).click(); await expect(creator.locator('dialog')).not.toBeVisible();
    await other.getByRole('button',{name:'我的收藏',exact:true}).click(); await other.getByRole('button',{name:'確認收貨',exact:true}).click();
    await expect(other.getByText('已收貨',{exact:true}).first()).toBeVisible();
    await creator.getByRole('button',{name:'創作者中心',exact:true}).click(); await creator.getByRole('button',{name:'申請結算',exact:true}).click();
    await admin.getByRole('button',{name:'管理後台',exact:true}).click(); await admin.getByRole('button',{name:'核准點數結算',exact:true}).click();
    await expect(admin.getByText('已結算',{exact:true}).first()).toBeVisible();
    mkdirSync('test-results',{recursive:true}); await admin.evaluate(() => window.scrollTo({top:0,behavior:'instant'})); await other.evaluate(() => window.scrollTo({top:0,behavior:'instant'})); await admin.screenshot({path:'test-results/admin-desktop.png',fullPage:true}); await other.screenshot({path:'test-results/collection-mobile.png',fullPage:true});
    await player.getByRole('button',{name:'探索獎池',exact:true}).click(); await expect(player.locator('.hero')).toBeVisible(); await player.evaluate(() => window.scrollTo({top:0,behavior:'instant'})); await player.screenshot({path:'test-results/home-desktop.png',fullPage:true});
    assert.deepEqual(errors,[]);
    assert.equal(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true,'Mobile must not overflow');
  } finally { await browser.close(); await f.close(); }
});
