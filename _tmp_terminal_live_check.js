const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'BTCUSDm';
const TERMS_VERSION = '2026-03-28-v1';

function extractLastNumber(text) {
  const matches = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}

async function getBody(page) {
  return (await page.locator('body').textContent()) || '';
}

async function getQuoteSnapshot(page) {
  const bidText = await page.getByText(/^Bid$/).locator('..').first().textContent().catch(() => '');
  const askText = await page.getByText(/^Ask$/).locator('..').first().textContent().catch(() => '');
  return {
    bid: extractLastNumber(bidText),
    ask: extractLastNumber(askText),
    bidText: String(bidText || '').trim(),
    askText: String(askText || '').trim(),
  };
}

async function signIn(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !/\/login(?:\?|$)/.test(url.toString()), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });

  await page.addInitScript((version) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', version);
  }, TERMS_VERSION);

  await signIn(page);
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });

  const selects = page.locator('select');
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(3500);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(5000);

  const q1 = await getQuoteSnapshot(page);
  const body1 = await getBody(page);
  await page.waitForTimeout(5000);
  const q2 = await getQuoteSnapshot(page);
  const body2 = await getBody(page);

  const staleBanner1 = /Quote stale/i.test(body1);
  const staleBanner2 = /Quote stale/i.test(body2);
  const wsLive = /WebSocket live/i.test(body2);
  const connectionVisible = /260437559/i.test(body2);
  const quoteMoved = (q1.bid !== null && q2.bid !== null && q1.bid !== q2.bid) || (q1.ask !== null && q2.ask !== null && q1.ask !== q2.ask);

  const screenshot = 'playwright-report/private-terminal-live-check.png';
  await page.screenshot({ path: screenshot, fullPage: true });

  console.log(JSON.stringify({
    connectionId: CONNECTION_ID,
    symbol: SYMBOL,
    connectionVisible,
    wsLive,
    staleBanner1,
    staleBanner2,
    quoteMoved,
    first: q1,
    second: q2,
    screenshot,
    terminalUrl: page.url(),
  }, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
