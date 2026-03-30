const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.addInitScript(() => {
    localStorage.setItem('ifx_chart_tf', 'M1');
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('testuser@ifxportal.com');
  await page.getByLabel('Password').fill('Demo@ifx2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/$|\?/, { timeout: 30000 });

  await page.goto('http://localhost:3000/terminal', { waitUntil: 'networkidle' });
  await page.locator('//label[contains(., "Connection")]/following-sibling::select[1]').first().selectOption('200beae4-553b-4607-8653-8a15e5699865');
  await page.locator('//label[contains(., "Symbol")]/following-sibling::select[1]').first().selectOption('BTCUSDm');
  await page.waitForTimeout(1500);

  const input = page.locator('div:has(> label:text-is("Entry Price")) input:visible').first();
  console.log('entry count', await page.locator('div:has(> label:text-is("Entry Price")) input').count());
  console.log('entry visible count', await page.locator('div:has(> label:text-is("Entry Price")) input:visible').count());
  console.log('entry html', await input.evaluate((el) => el.outerHTML));

  await input.evaluate((element, nextValue) => {
    const input = element;
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(input, nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, '66628.15');

  await page.waitForTimeout(1000);
  console.log('entry inputValue', await input.inputValue());
  console.log('suggested zone count', await page.getByText('Suggested Entry Zone').count());
  console.log('body contains zone', await page.locator('body').textContent().then(t => t.includes('Suggested Entry Zone')));

  await browser.close();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
