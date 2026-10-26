import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect, type Page } from '@playwright/test';
import { fixture, livePool, physicalPool } from './helpers.js';

process.env.QUIET_LOGS = 'true';

type Prize = { id: string; quantity: number; remaining: number };
type Pool = { total: number; remaining: number; status: string; prizes: Prize[] };

async function checkInitialOdds(page: Page, pool: Pool) {
  await expect(page.getByRole('heading', { name:'獎品與抽中機率', exact:true })).toBeVisible();
  for (const prize of pool.prizes) {
    const row = page.locator(`.miniPrize[data-prize-id="${prize.id}"]`);
    await expect(row.locator('.prizeOdds b')).toHaveText(`${(prize.quantity / pool.total * 100).toFixed(2)}%`);
    await expect(row.locator('.prizeOdds span')).toHaveText('抽中機率');
    await expect(row.locator('.prizeStock')).toHaveCount(0);
    await expect(row).not.toContainText('剩餘');
  }
}

test('initial odds stay fixed after real draws without dynamically displaying prize stock', { timeout:60000 }, async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel:process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const errors: string[] = [];
  try {
    const sample = physicalPool();
    const poolId = await livePool(f, {
      ...sample,
      name:'滿池初始機率回歸測試',
      prizes:[
        { ...sample.prizes[0], name:'限量典藏卡', quantity:1 },
        { ...sample.prizes[0], name:'精選收藏卡', quantity:3 }
      ]
    });
    const page = await browser.newPage({ viewport:{ width:1280, height:900 }, reducedMotion:'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    const openPool = async () => {
      await page.goto(f.origin);
      await page.locator(`.launchCard [data-action="pool"][data-id="${poolId}"]`).click();
    };
    const readPool = async (): Promise<Pool> => {
      const response = await f.player.request(`/api/pools/${poolId}`);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data as Pool;
    };

    let pool = await readPool();
    assert.equal(pool.total, 4);
    assert.deepEqual(pool.prizes.map(prize => prize.quantity).sort(), [1, 3]);
    await openPool();
    await checkInitialOdds(page, pool);

    // Stop as soon as either prize runs out. With quantities 1 and 3 this
    // always happens within three real draws, while the pool is still open.
    let draws = 0;
    while (pool.prizes.every(prize => prize.remaining > 0)) {
      assert.ok(draws < 3, 'A prize must be exhausted before the whole pool sells out');
      const result = await f.player.request(`/api/pools/${poolId}/draw`, { quantity:1 });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      draws++;
      pool = await readPool();
      await openPool();
      await checkInitialOdds(page, pool);
    }
    assert.equal(pool.status, 'live');
    assert.equal(pool.remaining, 4 - draws);
    assert.ok(pool.remaining > 0);
    const exhausted = pool.prizes.find(prize => prize.remaining === 0);
    assert.ok(exhausted, 'The regression includes an unavailable prize with a nonzero initial percentage');
    const exhaustedRow = page.locator(`.miniPrize[data-prize-id="${exhausted.id}"]`);
    await expect(exhaustedRow).toBeVisible();
    await expect(exhaustedRow.locator('.prizeStock')).toHaveCount(0);

    await page.setViewportSize({ width:320, height:740 });
    await checkInitialOdds(page, pool);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '320px viewport has no horizontal overflow');
    assert.equal(await page.locator('dialog[open]').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, '320px pool dialog has no horizontal overflow');
    for (const row of await page.locator('.miniPrize').all()) {
      assert.equal(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Prize details and fixed odds fit inside each 320px row');
    }
    assert.deepEqual(errors, [], 'No browser runtime errors');
  } finally {
    await browser.close();
    await f.close();
  }
});
