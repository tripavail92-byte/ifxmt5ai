import { test, expect } from '@playwright/test';

test.setTimeout(120000);

const BASE_URL = process.env.PW_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.PW_EMAIL ?? 'testuser@ifxportal.com';
const PASSWORD = process.env.PW_PASSWORD ?? 'Demo@ifx2026!';
const CONNECTION_ID = process.env.PW_CONN_ID ?? '200beae4-553b-4607-8653-8a15e5699865';
const SYMBOL = process.env.PW_SYMBOL ?? 'BTCUSDm';

async function primeTerminalPrefs(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('ifx_chart_tf', 'M1');
    window.localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });
}

async function setControlValue(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const prototype = input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(input, nextValue as string);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function expectBodyText(page: import('@playwright/test').Page, text: string | RegExp, timeout = 15000) {
  await expect
    .poll(async () => (await page.locator('body').textContent()) ?? '', { timeout })
    .toMatch(text instanceof RegExp ? text : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/($|\?)/, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}

test.describe.serial('local terminal demo checks', () => {
  test('charts, history, structure, risk controls and demo trade queue', async ({ page, request }) => {
    await primeTerminalPrefs(page);
    await login(page);

    await page.goto(`${BASE_URL}/terminal`, { waitUntil: 'networkidle' });
    await expect(page.getByText(/IFX (Manual )?Terminal/).first()).toBeVisible({ timeout: 30000 });

    const connectionSelect = page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first();
    await connectionSelect.selectOption(CONNECTION_ID);
    await page.waitForLoadState('networkidle');

    const symbolSelect = page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first();
    await symbolSelect.selectOption(SYMBOL);
    await page.waitForTimeout(1500);

    const m1Button = page.getByRole('button', { name: 'M1', exact: true }).first();
    await expect(m1Button).toBeVisible({ timeout: 15000 });
    await expect(m1Button).toHaveClass(/bg-orange-500/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: new RegExp(`^${SYMBOL}\\s`) }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(new RegExp(`${SYMBOL}.*(LIVE|loading)`, 'i')).first()).toBeVisible({ timeout: 15000 });

    const candlesResp = await request.get(`${BASE_URL}/api/candles?symbol=${encodeURIComponent(SYMBOL)}&tf=1m&count=20&conn_id=${encodeURIComponent(CONNECTION_ID)}`);
    expect(candlesResp.ok()).toBeTruthy();
    const candlesJson = await candlesResp.json();
    expect(candlesJson.count).toBeGreaterThanOrEqual(20);
    expect(Array.isArray(candlesJson.bars)).toBeTruthy();

    const lastBar = candlesJson.bars[candlesJson.bars.length - 1];
    expect(lastBar).toBeTruthy();
    const entryPrice = String(lastBar.c);

    await expectBodyText(page, /Risk settings sync|local ready|server \+ local saved/i, 15000);

    const entryInput = page.locator('div:has(> label:text-is("Entry Price")) input:visible').first();
    await setControlValue(entryInput, entryPrice);

    await expectBodyText(page, 'Suggested Entry Zone', 10000);

    await page.getByRole('button', { name: 'AI Dynamic' }).first().click();
    await expectBodyText(page, 'AI Dynamic SL', 15000);
    await expectBodyText(page, /Pivot window: 5/, 15000);

    const aiSensitivitySlider = page.locator('input[type="range"].accent-yellow-500:visible').first();
    await setControlValue(aiSensitivitySlider, '9');
    await expectBodyText(page, /pivot window = 9/i, 10000);
    await expectBodyText(page, /Pivot window: 9/, 15000);

    const maxLotInput = page.locator('div:has(> label:text-is("Max Lot Size")) input:visible').first();
    await setControlValue(maxLotInput, '0.001');
    await expectBodyText(page, /Execution blocked: Lot size/i, 10000);

    await setControlValue(maxLotInput, '0');
    await expect(page.getByText(/Execution blocked: Lot size/i)).toHaveCount(0, { timeout: 10000 });

    await page.getByRole('button', { name: 'Setup' }).first().click();
    await page.getByRole('button', { name: 'BUY' }).first().click();

    const queueButton = page.getByRole('button', { name: /Queue BUY Trade/i }).first();
    await queueButton.click();
    await expectBodyText(page, new RegExp(`Trade queued for ${SYMBOL}`, 'i'), 20000);

    await page.getByRole('button', { name: /Positions/i }).first().click();
    await expectBodyText(page, 'Runtime Account Snapshot', 15000);
    await expectBodyText(page, 'Execution Stream', 15000);
  });
});
