const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';
const TERMS_VERSION = '2026-03-28-v1';

async function signIn(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !/\/login(?:\?|$)/.test(url.toString()), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
}

function extractLastNumber(text) {
  const matches = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}

async function getQuote(page) {
  const bidText = await page.getByText(/^Bid$/).locator('..').first().textContent().catch(() => '');
  const askText = await page.getByText(/^Ask$/).locator('..').first().textContent().catch(() => '');
  return {
    bid: extractLastNumber(bidText),
    ask: extractLastNumber(askText),
    bidText: String(bidText || '').trim(),
    askText: String(askText || '').trim(),
  };
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
  await page.waitForTimeout(8000);

  const body1 = (await page.locator('body').textContent()) || '';
  const selectInfo = await page.locator('select').evaluateAll((els) => els.map((el) => ({
    disabled: el.disabled,
    value: el.value,
    options: Array.from(el.options).map((opt) => ({ value: opt.value, text: opt.textContent || '', selected: opt.selected }))
  })));
  const q1 = await getQuote(page);
  await page.waitForTimeout(5000);
  const q2 = await getQuote(page);
  const body2 = (await page.locator('body').textContent()) || '';
  const screenshot = 'playwright-report/private-terminal-default-state.png';
  await page.screenshot({ path: screenshot, fullPage: true });

  console.log(JSON.stringify({
    terminalUrl: page.url(),
    has260437559: /260437559/.test(body2),
    has260352206: /260352206/.test(body2),
    hasGuestMarker: /guest|public terminal/i.test(body2),
    staleBanner: /Quote stale/i.test(body2),
    websocketLive: /WebSocket live/i.test(body2),
    quoteMoved: (q1.bid !== null && q2.bid !== null && q1.bid !== q2.bid) || (q1.ask !== null && q2.ask !== null && q1.ask !== q2.ask),
    firstQuote: q1,
    secondQuote: q2,
    selectInfo,
    screenshot,
    bodySnippet: body2.slice(0, 2500)
  }, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
