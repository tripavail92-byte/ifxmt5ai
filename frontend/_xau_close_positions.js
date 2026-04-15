// Close all open XAUUSDm positions via the frontend UI
const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'XAUUSDm';
const EMAIL = 'user3@ifxsystem.com';
const PASS = 'Demo@ifx2026!';

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  context.addCookies([{ name: 'ifx_terminal_terms_acceptance', value: '2026-03-28-v1', domain: 'ifx-mt5-portal-production.up.railway.app', path: '/' }]);
  const page = await context.newPage();

  // Login
  for (let attempt = 1; attempt <= 3; attempt++) {
    log('login attempt ' + attempt);
    await page.goto(BASE_URL + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASS);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(9000 + (attempt - 1) * 3000);
    if (!/\/login/.test(page.url())) { log('login ok, url=' + page.url()); break; }
  }
  if (/\/login/.test(page.url())) throw new Error('Login failed: ' + page.url());

  // Go to terminal
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 30000 });

  // Select connection and symbol
  const selects = page.locator('select');
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(1500);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(1500);

  // Click Positions tab
  await page.getByRole('button', { name: /Positions/i }).first().click();
  log('waiting 15s for SSE position data...');
  await page.waitForTimeout(15000);

  const getBody = async () => page.evaluate(() => document.body.innerText);

  let body = await getBody();
  log('open trades: ' + (body.match(/Open Trades(\d+)/)?.[1] ?? '?'));

  // Close all visible positions one by one
  let closed = 0;
  for (let i = 0; i < 10; i++) {
    const closeBtn = page.getByRole('button', { name: /^Close$/i }).first();
    if (!(await closeBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      log('no more Close buttons visible');
      break;
    }
    log('clicking Close #' + (i + 1));
    await closeBtn.click();
    await page.waitForTimeout(4000);
    closed++;
    body = await getBody();
    log('after close ' + (i + 1) + ': open trades=' + (body.match(/Open Trades(\d+)/)?.[1] ?? '?'));
  }

  log('total closed: ' + closed);

  // Wait for EA to process and confirm
  await page.waitForTimeout(3000);
  body = await getBody();
  const execIdx = body.indexOf('Execution Stream');
  const execSnippet = execIdx >= 0 ? body.slice(execIdx, execIdx + 1000) : '(not found)';
  const posIdx = body.indexOf('Open Positions');
  const posSnippet = posIdx >= 0 ? body.slice(posIdx, posIdx + 400) : '(not found)';

  console.log('\n=== FINAL STATE ===');
  console.log('Posts match:', JSON.stringify({ closed, execSnippet, posSnippet }, null, 2));

  await browser.close();
})().catch(err => { console.error('[FATAL]', err); process.exit(1); });
