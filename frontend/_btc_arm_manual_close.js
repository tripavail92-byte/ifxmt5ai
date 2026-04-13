// BTCUSDm arm_trade → manual_trade → close_position end-to-end validation
// User: user3@ifxsystem.com | Connection: c9fc4e21-f284-4c86-999f-ddedd5649734
const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'user3@ifxsystem.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'BTCUSDm';
const TERMS_VERSION = '2026-03-28-v1';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function getBody(page) {
  return (await page.locator('body').textContent()) || '';
}

async function tryText(locator) {
  try { return await locator.textContent(); } catch { return null; }
}

async function tryInputValue(locator) {
  try { return await locator.inputValue(); } catch { return null; }
}

async function waitForBid(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await getBody(page);
    const m = body.match(/Bid\s*([\d.]+)/);
    if (m && Number(m[1]) > 0) return Number(m[1]);
    await page.waitForTimeout(1500);
  }
  return null;
}

async function signIn(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`login attempt ${attempt}`);
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(8000 + (attempt - 1) * 3000);
    if (!/\/login/.test(page.url())) { log('login ok, url=' + page.url()); return; }
  }
  throw new Error('Login failed, still on: ' + page.url());
}

(async () => {
  const result = { step1_arm: {}, step2_manual: {}, step3_close: {} };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });

  await page.addInitScript((v) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', v);
  }, TERMS_VERSION);

  // ── SIGN IN ──────────────────────────────────────────────────────────
  await signIn(page);

  // ── STEP 1: arm_trade ────────────────────────────────────────────────
  log('STEP 1: arm_trade — opening terminal');
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 60000 });
  log('terminal loaded');

  const selects = page.locator('select');
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(3000);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(3000);

  const bid = await waitForBid(page, 40000);
  log('live bid: ' + bid);
  result.step1_arm.bid = bid;

  // Switch to AI tab
  await page.getByRole('button', { name: /^AI$/i }).first().click();
  await page.waitForTimeout(1500);

  // Pick SELL side
  const sellBtn = page.getByRole('button', { name: /^SELL$/i }).first();
  if (await sellBtn.isVisible()) {
    await sellBtn.click();
    await page.waitForTimeout(800);
    log('clicked SELL');
  }

  // Fill entry price (slightly above bid for SELL zone)
  const entryPrice = bid != null ? Number((bid + 200).toFixed(2)) : 71200;
  const numInputs = page.locator('input[type="number"]');
  const entryInput = numInputs.nth(0);
  await entryInput.evaluate((el, val) => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(entryPrice));
  await page.waitForTimeout(1000);
  log('entry filled: ' + entryPrice);
  result.step1_arm.entryFilled = entryPrice;

  // Monitor Zone
  const monitorBtn = page.getByRole('button', { name: /Monitor Zone|Update Monitor/i }).first();
  result.step1_arm.monitorBtnVisible = await monitorBtn.isVisible();
  if (await monitorBtn.isVisible()) {
    log('clicking Monitor Zone');
    await monitorBtn.click();
    await page.waitForTimeout(3500);
  }

  const bodyAfterMonitor = await getBody(page);
  result.step1_arm.afterMonitor = {
    hasStalking: /STALK|Price in zone/i.test(bodyAfterMonitor),
    snippet: bodyAfterMonitor.slice(0, 2000),
  };
  log('after monitor, hasStalking=' + result.step1_arm.afterMonitor.hasStalking);

  // TRADE NOW / ARMED
  const tradeNowBtn = page.getByRole('button', { name: /TRADE NOW|ARMED|Arming/i }).first();
  result.step1_arm.tradeNowBefore = await tryText(tradeNowBtn);
  const isTNEnabled = await tradeNowBtn.isEnabled().catch(() => false);
  if (isTNEnabled) {
    log('clicking TRADE NOW');
    await tradeNowBtn.click();
    await page.waitForTimeout(4000);
  } else {
    log('TRADE NOW not enabled, skipping arm click');
  }
  result.step1_arm.tradeNowAfter = await tryText(tradeNowBtn);

  const bodyAfterArm = await getBody(page);
  result.step1_arm.afterArm = {
    hasArmed: /ARMED|armed/i.test(bodyAfterArm),
    hasAckBadge: /EA ack|acknowledged/i.test(bodyAfterArm),
    snippet: bodyAfterArm.slice(0, 3000),
  };
  log('after arm: hasArmed=' + result.step1_arm.afterArm.hasArmed + ' hasAck=' + result.step1_arm.afterArm.hasAckBadge);

  // ── STEP 2: manual_trade (0.01 lots via strategies page) ─────────────
  log('STEP 2: manual_trade — opening strategies page');
  await page.goto(`${BASE_URL}/strategies`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const bodyStrat = await getBody(page);
  result.step2_manual.pageLoaded = bodyStrat.length > 100;
  result.step2_manual.hasBtcTab = /BTCUSDm/i.test(bodyStrat);

  // Click BTCUSDm symbol tab
  const btcTab = page.getByRole('button', { name: /BTCUSDm/i }).first();
  if (await btcTab.isVisible().catch(() => false)) {
    await btcTab.click();
    await page.waitForTimeout(2000);
    log('clicked BTCUSDm tab');
  }

  // Click Sell direction
  const sellArrow = page.getByRole('button', { name: /▼ Sell|Sell/i }).first();
  if (await sellArrow.isVisible().catch(() => false)) {
    await sellArrow.click();
    await page.waitForTimeout(800);
    log('clicked ▼ Sell');
  }

  // Fill volume = 0.01 lots
  const volumeInput = page.locator('input[name="volume"]');
  if (await volumeInput.isVisible().catch(() => false)) {
    await volumeInput.fill('0.01');
    await page.waitForTimeout(500);
    log('volume filled 0.01');
  } else {
    log('volume input not visible, checking numbered inputs');
    const stratNums = page.locator('input[type="number"]');
    const count = await stratNums.count();
    log('number inputs count: ' + count);
    if (count > 0) {
      await stratNums.first().fill('0.01');
      await page.waitForTimeout(500);
    }
  }

  // Fill SL (bid + 500 for SELL = stop above current price)
  const currentBid = bid != null ? bid : 71000;
  const slValue = Number((currentBid + 500).toFixed(2));
  const tpValue = Number((currentBid - 500).toFixed(2));
  const slInput = page.locator('input[name="sl"]');
  const tpInput = page.locator('input[name="tp"]');
  if (await slInput.isVisible().catch(() => false)) {
    await slInput.fill(String(slValue));
    log('sl filled ' + slValue);
  }
  if (await tpInput.isVisible().catch(() => false)) {
    await tpInput.fill(String(tpValue));
    log('tp filled ' + tpValue);
  }

  result.step2_manual.slFilled = slValue;
  result.step2_manual.tpFilled = tpValue;

  // Click Place Trade
  const placeBtn = page.getByRole('button', { name: /Place Trade/i }).first();
  result.step2_manual.placeBtnEnabled = await placeBtn.isEnabled().catch(() => false);
  if (await placeBtn.isEnabled().catch(() => false)) {
    log('clicking Place Trade');
    await placeBtn.click();
    await page.waitForTimeout(5000);
  } else {
    log('Place Trade not enabled');
  }

  const bodyAfterTrade = await getBody(page);
  result.step2_manual.afterPlace = {
    hasQueued: /queued|placed|order sent/i.test(bodyAfterTrade),
    hasError: /error|failed/i.test(bodyAfterTrade),
    snippet: bodyAfterTrade.slice(0, 3000),
  };
  log('after manual trade: hasQueued=' + result.step2_manual.afterPlace.hasQueued);

  // ── STEP 3: close_position ──────────────────────────────────────────
  log('STEP 3: close_position — back to terminal Positions tab');
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 60000 });

  // Re-select connection and symbol
  const selects2 = page.locator('select');
  await selects2.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(2000);
  await selects2.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(2000);

  // Click Positions tab
  await page.getByRole('button', { name: /Positions/i }).first().click();
  await page.waitForTimeout(4000);

  const bodyPositions = await getBody(page);
  result.step3_close.positions = {
    hasBtc: /BTCUSDm/i.test(bodyPositions),
    snippet: bodyPositions.slice(0, 3000),
  };
  log('positions has btc: ' + result.step3_close.positions.hasBtc);

  // Find and click Close button for BTCUSDm position
  const closeBtn = page.getByRole('button', { name: /^Close$/i }).first();
  result.step3_close.closeBtnVisible = await closeBtn.isVisible().catch(() => false);
  if (await closeBtn.isVisible().catch(() => false)) {
    log('clicking Close');
    await closeBtn.click();
    await page.waitForTimeout(5000);
  } else {
    log('Close button not visible - checking all close-like buttons');
    const allBtns = await page.getByRole('button').allTextContents();
    result.step3_close.allButtonTexts = allBtns;
    log('all buttons: ' + JSON.stringify(allBtns));
  }

  const bodyAfterClose = await getBody(page);
  result.step3_close.afterClose = {
    btcGone: !/BTCUSDm/i.test(bodyAfterClose),
    hasAck: /EA ack|acknowledged|close/i.test(bodyAfterClose),
    snippet: bodyAfterClose.slice(0, 3000),
  };
  log('after close: btcGone=' + result.step3_close.afterClose.btcGone);

  // ── FINAL RESULT ─────────────────────────────────────────────────────
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
