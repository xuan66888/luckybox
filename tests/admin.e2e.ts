import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { fixture, livePool, physicalPool, testPassword } from './helpers.js';
process.env.QUIET_LOGS='true';

test('admin control room: real charts, accounts, individual odds, actual winner and mobile layout', {timeout:120000},async()=>{
  const clock=Date.now,now=clock(),day=86400000;
  Date.now=()=>now-8*day;
  const f=await fixture();
  const pool=await livePool(f,{...physicalPool(),name:'測試典藏・收藏獎池',prizes:[
    {name:'大獎',kind:'physical',image:'',value:1000,redeemPoints:0,quantity:100},
    {name:'二獎',kind:'physical',image:'',value:500,redeemPoints:0,quantity:100},
    {name:'三獎',kind:'physical',image:'',value:100,redeemPoints:0,quantity:100}
  ]});
  Date.now=clock;
  await f.player.login('player');
  const counts=[1,3,2,5,4,6];
  for(let i=0;i<counts.length;i++){
    Date.now=()=>now-(6-i)*day;
    const result=await f.player.request('/api/pools/'+pool+'/draw',{quantity:counts[i]});
    assert.equal(result.status,200);
  }
  Date.now=clock;
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const directory=process.env.ADMIN_EVIDENCE_DIR??'test-results/admin';
  mkdirSync(directory,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1060}}),errors:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(f.origin+'/admin/');await expect(page.getByRole('heading',{name:'管理員登入',exact:true})).toBeVisible();
    await page.screenshot({path:path.join(directory,'admin-login.png')});
    await page.getByLabel('管理員 Email',{exact:true}).fill('admin@example.test');await page.getByLabel('管理員密碼',{exact:true}).fill(testPassword);
    await page.getByRole('button',{name:'登入管理中心',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();

    await expect(page.getByRole('heading',{name:'營運總覽',exact:true})).toBeVisible();
    await expect(page.getByRole('img',{name:'可用點數存量 K線圖',exact:true})).toBeVisible();
    await expect(page.getByRole('img',{name:'累計抽獎次數曲線圖',exact:true})).toBeVisible();
    assert.equal(await page.locator('.adminCandle').count(),7);
    // Clearly mark fixture screenshots; these are not production statistics.
    await page.locator('.adminHeading p').evaluate(n=>{n.textContent='隔離測試資料展示，非正式營運數據。';});
    await page.screenshot({path:path.join(directory,'dashboard-desktop.png')});
    await page.locator('[data-action="admin-tab"][data-id="accounts"]').click();
    await page.getByRole('button',{name:'新增管理員',exact:true}).click();
    await page.getByLabel('會員名稱',{exact:true}).fill('測試營運管理員');
    await page.getByLabel('Email',{exact:true}).fill('ops@example.test');
    await page.getByLabel('初始密碼',{exact:true}).fill(testPassword);
    await page.getByRole('button',{name:'建立帳戶',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    await expect(page.getByText('ops@example.test',{exact:true})).toBeVisible();
    await page.locator('[data-action="admin-tab"][data-id="users"]').click();
    await expect(page.getByRole('heading',{name:'註冊用戶',exact:true})).toBeVisible();
    await page.locator('.adminFilters input[name="q"]').fill('player@example.test');
    await page.getByRole('button',{name:'搜尋用戶',exact:true}).click();
    await expect(page.locator('.adminTable tbody tr')).toHaveCount(1);
    await page.locator('[data-action="admin-tab"][data-id="catalog"]').click();
    await page.getByRole('button',{name:'調整機率',exact:true}).click();
    for(const [name,value] of [['大獎','1'],['二獎','9'],['三獎','90']])await page.getByLabel(name+' 機率 (%)',{exact:true}).fill(value);
    await expect(page.locator('[data-odds-total]')).toHaveText('機率合計：100.00%');
    await page.screenshot({path:path.join(directory,'item-odds-editor.png')});
    await page.getByRole('button',{name:'儲存機率',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    await expect(page.getByText('1.00%',{exact:true}).first()).toBeVisible();
    await page.screenshot({path:path.join(directory,'item-odds-desktop.png')});
    await page.getByRole('button',{name:'調整機率',exact:true}).click();
    for(const [name,value] of [['大獎','0'],['二獎','0'],['三獎','100']])await page.getByLabel(name+' 機率 (%)',{exact:true}).fill(value);
    await page.getByRole('button',{name:'儲存機率',exact:true}).click();await expect(page.locator('dialog')).not.toBeVisible();
    const result=await f.player.request('/api/pools/'+pool+'/draw',{quantity:1,oddsVersion:2});
    assert.equal(result.status,200);assert.equal(result.data.results[0].name,'三獎');
    await page.locator('[data-action="admin-tab"][data-id="overview"]').click();
    await expect(page.getByRole('heading',{name:'營運總覽',exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole('heading',{name:'官方管理後台',exact:true})).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.locator('.adminHeading p').evaluate(n=>{n.textContent='隔離測試資料展示，非正式營運數據。';});
    await page.screenshot({path:path.join(directory,'dashboard-mobile.png')});
    const playerPage=await browser.newPage();
    await playerPage.goto(f.origin);
    await playerPage.getByRole('button',{name:'登入 / 註冊',exact:true}).click();
    await playerPage.getByLabel('Email',{exact:true}).fill('player@example.test');await playerPage.getByLabel('密碼',{exact:true}).fill(testPassword);
    await playerPage.getByRole('button',{name:'登入',exact:true}).click();await expect(playerPage.locator('dialog')).not.toBeVisible();
    await expect(playerPage.locator('[data-page="admin"]')).toHaveCount(0);
    await playerPage.locator('.avatar[data-page="account"]').click();
    await expect(playerPage.getByRole('heading',{name:'我的帳戶',exact:true})).toBeVisible();
    await expect(playerPage.locator('[data-page="admin"]')).toHaveCount(0);
    await playerPage.goto(f.origin+'/admin/');
    await expect(playerPage.getByRole('heading',{name:'無後台權限',exact:true})).toBeVisible();
    await expect(playerPage.locator('.adminStats')).toHaveCount(0);
    assert.deepEqual(errors,[]);
  }finally{Date.now=clock;await browser.close();await f.close();}
});
