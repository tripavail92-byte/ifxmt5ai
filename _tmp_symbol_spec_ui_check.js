const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'EURUSD';
const TERMS_VERSION = '2026-03-28-v1';

async function signIn(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !/\/login(?:\?|$)/.test(url.toString()), { timeout: 60000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  await page.addInitScript((version) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', version);
  }, TERMS_VERSION);

  let symbolSpecResponse = null;
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/symbol-spec?')) return;
    try {
      symbolSpecResponse = {
        url,
        status: response.status(),
        body: await response.text(),
      };
    } catch (err) {
      symbolSpecResponse = {
        url,
        status: response.status(),
        body: `response read failed: ${String(err)}`,
      };
    }
  });

  try {
    await signIn(page);
    await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });

    const selects = page.locator('select');
    await selects.nth(0).selectOption(CONNECTION_ID);
    await page.waitForTimeout(2500);
    await selects.nth(1).selectOption(SYMBOL);
    await page.waitForTimeout(6000);

    const pageText = (await page.locator('body').textContent()) || '';
    const selectedValue = await selects.nth(1).inputValue();
    const selectedLabel = await selects.nth(1).locator('option:checked').textContent();
    console.log(JSON.stringify({
      symbolSpecResponse,
      requestedSymbol: SYMBOL,
      selectedValue,
      selectedLabel,
      uiHas503Text: /503/.test(pageText),
      uiHasServiceUnavailable: /service unavailable/i.test(pageText),
      title: await page.title(),
      terminalUrl: page.url(),
    }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});