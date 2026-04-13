// arm_trade TRADE NOW validation for XAUUSDm
// Fills entry + SL → Monitor Zone → TRADE NOW → confirms arm_trade ack from EA
const { chromium } = require('playwright');

const BASE_URL   = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL      = 'user3@ifxsystem.com';
const PASSWORD   = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL     = 'XAUUSDm';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function getBody(page) { return (await page.locator('body').textContent()) || ''; }

// Fill a React-controlled number input by triggering React synthetic events
async function fillReactNumber(locator, value) {
  await locator.evaluate((el, val) => {
    const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    nativeInput?.set?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

async function waitForBid(page, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await getBody(page);
    const m = body.match(/Bid\s*([\d.]+)/);
    if (m && Number(m[1]) > 1000) return Number(m[1]);
    await page.waitForTimeout(1500);
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  context.addCookies([{
    name: 'ifx_terminal_terms_acceptance', value: '2026-03-28-v1',
    domain: 'ifx-mt5-portal-production.up.railway.app', path: '/'
  }]);
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`login attempt ${attempt}`);
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(9000 + (attempt - 1) * 3000);
    if (!/\/login/.test(page.url())) { log('login ok, url=' + page.url()); break; }
  }
  if (/\/login/.test(page.url())) throw new Error('Login failed: ' + page.url());

  // ── Navigate to terminal ───────────────────────────────────────────
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 30000 });

  const selects = page.locator('select');
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(1500);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(2000);
  log('terminal loaded, connection + symbol selected');

  // ── Open AI tab ────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^AI$/i }).first().click();
  await page.waitForTimeout(1500);

  // Read live bid
  const bid = await waitForBid(page, 40000);
  log('live bid: ' + bid);

  // SELL side
  await page.getByRole('button', { name: /^SELL$/i }).first().click();
  await page.waitForTimeout(800);

  // Entry = bid + 30 (SELL zone above current price — zone is set; TRADE NOW arms and waits)
  const entryPrice = bid != null ? Number((bid + 30).toFixed(2)) : 4780;
  const numInputs = page.locator('input[type="number"]');
  await fillReactNumber(numInputs.nth(0), entryPrice);
  await page.waitForTimeout(1200);
  log('entry filled: ' + entryPrice);

  // SL = entry + 20 (stop above entry for SELL — required for validStopLoss)
  const slPrice = Number((entryPrice + 20).toFixed(2));
  // The SL input is the second editable number input in the arm panel
  // (Lots is readOnly text, so does not count as type="number")
  await fillReactNumber(numInputs.nth(1), slPrice);
  await page.waitForTimeout(1200);
  log('sl filled: ' + slPrice);

  // Read TP (auto-derived from RR=2.5 → entry - stopDist*2.5)
  const body0 = await getBody(page);
  const rrMatch = body0.match(/TP.*?([\d.]+)/);
  log('body TP hint: ' + (rrMatch ? rrMatch[0].slice(0, 30) : '(none)'));

  // Check TRADE NOW state BEFORE Monitor Zone
  const tradeNowBtn = page.getByRole('button', { name: /TRADE NOW|ARMED|Arming/i }).first();
  const tnBeforeMonitor = await tradeNowBtn.isEnabled().catch(() => false);
  log('TRADE NOW enabled (before Monitor Zone): ' + tnBeforeMonitor);

  // ── Monitor Zone ──────────────────────────────────────────────────
  const monitorBtn = page.getByRole('button', { name: /Monitor Zone|Update Monitor/i }).first();
  if (await monitorBtn.isVisible()) {
    log('clicking Monitor Zone');
    await monitorBtn.click();
    await page.waitForTimeout(4000);
  }
  const bodyAfterMonitor = await getBody(page);
  const hasStalking = /STALK|Price in zone/i.test(bodyAfterMonitor);
  log('hasStalking after Monitor: ' + hasStalking);

  // ── TRADE NOW ────────────────────────────────────────────────────
  const tnAfterMonitor = await tradeNowBtn.isEnabled().catch(() => false);
  log('TRADE NOW enabled (after Monitor Zone): ' + tnAfterMonitor);

  let tradeNowClicked = false;
  if (tnAfterMonitor) {
    log('clicking TRADE NOW');
    await tradeNowBtn.click();
    await page.waitForTimeout(4000);
    tradeNowClicked = true;
  } else {
    const body1 = await getBody(page);
    // Capture any blocker message visible on screen
    const blockerMatch = body1.match(/Execution blocked[^.]*\.|Risk amount.*zero\.|Set a valid stop.*\.|Press Monitor Zone/);
    log('TRADE NOW still disabled — blocker: ' + (blockerMatch ? blockerMatch[0] : '(unknown)'));
  }

  const bodyAfterArm = await getBody(page);
  const hasArmed = /ARMED/i.test(bodyAfterArm);
  log('hasArmed: ' + hasArmed);

  // ── Wait for EA arm_trade ack ─────────────────────────────────────
  log('waiting 45s for EA poll cycle...');
  await page.waitForTimeout(45000);

  // Reload page to get fresh execution stream
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 30000 });
  await selects.nth(0).selectOption(CONNECTION_ID).catch(() => {});
  await page.waitForTimeout(1500);
  await selects.nth(1).selectOption(SYMBOL).catch(() => {});
  await page.waitForTimeout(3000);

  await page.getByRole('button', { name: /Positions/i }).first().click();
  await page.waitForTimeout(6000);

  const finalBody = await getBody(page);
  const execIdx = finalBody.indexOf('Execution Stream');
  const execSnippet = execIdx >= 0 ? finalBody.slice(execIdx, execIdx + 2000) : '(not found)';

  const armAcked = /trade_armed|arm_trade.*ack|Ack.*arm/i.test(execSnippet);
  const lastSeqMatch = execSnippet.match(/seq (\d+)/g);
  const lastSeq = lastSeqMatch ? lastSeqMatch[0] : '(none)';

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    bid,
    entryPrice,
    slPrice,
    tnBeforeMonitor,
    hasStalking,
    tnAfterMonitor,
    tradeNowClicked,
    hasArmed,
    armAcked,
    lastSeq,
    execSnippet: execSnippet.slice(0, 1500),
  }, null, 2));

  await browser.close();
})().catch(err => { console.error('[FATAL]', err); process.exit(1); });
