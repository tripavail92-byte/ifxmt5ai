const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
  await page.addInitScript(() => localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1'));
  await page.goto('https://ifx-mt5-portal-production.up.railway.app/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('Email').fill('testuser@ifxportal.com');
  await page.getByLabel('Password').fill('Demo@ifx2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/$|\?/, { timeout: 60000 }).catch(() => null);
  await page.getByText(/Dashboard/i).first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.goto('https://ifx-mt5-portal-production.up.railway.app/terminal', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(/IFX (Manual )?Terminal/).first().waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('select').first().selectOption('200beae4-553b-4607-8653-8a15e5699865');
  await page.waitForTimeout(2500);
  await page.locator('select').nth(1).selectOption('XAUUSDm');
  await page.waitForTimeout(1500);
  await page.locator('button').filter({ hasText: /^SELL$/ }).first().click();
  await page.locator('button').filter({ hasText: /^Manual$/ }).nth(1).click();
  await page.waitForTimeout(1500);
  const data = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, button'));
    return inputs.slice(35, 60).map((el, idx) => {
      const rect = el.getBoundingClientRect();
      return {
        idx: idx + 35,
        tag: el.tagName,
        type: el.getAttribute('type'),
        value: el.getAttribute('value'),
        text: (el.textContent || '').trim(),
        prev: el.previousElementSibling ? (el.previousElementSibling.textContent || '').trim() : null,
        visible: rect.width > 0 && rect.height > 0,
        readOnly: el.readOnly || false,
        disabled: el.disabled || false,
        parent: el.parentElement ? (el.parentElement.textContent || '').trim().slice(0, 140) : null,
      };
    });
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
