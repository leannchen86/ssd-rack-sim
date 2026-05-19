// @ts-check
const { test, expect } = require('@playwright/test');

// Pick a representative gallery brick by drive id for stable selection
const SAMPLE_DRIVE = 'samsung-9100-pro-4tb';

const galleryBrick = (id) => `#stage .brick[data-drive-id="${id}"]`;
const placedBrick = `#baseplate .placed`;

// Real drag using pointer-down → move → up, crossing the 4px click threshold
async function dragFromTo(page, sourceLocator, targetX, targetY) {
  const box = await sourceLocator.boundingBox();
  if (!box) throw new Error('source has no bounding box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // First small move triggers the drag (crosses CLICK_THRESHOLD=4px)
  await page.mouse.move(startX + 20, startY + 20, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 10 });
  await page.mouse.up();
}

test.describe('Lego sandbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lego.html');
    await expect(page.locator('#stage .brick').first()).toBeVisible();
  });

  test('gallery renders all drives', async ({ page }) => {
    const count = await page.locator('#stage .brick').count();
    expect(count).toBeGreaterThanOrEqual(12);
  });

  test('click (no drag) opens the inspector panel', async ({ page }) => {
    await page.locator(galleryBrick(SAMPLE_DRIVE)).click();
    await expect(page.locator('#panel')).not.toHaveClass(/hidden-panel/);
    await expect(page.locator('#panelBody h2')).toContainText('Samsung 9100 Pro');
  });

  test('drag a gallery brick onto the baseplate places it', async ({ page }) => {
    await expect(page.locator(placedBrick)).toHaveCount(0);
    const base = await page.locator('#baseplate').boundingBox();
    if (!base) throw new Error('baseplate missing');
    await dragFromTo(
      page,
      page.locator(galleryBrick(SAMPLE_DRIVE)),
      base.x + 120,
      base.y + 100
    );
    await expect(page.locator(placedBrick)).toHaveCount(1);
    await expect(page.locator('#placedCount')).toContainText('1 brick placed');
  });

  test('snap aligns brick to the stud grid', async ({ page }) => {
    const base = await page.locator('#baseplate').boundingBox();
    if (!base) throw new Error('baseplate missing');
    // Drop deep inside so neither axis hits the clamp
    await dragFromTo(
      page,
      page.locator(galleryBrick(SAMPLE_DRIVE)),
      base.x + 300,
      base.y + 220
    );
    const placed = page.locator(placedBrick).first();
    await expect(placed).toBeVisible();
    const { left, top } = await placed.evaluate((el) => ({
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
    }));
    // baseplate stud centers sit at col*36 + 18; brick first-stud-offset = 26
    // → snapped left = col*36 - 8 (i.e. (left + 8) is a multiple of 36)
    expect(Math.round(left + 8) % 36).toBe(0);
    expect(Math.round(top + 8) % 36).toBe(0);
  });

  test('drag a placed brick off the baseplate removes it', async ({ page }) => {
    const base = await page.locator('#baseplate').boundingBox();
    if (!base) throw new Error('baseplate missing');
    await dragFromTo(
      page,
      page.locator(galleryBrick(SAMPLE_DRIVE)),
      base.x + 100,
      base.y + 100
    );
    await expect(page.locator(placedBrick)).toHaveCount(1);

    // Now drag the placed brick out of the baseplate (well above it)
    await dragFromTo(
      page,
      page.locator(placedBrick).first(),
      base.x + 100,
      base.y - 200
    );
    await expect(page.locator(placedBrick)).toHaveCount(0);
    await expect(page.locator('#placedCount')).toContainText('0 bricks placed');
  });

  test('clear button removes all placed bricks', async ({ page }) => {
    const base = await page.locator('#baseplate').boundingBox();
    if (!base) throw new Error('baseplate missing');
    await dragFromTo(
      page,
      page.locator(galleryBrick(SAMPLE_DRIVE)),
      base.x + 100,
      base.y + 100
    );
    await dragFromTo(
      page,
      page.locator(galleryBrick('kingston-a400-960gb')),
      base.x + 300,
      base.y + 150
    );
    await expect(page.locator(placedBrick)).toHaveCount(2);
    await page.locator('#clearBtn').click();
    await expect(page.locator(placedBrick)).toHaveCount(0);
  });

  test('Gen5 filter shows only Gen5 drives', async ({ page }) => {
    await page.locator('.chip', { hasText: /^Gen5$/ }).click();
    const cards = page.locator('#stage .brick');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    // Every visible brick should carry the gen5 color class
    for (let i = 0; i < n; i++) {
      await expect(cards.nth(i)).toHaveClass(/iface-gen5/);
    }
  });
});
