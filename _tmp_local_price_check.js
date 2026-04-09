const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:3000';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = '200beae4-553b-4607-8653-8a15e5699865';
const SYMBOL = 'XAUUSDm';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  await page.addInitScript(() => {
    localStorage.setItem('ifx_chart_tf', 'M1');
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/$|\?/, { timeout: 30000 });

  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });

  await page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first().selectOption(CONNECTION_ID);
  await page.waitForTimeout(1500);
  await page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first().selectOption(SYMBOL);
  await page.waitForTimeout(5000);

  const tab = page.getByRole('button', { name: new RegExp(`^${SYMBOL}\\s`) }).first();
  const body1 = (await page.locator('body').textContent()) || '';
  const tabText1 = (await tab.textContent()) || '';
  await page.waitForTimeout(6000);
  const body2 = (await page.locator('body').textContent()) || '';
  const tabText2 = (await tab.textContent()) || '';

  const extractPrice = (value) => {
    const matches = String(value || '').match(/\d+(?:\.\d+)?/g);
    return matches ? matches[matches.length - 1] : null;
  };

  const price1 = extractPrice(tabText1);
  const price2 = extractPrice(tabText2);

  console.log(JSON.stringify({
    tabText1,
    tabText2,
    price1,
    price2,
    changed: price1 !== price2,
    live1: /LIVE/i.test(body1),
    live2: /LIVE/i.test(body2),
    connecting1: /connecting/i.test(body1),
    connecting2: /connecting/i.test(body2)
  }, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
