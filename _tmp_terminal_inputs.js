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
  await page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first().selectOption('200beae4-553b-4607-8653-8a15e5699865');
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, select, button'));
    return inputs.slice(0, 200).map((el, idx) => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      const prev = el.previousElementSibling ? (el.previousElementSibling.textContent || '').trim() : null;
      const parent = el.parentElement ? (el.parentElement.textContent || '').trim().slice(0, 120) : null;
      return {
        idx,
        tag: el.tagName,
        type: el.getAttribute('type'),
        value: el.getAttribute('value'),
        placeholder: el.getAttribute('placeholder'),
        text,
        prev,
        visible: rect.width > 0 && rect.height > 0,
        parent,
      };
    });
  });
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
