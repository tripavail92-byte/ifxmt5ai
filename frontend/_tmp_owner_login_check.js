const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'user3@ifxsystem.com';
const PASSWORD = 'Demo@ifx2026!';
const TERMS_VERSION = '2026-03-28-v1';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  await page.addInitScript((version) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', version);
  }, TERMS_VERSION);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(8000);
  console.log(JSON.stringify({ url: page.url(), body: ((await page.locator('body').textContent()) || '').slice(0, 800) }, null, 2));
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
