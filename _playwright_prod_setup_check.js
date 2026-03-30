const { chromium } = require('playwright');

const BASE = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = '91f30180-22a2-4536-a805-4f16250e2b17';
const SYMBOL = 'BTCUSDm';

(async () => {
  console.log('launch');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });

  await page.addInitScript(() => {
    localStorage.setItem('ifx_chart_tf', 'M1');
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  console.log('goto login');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  console.log('submit login');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(5000);
  console.log('post-login url', page.url());
  console.log('post-login body', ((await page.locator('body').textContent()) || '').slice(0, 400));

  console.log('goto terminal');
  await page.goto(`${BASE}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('terminal url', page.url());
  console.log('terminal body', ((await page.locator('body').textContent()) || '').slice(0, 400));
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });

  console.log('select connection');
  const connectionSelect = page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first();
  const connectionOptions = await connectionSelect.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, text: node.textContent }))
  );
  console.log('connection options', JSON.stringify(connectionOptions, null, 2));
  const targetConnection = connectionOptions.find((option) => option.value === CONNECTION_ID)?.value
    ?? connectionOptions.find((option) => option.value)?.value;
  if (targetConnection) {
    await connectionSelect.selectOption(targetConnection);
  }

  console.log('select symbol');
  const symbolSelect = page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first();
  const symbolOptions = await symbolSelect.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, text: node.textContent }))
  );
  console.log('symbol options sample', JSON.stringify(symbolOptions.slice(0, 10), null, 2));
  const targetSymbol = symbolOptions.find((option) => option.value === SYMBOL)?.value
    ?? symbolOptions.find((option) => option.value)?.value;
  if (targetSymbol) {
    await symbolSelect.selectOption(targetSymbol);
  }

  console.log('wait terminal');
  await page.waitForTimeout(7000);

  const bodyText = (await page.locator('body').textContent()) || '';
  const screenshot = 'playwright-report/production-terminal-setup-state-check.png';
  console.log('screenshot');
  await page.screenshot({ path: screenshot, fullPage: true });

  console.log(JSON.stringify({
    hasTradeAutomation: bodyText.includes('Trade Automation'),
    hasTradeNow: bodyText.includes('TRADE NOW'),
    hasStalking: bodyText.includes('STALKING'),
    hasUpdateMonitor: bodyText.includes('UPDATE MONITOR'),
    screenshot,
  }, null, 2));

  console.log('done');
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
