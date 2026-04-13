// Quick follow-up: check execution stream + positions to see if seq 8 was acked and close was sent
const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'user3@ifxsystem.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'BTCUSDm';
const TERMS_VERSION = '2026-03-28-v1';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  await page.addInitScript((v) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', v);
  }, TERMS_VERSION);

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(9000 + (attempt - 1) * 3000);
    if (!/\/login/.test(page.url())) break;
  }
  console.log('url after login:', page.url());

  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 60000 });
  const selects = page.locator('select');
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(2500);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(3000);

  await page.getByRole('button', { name: /Positions/i }).first().click();
  await page.waitForTimeout(4000);

  const body = (await page.locator('body').textContent()) || '';

  // Extract execution stream section
  const execIdx = body.indexOf('Execution Stream');
  const execSnip = execIdx >= 0 ? body.slice(execIdx, execIdx + 3000) : '(not found)';

  // Extract positions section
  const posIdx = body.indexOf('Open Positions');
  const posSnip = posIdx >= 0 ? body.slice(posIdx, posIdx + 1000) : '(not found)';

  console.log('\n=== POSITIONS ===');
  console.log(posSnip);
  console.log('\n=== EXECUTION STREAM ===');
  console.log(execSnip);

  // Look for specific signals
  console.log('\n=== KEY CHECKS ===');
  console.log('seq 8 acknowledged:', /seq 8.*acknowledged|BTCUSDMSELL.*acknowledged/i.test(body));
  console.log('seq 9 (close) present:', /seq 9/i.test(body));
  console.log('close_position command:', /close_position/i.test(body));
  console.log('BTCUSDm in positions:', /BTCUSDm/i.test(posSnip));
  console.log('open trades count:', (body.match(/Open Trades(\d+)/) || ['', '?'])[1]);
  console.log('armed setups count:', (body.match(/Armed Setups(\d+)/) || ['', '?'])[1]);

  await browser.close();
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
