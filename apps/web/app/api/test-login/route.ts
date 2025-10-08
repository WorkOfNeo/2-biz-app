import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export async function POST() {
  const BROWSERLESS_WS = process.env.BROWSERLESS_WS;
  const SPY_BASE_URL = process.env.SPY_BASE_URL;
  const SPY_USERNAME = process.env.SPY_USERNAME;
  const SPY_PASSWORD = process.env.SPY_PASSWORD;

  if (!BROWSERLESS_WS || !SPY_BASE_URL || !SPY_USERNAME || !SPY_PASSWORD) {
    return NextResponse.json({ ok: false, error: 'Missing env vars' }, { status: 500 });
  }

  let browser: import('playwright-core').Browser | null = null;
  let context: import('playwright-core').BrowserContext | null = null;
  let page: import('playwright-core').Page | null = null;
  try {
    const pwModule: any = await (Function('return import("playwright-core")')());
    const chromium = pwModule.chromium as typeof import('playwright-core').chromium;
    browser = await chromium.connectOverCDP(BROWSERLESS_WS);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(SPY_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const userSel = ['input#username', 'input[name="username"]', 'input[type="text"]'];
    const passSel = ['input#password', 'input[name="password"]', 'input[type="password"]'];
    const submitSel = ['button[type="submit"]', 'input[type="submit"]', '.btn-login'];

    const userInput = await firstLocator(page, userSel);
    const passInput = await firstLocator(page, passSel);
    if (!userInput || !passInput) throw new Error('Login inputs not found');
    await userInput.fill(SPY_USERNAME, { timeout: 30_000 });
    await passInput.fill(SPY_PASSWORD, { timeout: 30_000 });

    const submitBtn = await firstLocator(page, submitSel);
    if (submitBtn) {
      await submitBtn.click({ timeout: 30_000 });
    } else {
      await passInput.press('Enter', { timeout: 30_000 });
    }

    const markers = ['.dashboard', 'nav[aria-label="main"]', '.user-menu', '.logout', '[data-testid="main-shell"]'];
    const marker = await Promise.race(
      markers.map((m) => page!.waitForSelector(m, { timeout: 60_000 }).then(() => m).catch(() => null))
    );

    return NextResponse.json({ ok: true, marker });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

async function firstLocator(page: import('playwright-core').Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count > 0) return loc;
  }
  return null;
}


