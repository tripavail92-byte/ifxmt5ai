// XAUUSDm arm_trade → manual_trade → close_position end-to-end validation
// User: user3@ifxsystem.com | Connection: c9fc4e21-f284-4c86-999f-ddedd5649734
const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'user3@ifxsystem.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'XAUUSDm';
const TERMS_VERSION = '2026-03-28-v1';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function getBody(page) {
  return (await page.locator('body').textContent()) || '';
}

async function tryText(locator) {
  try { return await locator.textContent(); } catch { return null; }
}

async function waitForBid(page, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await getBody(page);
    // XAUUSDm price is in the 3000-5500 range
    const m = body.match(/Bid\s*([\d.]+)/);
    if (m && Number(m[1]) > 1000) return Number(m[1]);
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
    await page.waitForTimeout(9000 + (attempt - 1) * 3000);
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
  await page.waitForTimeout(4000);

  const bid = await waitForBid(page, 40000);
  log('live bid: ' + bid);
  result.step1_arm.bid = bid;

  // AI tab
  await page.getByRole('button', { name: /^AI$/i }).first().click();
  await page.waitForTimeout(1500);

  // SELL side
  const sellBtn = page.getByRole('button', { name: /^SELL$/i }).first();
  if (await sellBtn.isVisible()) {
    await sellBtn.click();
    await page.waitForTimeout(800);
    log('clicked SELL');
  }

  // Entry price: bid + 30 (SELL zone above current price)
  const entryPrice = bid != null ? Number((bid + 30).toFixed(2)) : 4780;
  const numInputs = page.locator('input[type="number"]');
  const entryInput = numInputs.nth(0);
  await entryInput.evaluate((el, val) => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(entryPrice));
  await page.waitForTimeout(1200);
  log('entry filled: ' + entryPrice);
  result.step1_arm.entryFilled = entryPrice;

  // Monitor Zone
  const monitorBtn = page.getByRole('button', { name: /Monitor Zone|Update Monitor/i }).first();
  result.step1_arm.monitorBtnVisible = await monitorBtn.isVisible();
  if (await monitorBtn.isVisible()) {
    log('clicking Monitor Zone');
    await monitorBtn.click();
    await page.waitForTimeout(4000);
  }

  const bodyAfterMonitor = await getBody(page);
  result.step1_arm.afterMonitor = {
    hasStalking: /STALK|Price in zone/i.test(bodyAfterMonitor),
    snippet: bodyAfterMonitor.slice(0, 500),
  };
  log('after monitor, hasStalking=' + result.step1_arm.afterMonitor.hasStalking);

  // TRADE NOW
  const tradeNowBtn = page.getByRole('button', { name: /TRADE NOW|ARMED|Arming/i }).first();
  result.step1_arm.tradeNowBefore = await tryText(tradeNowBtn);
  const isTNEnabled = await tradeNowBtn.isEnabled().catch(() => false);
  log('TRADE NOW enabled: ' + isTNEnabled);
  if (isTNEnabled) {
    log('clicking TRADE NOW');
    await tradeNowBtn.click();
    await page.waitForTimeout(4000);
  }
  result.step1_arm.tradeNowAfter = await tryText(tradeNowBtn);

  const bodyAfterArm = await getBody(page);
  result.step1_arm.afterArm = {
    hasArmed: /ARMED/i.test(bodyAfterArm),
    hasAckBadge: /EA ack|acknowledged/i.test(bodyAfterArm),
  };
  log('after arm: hasArmed=' + result.step1_arm.afterArm.hasArmed + ' hasAck=' + result.step1_arm.afterArm.hasAckBadge);

  // ── STEP 2: manual_trade (0.01 lots via strategies page) ─────────────
  log('STEP 2: manual_trade — opening strategies page');
  await page.goto(`${BASE_URL}/strategies`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Click XAUUSDm symbol tab
  const xauTab = page.getByRole('button', { name: /XAUUSDm/i }).first();
  if (await xauTab.isVisible().catch(() => false)) {
    await xauTab.click();
    await page.waitForTimeout(2000);
    log('clicked XAUUSDm tab');
  } else {
    log('XAUUSDm tab not visible — checking body');
    const bodyStrat = await getBody(page);
    result.step2_manual.bodySnippet = bodyStrat.slice(0, 500);
  }

  // Sell direction
  const sellArrow = page.getByRole('button', { name: /▼ Sell|Sell/i }).first();
  if (await sellArrow.isVisible().catch(() => false)) {
    await sellArrow.click();
    await page.waitForTimeout(800);
    log('clicked ▼ Sell');
  }

  // Volume = 0.01
  const volumeInput = page.locator('input[name="volume"]');
  if (await volumeInput.isVisible().catch(() => false)) {
    await volumeInput.fill('0.01');
    log('volume filled 0.01');
  } else {
    const stratNums = page.locator('input[type="number"]');
    if (await stratNums.count() > 0) {
      await stratNums.first().fill('0.01');
      log('volume filled via nth(0)');
    }
  }

  // SL above bid (SELL = stop loss above entry), TP below
  const currentBid = bid != null ? bid : 4750;
  const slValue = Number((currentBid + 50).toFixed(2));
  const tpValue = Number((currentBid - 50).toFixed(2));

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

  const placeBtn = page.getByRole('button', { name: /Place Trade/i }).first();
  result.step2_manual.placeBtnEnabled = await placeBtn.isEnabled().catch(() => false);
  if (await placeBtn.isEnabled().catch(() => false)) {
    log('clicking Place Trade');
    await placeBtn.click();
    await page.waitForTimeout(6000);
  } else {
    log('Place Trade not enabled — capturing body');
    result.step2_manual.bodySnippet = (await getBody(page)).slice(0, 800);
  }

  const bodyAfterTrade = await getBody(page);
  result.step2_manual.afterPlace = {
    hasQueued: /queued|placed|order sent/i.test(bodyAfterTrade),
    hasError: /error|failed/i.test(bodyAfterTrade),
    hasTick: /tick_unavailable/i.test(bodyAfterTrade),
    snippet: bodyAfterTrade.slice(0, 1000),
  };
  log('after manual trade: hasQueued=' + result.step2_manual.afterPlace.hasQueued);

  // ── STEP 3: close_position ──────────────────────────────────────────
  log('STEP 3: close_position — back to terminal Positions tab');
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/i).first().waitFor({ state: 'visible', timeout: 60000 });

  const selects2 = page.locator('select');
  await selects2.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(2000);
  await selects2.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: /Positions/i }).first().click();
  await page.waitForTimeout(5000);

  const bodyPositions = await getBody(page);
  const execIdx = bodyPositions.indexOf('Execution Stream');
  result.step3_close.execStream = execIdx >= 0 ? bodyPositions.slice(execIdx, execIdx + 1500) : '(not found)';
  result.step3_close.positions = {
    hasXau: /XAUUSDm/i.test(bodyPositions),
    openTrades: (bodyPositions.match(/Open Trades(\d+)/) || ['', '?'])[1],
    snippet: bodyPositions.slice(bodyPositions.indexOf('Open Positions'), bodyPositions.indexOf('Open Positions') + 800),
  };
  log('positions hasXau: ' + result.step3_close.positions.hasXau + ' openTrades: ' + result.step3_close.positions.openTrades);

  const closeBtn = page.getByRole('button', { name: /^Close$/i }).first();
  result.step3_close.closeBtnVisible = await closeBtn.isVisible().catch(() => false);
  if (await closeBtn.isVisible().catch(() => false)) {
    log('clicking Close');
    await closeBtn.click();
    await page.waitForTimeout(6000);

    // Re-check positions after close
    const bodyAfterClose = await getBody(page);
    const execIdx2 = bodyAfterClose.indexOf('Execution Stream');
    result.step3_close.afterClose = {
      openTrades: (bodyAfterClose.match(/Open Trades(\d+)/) || ['', '?'])[1],
      xauGone: !/open.*XAUUSDm/i.test(bodyAfterClose.slice(bodyAfterClose.indexOf('Open Positions'), bodyAfterClose.indexOf('Open Positions') + 400)),
      execStream: execIdx2 >= 0 ? bodyAfterClose.slice(execIdx2, execIdx2 + 1000) : '(not found)',
    };
    log('after close: openTrades=' + result.step3_close.afterClose.openTrades);
  } else {
    log('Close button not visible');
    const allBtns = await page.getByRole('button').allTextContents();
    result.step3_close.allButtonTexts = allBtns;
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
