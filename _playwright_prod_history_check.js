const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = '200beae4-553b-4607-8653-8a15e5699865';
const SYMBOL = 'BTCUSDm';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });

  await page.addInitScript(() => {
    localStorage.setItem('ifx_chart_tf', 'M1');
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(5000);

  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first().selectOption(CONNECTION_ID);
  await page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first().selectOption(SYMBOL);
  await page.waitForTimeout(6000);

  const m1Active = await page.getByRole('button', { name: 'M1', exact: true }).first().getAttribute('class');
  const canvasCount = await page.locator('canvas').count();
  const firstCanvasBox = await page.locator('canvas').first().boundingBox();
  const bodyText = (await page.locator('body').textContent()) || '';

  await page.screenshot({ path: 'playwright-report/production-terminal-history-check.png', fullPage: true });

  console.log(JSON.stringify({
    m1Active,
    canvasCount,
    firstCanvasBox,
    hasLiveText: /BTCUSDm.*LIVE/i.test(bodyText),
    hasAiDynamic: bodyText.includes('AI Dynamic SL'),
    screenshot: 'playwright-report/production-terminal-history-check.png'
  }, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
