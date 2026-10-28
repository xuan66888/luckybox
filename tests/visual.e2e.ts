import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { fixture, livePool, physicalPool, testPassword, type Fixture } from './helpers.js';

process.env.QUIET_LOGS = 'true';

async function visualPool(f: Fixture, name: string, color: string, free = false) {
  // Original geometric test artwork; all sample pools exist only in this temporary database.
  const artwork = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><radialGradient id="g"><stop stop-color="${color}"/><stop offset="1" stop-color="#090611"/></radialGradient><linearGradient id="a"><stop stop-color="#ffffff"/><stop offset="0.45" stop-color="${color}"/><stop offset="1" stop-color="#2a163d"/></linearGradient></defs><rect width="800" height="600" fill="#090611"/><ellipse cx="400" cy="350" rx="370" ry="245" fill="url(#g)" opacity=".6"/><g fill="none" stroke="${color}" opacity=".3"><ellipse cx="400" cy="345" rx="340" ry="100"/><ellipse cx="400" cy="345" rx="275" ry="80"/><path d="M0 490H800M0 540H800M130 600L340 380M670 600L460 380"/></g><g transform="translate(400 290)"><path d="M0-150L135-65L105 105L0 175L-105 105L-135-65Z" fill="url(#a)" stroke="#ffffff" stroke-width="3"/><path d="M0-150V35L135-65M0 35L105 105M0 35L-105 105M0 35L-135-65M0 35V175" fill="none" stroke="#ffffff" opacity=".6"/><circle cy="35" r="28" fill="#ffffff" opacity=".9"/></g></svg>`)).png().toBuffer();
  const upload = await f.creator.request('/api/uploads', undefined, { contentType:'image/png', raw:new Uint8Array(artwork) });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const data = physicalPool(7);
  return livePool(f, {
    ...data, name, description:'精選典藏展示。所有獎品、剩餘庫存與抽獎機率均由伺服器提供。', cover:upload.data.url,
    kind:free ? 'free' : 'paid', price:free ? 0 : 100,
    prizes:data.prizes.map(prize => ({ ...prize, name:'霓光收藏晶體', image:upload.data.url }))
  });
}

async function observe(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()); });
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.addInitScript(() => {
    (window as any).__visualCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      (window as any).__visualCspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
}

async function login(page: Page, f: Fixture, name: string) {
  await page.goto(f.origin);
  await page.getByRole('button', { name:'登入 / 註冊', exact:true }).click();
  await page.getByLabel('Email', { exact:true }).fill(`${name}@example.test`);
  await page.getByLabel('密碼', { exact:true }).fill(testPassword);
  await page.getByRole('button', { name:'登入', exact:true }).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  await expect(page.locator('.hero')).toBeVisible();
}

async function noOverflow(page: Page, label: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: viewport must not overflow horizontally`);
  const openDialog = page.locator('dialog[open]');
  if (await openDialog.count()) {
    assert.equal(await openDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${label}: dialog must not overflow horizontally`);
  }
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top:0, behavior:'instant' }));
  const modalOpen = await page.locator('dialog[open]').count() > 0;
  await page.screenshot({ path:`test-results/neon-${name}.png`, fullPage:!modalOpen, animations:'disabled' });
}

test('neon presentation: responsive routes, holographic interaction, reduced motion and single-transaction reveal', { timeout:150000 }, async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel:process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const errors: string[] = [];
  const pages: Page[] = [];
  try {
    const poolId = await visualPool(f, 'NEON VAULT · 霓虹典藏', '#a868ff');
    await visualPool(f, 'GOLDEN HOUR · 黑金收藏', '#f2bf60');
    await visualPool(f, 'FREE DROP · 今日驚喜', '#57e7ef', true);
    mkdirSync('test-results', { recursive:true });

    const desktop = await browser.newPage({ viewport:{ width:1440, height:1000 }, reducedMotion:'no-preference' });
    pages.push(desktop); await observe(desktop, errors); await login(desktop, f, 'player');
    await expect(desktop.locator('.mobileNav')).not.toBeVisible();
    await desktop.locator('.skipLink').focus();
    await desktop.keyboard.press('Enter');
    await expect(desktop.locator('#main-content')).toBeFocused();
    await expect(desktop.locator('.hero')).toBeVisible();
    const background = await desktop.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const components = background.match(/[\d.]+/g)?.map(Number) ?? [];
    const channels = components.slice(0, 3);
    assert.equal(channels.length, 3, 'Body has an explicit background color');
    assert.ok(components.length === 3 || components[3] >= 0.99, 'The body background is opaque');
    assert.ok(channels.every(channel => channel < 65), `Expected the dark visual theme, got ${background}`);
    await expect(desktop.locator('.launchCard')).toHaveCount(3);
    const holo = desktop.locator('.launchCard [data-holo], .launchCard[data-holo]').first();
    await expect(holo).toBeVisible();
    await holo.scrollIntoViewIfNeeded();
    const box = await holo.boundingBox(); assert.ok(box);
    await desktop.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.25);
    await expect.poll(() => holo.evaluate(element => (element as HTMLElement).style.getPropertyValue('--holo-x'))).not.toBe('');
    const start = await holo.evaluate(element => getComputedStyle(element).getPropertyValue('--holo-x'));
    await desktop.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.7);
    await expect.poll(() => holo.evaluate(element => getComputedStyle(element).getPropertyValue('--holo-x'))).not.toBe(start);
    assert.ok(await holo.evaluate(element => getComputedStyle(element).getPropertyValue('--holo-rx').trim().length > 0), 'Pointer tilt exposes a computed rotation');
    await desktop.mouse.move(5, 5);
    await desktop.getByRole('searchbox', { name:'搜尋獎池', exact:true }).fill('GOLDEN');
    await expect(desktop.locator('.launchCard:visible')).toHaveCount(1);
    await expect(desktop.locator('.launchCard:visible')).toContainText('GOLDEN HOUR');
    await desktop.getByRole('searchbox', { name:'搜尋獎池', exact:true }).fill('');
    await desktop.locator('[data-filter="free"]').click();
    await expect(desktop.locator('.launchCard:visible')).toHaveCount(1);
    await expect(desktop.locator('.launchCard:visible')).toContainText('FREE DROP');
    await desktop.locator('[data-filter="all"]').click();
    await expect(desktop.locator('.launchCard:visible')).toHaveCount(3);
    await noOverflow(desktop, 'desktop home'); await screenshot(desktop, 'home-desktop');

    await desktop.locator(`.launchCard [data-action="pool"][data-id="${poolId}"]`).click();
    await expect(desktop.getByRole('button', { name:'確認抽獎', exact:true })).toBeVisible();
    await noOverflow(desktop, 'desktop draw detail'); await screenshot(desktop, 'draw-desktop');
    let drawRequests = 0;
    desktop.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/pools/${poolId}/draw`) drawRequests++; });
    const balanceBefore = f.store.one('SELECT points FROM users WHERE id=?', f.ids.player)!.points;
    await desktop.getByRole('button', { name:'確認抽獎', exact:true }).click();
    await expect(desktop.getByRole('heading', { name:'抽獎結果', exact:true })).toBeVisible();
    await expect(desktop.locator('.drawReveal')).toBeVisible();
    await desktop.getByRole('button', { name:'立即揭曉', exact:true }).click();
    await expect(desktop.locator('.resultCard')).toHaveCount(1);
    await expect(desktop.locator('.resultCard')).toBeVisible();
    await screenshot(desktop, 'result-desktop');
    // Inspect the existing persisted transaction, rather than inferring success from animation.
    assert.equal(drawRequests, 1, 'One confirmed draw sends exactly one mutating request');
    assert.equal(f.store.one('SELECT COUNT(*) count FROM draws WHERE pool_id=? AND user_id=?', poolId, f.ids.player)!.count, 1);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?', f.ids.player)!.points, balanceBefore - 100);
    await desktop.getByRole('button', { name:'查看收藏', exact:true }).click();
    await expect(desktop.getByRole('heading', { name:'我的收藏', exact:true })).toBeVisible();
    assert.equal(drawRequests, 1, 'Opening the collection never repeats the draw');

    await desktop.setViewportSize({ width:820, height:1000 });
    await expect(desktop.locator('.avatar[data-page="account"]')).toBeVisible();
    await desktop.locator('.avatar[data-page="account"]').click();
    await expect(desktop.getByRole('heading', { name:'我的帳戶', exact:true })).toBeVisible();
    await noOverflow(desktop, '820px tablet account');
    await desktop.locator('.nav [data-page="home"]').click();
    await expect(desktop.locator('.hero')).toBeVisible();
    await noOverflow(desktop, '820px tablet home'); await screenshot(desktop, 'home-tablet-820');

    const mobile = await browser.newPage({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true, reducedMotion:'reduce' });
    pages.push(mobile); await observe(mobile, errors); await login(mobile, f, 'other');
    const mobileNav = mobile.locator('.mobileNav'); await expect(mobileNav).toBeVisible();
    assert.equal(await mobile.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await noOverflow(mobile, 'mobile home'); await screenshot(mobile, 'home-mobile');
    for (const [route, heading] of [['free','免費獎池'], ['collection','我的收藏'], ['creator','創作者中心'], ['account','我的帳戶']] as const) {
      await mobileNav.locator(`[data-page="${route}"]`).click();
      await expect(mobile.getByRole('heading', { name:new RegExp(`^${heading}`) })).toBeVisible();
      await noOverflow(mobile, `mobile ${route}`);
    }
    await mobileNav.locator('[data-page="home"]').click();
    await expect(mobile.locator('.hero')).toBeVisible();
    const moving = await mobile.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && Number(animation.effect?.getComputedTiming().endTime ?? 0) > 1).length);
    assert.equal(moving, 0, 'Reduced-motion preference suppresses continuous decorative animation');
    await mobile.locator(`.launchCard [data-action="pool"][data-id="${poolId}"]`).click();
    await expect(mobile.getByRole('button', { name:'確認抽獎', exact:true })).toBeVisible();
    await noOverflow(mobile, 'mobile draw detail'); await screenshot(mobile, 'draw-mobile');
    await mobile.getByRole('button', { name:'確認抽獎', exact:true }).click();
    await expect(mobile.locator('.resultCard')).toBeVisible();
    await expect(mobile.locator('.drawReveal')).toHaveCount(0);
    await noOverflow(mobile, 'mobile result'); await screenshot(mobile, 'result-mobile');
    await mobile.getByRole('button', { name:'查看收藏', exact:true }).click();
    await expect(mobile.getByRole('button', { name:'申請出貨', exact:true })).toBeVisible();
    await screenshot(mobile, 'collection-mobile');

    await mobile.setViewportSize({ width:320, height:740 });
    await mobileNav.locator('[data-page="home"]').click();
    await expect(mobile.locator('.hero')).toBeVisible();
    await noOverflow(mobile, '320px home'); await screenshot(mobile, 'home-mobile-320');
    await mobile.locator(`.launchCard [data-action="pool"][data-id="${poolId}"]`).click();
    await mobile.getByRole('combobox', { name:/^抽數/ }).selectOption('3');
    const multiBalanceBefore = f.store.one('SELECT points FROM users WHERE id=?', f.ids.other)!.points;
    await mobile.getByRole('button', { name:'確認抽獎', exact:true }).click();
    await expect(mobile.locator('.resultCard')).toHaveCount(3);
    await noOverflow(mobile, '320px three-draw result'); await screenshot(mobile, 'result-mobile-multi-320');
    assert.equal(f.store.one('SELECT COUNT(*) count FROM draws WHERE pool_id=? AND user_id=?', poolId, f.ids.other)!.count, 4);
    assert.equal(f.store.one('SELECT points FROM users WHERE id=?', f.ids.other)!.points, multiBalanceBefore - 300);
    await mobile.getByRole('button', { name:'查看收藏', exact:true }).scrollIntoViewIfNeeded();
    await expect(mobile.getByRole('button', { name:'查看收藏', exact:true })).toBeVisible();
    await screenshot(mobile, 'result-mobile-multi-bottom-320');
    await mobile.getByRole('button', { name:'查看收藏', exact:true }).click();
    await expect(mobile.locator('.collectionCard')).toHaveCount(4);

    const admin = await browser.newPage({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true, reducedMotion:'reduce' });
    pages.push(admin); await observe(admin, errors); await login(admin, f, 'admin');
    await admin.locator('.mobileNav [data-page="account"]').click();
    await expect(admin.getByRole('heading', { name:'我的帳戶', exact:true })).toBeVisible();
    await expect(admin.locator('[data-page="admin"]')).toHaveCount(0);
    await admin.goto(f.origin+'/admin/');
    await expect(admin.getByRole('heading', { name:'官方管理後台', exact:true })).toBeVisible();
    await noOverflow(admin, 'mobile admin'); await screenshot(admin, 'admin-mobile');

    for (const page of pages) assert.deepEqual(await page.evaluate(() => (window as any).__visualCspViolations), [], 'UI effects preserve Content Security Policy');
    assert.deepEqual(errors, [], 'No browser runtime or console errors');
  } finally { await browser.close(); await f.close(); }
});
