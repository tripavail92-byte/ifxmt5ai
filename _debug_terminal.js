const { chromium } = require('playwright');

const BASE = 'https://ifx-mt5-portal-production.up.railway.app';
const EMAIL = 'testuser@ifxportal.com';
const PASSWORD = 'Demo@ifx2026!';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.addInitScript(() => {
    localStorage.setItem('ifx_terminal_terms_acceptance', '2026-03-28-v1');
  });

  // Login with retry
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`LOGIN attempt ${attempt}`);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    const waitMs = attempt === 1 ? 10000 : 15000;
    console.log(`waiting ${waitMs}ms ...`);
    await page.waitForTimeout(waitMs);
    const url = page.url();
    console.log(`post-login url: ${url}`);
    if (!url.includes('/login')) {
      console.log('LOGIN SUCCESS');
      break;
    }
  }

  console.log('goto terminal');
  await page.goto(`${BASE}/terminal`, { waitUntil: 'networkidle', timeout: 90000 });
  console.log(`terminal url: ${page.url()}`);

  // Wait a bit more for React hydration
  await page.waitForTimeout(5000);

  // Inspect all select elements
  const selects = await page.locator('select').all();
  console.log(`Found ${selects.length} select(s)`);
  for (let i = 0; i < selects.length; i++) {
    const opts = await selects[i].locator('option').evaluateAll(nodes =>
      nodes.map(n => ({ value: n.value, text: n.textContent }))
    );
    console.log(`Select[${i}] options:`, JSON.stringify(opts));
  }

  // Print page snippet
  const body = await page.locator('body').textContent();
  console.log('BODY SNIPPET:', body.slice(0, 500));

  await page.waitForTimeout(5000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
