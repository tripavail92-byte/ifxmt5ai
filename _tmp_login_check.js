const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://ifx-mt5-portal-production.up.railway.app/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill('testuser@ifxportal.com');
  await page.getByLabel('Password').fill('Demo@ifx2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(8000);
  console.log(JSON.stringify({ url: page.url(), body: ((await page.locator('body').textContent()) || '').slice(0, 3000) }, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
