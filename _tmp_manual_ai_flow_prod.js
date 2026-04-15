const { chromium } = require('playwright');

const BASE_URL = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'user3@ifxsystem.com';
const PASSWORD = 'Demo@ifx2026!';
const CONNECTION_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
const SYMBOL = 'XAUUSDm';
const TERMS_VERSION = '2026-03-28-v1';

function extractLastNumber(text) {
  const matches = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}

function extractLabeledNumber(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`${escaped}\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i'));
  return match ? Number(match[1]) : null;
}

async function textOrNull(locator) {
  try {
    return await locator.textContent();
  } catch {
    return null;
  }
}

async function getBody(page) {
  return (await page.locator('body').textContent()) || '';
}

async function inputValueOrNull(locator) {
  try {
    return await locator.inputValue();
  } catch {
    return null;
  }
}

function numberInputs(page) {
  return page.locator('input[type="number"]');
}

function stopModeButton(page, label) {
  const matches = page.locator('button:visible').filter({ hasText: new RegExp(`^${label}$`) });
  return label === 'Manual' ? matches.nth(1) : matches.first();
}

async function waitForLotsValue(page, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await inputValueOrNull(page.locator('input[readonly]').first());
    if (value && value !== 'NaN' && Number.isFinite(Number(value)) && Number(value) > 0) {
      return value;
    }
    await page.waitForTimeout(300);
  }
  return await inputValueOrNull(page.locator('input[readonly]').first());
}

function logStep(message) {
  console.log(`[step] ${message}`);
}

async function waitForLiveQuote(page, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const bidText = await textOrNull(page.getByText(/^Bid$/).locator('..').first());
    const askText = await textOrNull(page.getByText(/^Ask$/).locator('..').first());
    const bid = extractLastNumber(bidText);
    const ask = extractLastNumber(askText);
    if (bid != null && ask != null) {
      return { bid, ask };
    }
    await page.waitForTimeout(1000);
  }
  return { bid: null, ask: null };
}

async function fetchQuoteFallback(page, connectionId, symbol) {
  try {
    return await page.evaluate(async ({ connectionId, symbol }) => {
      const resp = await fetch(`/api/symbol-spec?symbol=${encodeURIComponent(symbol)}&conn_id=${encodeURIComponent(connectionId)}`, { cache: 'no-store' });
      const data = await resp.json();
      const bid = Number(data?.bid);
      const ask = Number(data?.ask);
      return {
        bid: Number.isFinite(bid) && bid > 0 ? bid : null,
        ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      };
    }, { connectionId, symbol });
  } catch {
    return { bid: null, ask: null };
  }
}

async function signIn(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logStep(`open login${attempt > 1 ? ` retry ${attempt}` : ''}`);
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(8000 + (attempt - 1) * 4000);
    if (!/\/login(?:\?|$)/.test(page.url())) {
      return;
    }
  }

  throw new Error(`Login did not leave the login page. Current URL: ${page.url()}`);
}

(async () => {
  // Switch to headless: false for debugging if needed
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });

  await page.addInitScript((version) => {
    localStorage.setItem('ifx_terminal_terms_acceptance', version);
  }, TERMS_VERSION);

  const result = {
    manual: {},
    ai: {},
  };

  await signIn(page);
  logStep('open terminal attempt 1');
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });

  logStep('select connection and symbol');
  const selects = page.locator('select');
  // Wait for connection select to have options loaded (Railway cold start can take 60s)
  await page.waitForFunction(
    (connId) => {
      const els = document.querySelectorAll('select');
      if (!els.length) return false;
      const el = els[0];
      return el.options.length >= 1 && Array.from(el.options).some(o => o.value === connId);
    },
    CONNECTION_ID,
    { timeout: 60000 }
  );
  await selects.nth(0).selectOption(CONNECTION_ID);
  await page.waitForTimeout(3000);
  // Wait for symbol select to have options
  await page.waitForFunction(
    (sym) => {
      const els = document.querySelectorAll('select');
      if (els.length < 2) return false;
      return Array.from(els[1].options).some(o => o.value === sym);
    },
    SYMBOL,
    { timeout: 20000 }
  );
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(2500);
  logStep('wait for live quote');
  await waitForLiveQuote(page, 45000);

  const positionsTab = page.getByRole('button', { name: /Positions/i }).first();
  logStep('collect baseline positions');
  await positionsTab.click();
  await page.waitForTimeout(2000);
  const beforePositionsBody = await getBody(page);
  result.manual.openTradesBefore = extractLastNumber((beforePositionsBody.match(/Open Trades(\d+)/) || [])[1]);
  await page.getByRole('button', { name: /^AI$/ }).first().click();
  await page.waitForTimeout(1500);

  const manualBodyBefore = await getBody(page);
  let { bid, ask } = await waitForLiveQuote(page, 10000);
  if (bid == null || ask == null) {
    ({ bid, ask } = await fetchQuoteFallback(page, CONNECTION_ID, SYMBOL));
  }
  const fallbackEntry = extractLabeledNumber(manualBodyBefore, 'Entry');
  const fallbackLossEdge = extractLabeledNumber(manualBodyBefore, 'Loss Edge');
  result.manual.quote = {
    bid,
    ask,
    fallbackEntry,
    fallbackLossEdge,
  };

  logStep('manual trade setup');
  await page.getByRole('button', { name: /^SELL$/ }).first().click();
  await stopModeButton(page, 'Manual').click();
  await page.waitForTimeout(1200);
  let nums = numberInputs(page);
  const entryInput = nums.nth(0);
  const slInput = nums.nth(1);
  const tpInput = nums.nth(2);
  const riskPercentInput = nums.nth(3);
  const entryValue = bid ?? fallbackEntry;
  if (entryValue != null) {
    await entryInput.fill(String(entryValue));
  }
  const slValue = ask != null
    ? Number((ask + 5).toFixed(3))
    : fallbackLossEdge != null
      ? Number(fallbackLossEdge.toFixed(3))
      : null;
  if (slValue != null) {
    await slInput.fill(String(slValue));
  }
  await riskPercentInput.fill('0.01');
  result.manual.riskPercent = '0.01';
  await page.waitForTimeout(1200);

  result.manual.lotsDisplay = await waitForLotsValue(page);
  result.manual.tpDisplay = await inputValueOrNull(tpInput);
  result.manual.stopMode = 'manual';
  result.manual.side = 'sell';
  result.manual.sl = slValue;

  const queueButton = page.getByRole('button', { name: /Queue SELL Trade/i }).first();
  result.manual.queueButtonEnabled = await queueButton.isEnabled();
  if (await queueButton.isEnabled()) {
    logStep('queue manual trade');
    await queueButton.click();
    await page.waitForTimeout(4000);
  }

  const afterManualBody = await getBody(page);
  result.manual.afterQueue = {
    queuedMessage: /Trade queued for BTCUSDm/i.test(afterManualBody),
    hasExecutionBlocker: /Execution blocked:/i.test(afterManualBody),
    snippet: afterManualBody.slice(0, 6000),
  };

  await positionsTab.click();
  await page.waitForTimeout(4000);
  const positionsAfterManual = await getBody(page);
  result.manual.positionsAfter = {
    openTrades: extractLastNumber((positionsAfterManual.match(/Open Trades(\d+)/) || [])[1]),
    hasBtcInExecutionStream: /BTCUSDmSELL/i.test(positionsAfterManual) || /BTCUSDMSELL/i.test(positionsAfterManual),
    hasBtcPosition: /BTCUSDm(?:buy|sell)/i.test(positionsAfterManual),
    snippet: positionsAfterManual.slice(0, 6000),
  };

  logStep('ai trade-now setup');
  await page.getByRole('button', { name: /^AI$/ }).first().click();
  await page.waitForTimeout(1500);
  await selects.nth(1).selectOption(SYMBOL);
  await page.waitForTimeout(1500);

  let { bid: bid2, ask: ask2 } = await waitForLiveQuote(page, 15000);
  if (bid2 == null || ask2 == null) {
    ({ bid: bid2, ask: ask2 } = await fetchQuoteFallback(page, CONNECTION_ID, SYMBOL));
  }
  result.ai.quote = { bid: bid2, ask: ask2 };

  await page.getByRole('button', { name: /^SELL$/ }).first().click();
  await stopModeButton(page, 'AI Dynamic').click();
  await page.waitForTimeout(1000);
  const sliders = page.locator('input[type="range"]');
  if (await sliders.count() >= 2) {
    await sliders.nth(1).fill('1');
  }
  await page.waitForTimeout(1500);
  nums = numberInputs(page);
  const aiBodyBefore = await getBody(page);
  const aiFallbackEntry = extractLabeledNumber(aiBodyBefore, 'Entry');
  const aiEntryValue = bid2 ?? aiFallbackEntry;
  if (aiEntryValue != null) {
    await nums.nth(0).fill(String(aiEntryValue));
  }
  await page.waitForTimeout(1500);

  result.ai.dynamicPanelBefore = await textOrNull(page.getByText(/AI Dynamic SL/i).first().locator('..'));
  await page.getByRole('button', { name: /Monitor Zone|Update Monitor/i }).first().click();
  await page.waitForTimeout(3500);
  const tradeNowButton = page.getByRole('button', { name: /TRADE NOW|ARMED|Arming/i }).first();
  result.ai.tradeNowButtonBefore = await textOrNull(tradeNowButton);
  if (await tradeNowButton.isEnabled()) {
    logStep('arm trade now');
    await tradeNowButton.click();
    await page.waitForTimeout(3500);
  }
  result.ai.tradeNowButtonAfter = await textOrNull(tradeNowButton);

  const aiAfterArm = await getBody(page);
  result.ai.afterArm = {
    hasArmedBadge: /ARMED setup|ARMED/i.test(aiAfterArm),
    hasStalking: /Price in zone/i.test(aiAfterArm),
    dynamicMessage: /AI Dynamic SL is anchored/i.test(aiAfterArm),
    snippet: aiAfterArm.slice(0, 7000),
  };

  await positionsTab.click();
  await page.waitForTimeout(2500);
  let tradeTriggered = false;
  let latestPositionsText = await getBody(page);
  result.ai.positionsImmediately = {
    armedSetups: extractLastNumber((latestPositionsText.match(/Armed Setups(\d+)/) || [])[1]),
    hasWaitingBtc: /BTCUSDmsellSTALKINGWaiting for trigger/i.test(latestPositionsText) || /BTCUSDm.*Waiting for trigger/i.test(latestPositionsText),
  };

  for (let i = 0; i < 10; i += 1) {
    logStep(`monitor loop ${i + 1}`);
    await page.waitForTimeout(10000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: /Positions/i }).first().click();
    await page.waitForTimeout(2000);
    latestPositionsText = await getBody(page);
    const hasRecentBtcSell = /BTCUSDMSELL/i.test(latestPositionsText) || /BTCUSDmSELL/i.test(latestPositionsText);
    const armedGone = /Armed Setups0/i.test(latestPositionsText);
    if (hasRecentBtcSell || armedGone) {
      tradeTriggered = true;
      break;
    }
  }

  result.ai.monitor = {
    tradeTriggered,
    finalArmedSetups: extractLastNumber((latestPositionsText.match(/Armed Setups(\d+)/) || [])[1]),
    hasWaitingBtc: /BTCUSDm.*Waiting for trigger/i.test(latestPositionsText),
    hasRecentBtcSell: /BTCUSDMSELL/i.test(latestPositionsText) || /BTCUSDmSELL/i.test(latestPositionsText),
    finalSnippet: latestPositionsText.slice(0, 7000),
  };

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
