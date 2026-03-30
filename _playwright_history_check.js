const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });

  await page.addInitScript(() => {
    localStorage.setItem('ifx_chart_tf', 'M1');
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('testuser@ifxportal.com');
  await page.getByLabel('Password').fill('Demo@ifx2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/$|\?/, { timeout: 30000 });

  await page.goto('http://localhost:3000/terminal', { waitUntil: 'networkidle' });
  await page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first().selectOption('200beae4-553b-4607-8653-8a15e5699865');
  await page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first().selectOption('BTCUSDm');
  await page.waitForTimeout(5000);

  const canvasCount = await page.locator('canvas').count();
  const firstCanvasBox = await page.locator('canvas').first().boundingBox();
  const bodyText = (await page.locator('body').textContent()) || '';

  await page.screenshot({ path: 'playwright-report/terminal-history-check.png', fullPage: true });

  console.log(JSON.stringify({
    canvasCount,
    firstCanvasBox,
    hasSuggestedEntryZone: bodyText.includes('Suggested Entry Zone'),
    hasLiveText: /BTCUSDm.*LIVE/i.test(bodyText),
    screenshot: 'playwright-report/terminal-history-check.png'
  }, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
