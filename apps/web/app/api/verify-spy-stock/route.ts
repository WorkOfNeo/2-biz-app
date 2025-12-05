import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes timeout

type SpyStockRow = {
  styleNo: string;
  styleName: string;
  stock: number;
};

async function scrapeSpyStock(): Promise<SpyStockRow[]> {
  const BROWSERLESS_WS = process.env.BROWSERLESS_WS;
  const SPY_BASE_URL = process.env.SPY_BASE_URL;
  const SPY_USERNAME = process.env.SPY_USERNAME;
  const SPY_PASSWORD = process.env.SPY_PASSWORD;

  if (!BROWSERLESS_WS || !SPY_BASE_URL || !SPY_USERNAME || !SPY_PASSWORD) {
    throw new Error('Missing required environment variables (BROWSERLESS_WS, SPY_BASE_URL, SPY_USERNAME, SPY_PASSWORD)');
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    // Connect to browser
    browser = await chromium.connect(BROWSERLESS_WS, { timeout: 30000 });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    page = await context.newPage();

    // Login first
    await page.goto(SPY_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    const usernameField = page.locator('input[name="strUsername"], input#strUsername');
    const passwordField = page.locator('input[name="strPassword"], input#strPassword');
    const loginButton = page.locator('button[type="submit"], input[type="submit"]');
    
    if (await usernameField.count() > 0) {
      await usernameField.fill(SPY_USERNAME);
      await passwordField.fill(SPY_PASSWORD);
      await loginButton.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }

    // Navigate to Stock Status page
    const stockStatusUrl = `${SPY_BASE_URL}/?controller=Style%5CStockStatus&action=List`;
    await page.goto(stockStatusUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Verify we're on the correct page
    let breadcrumbsH1 = await page.locator('h1.breadcrumbs').textContent().catch(() => null);
    
    if (!breadcrumbsH1 || !breadcrumbsH1.includes('Stock Status')) {
      // Reload and check again as specified
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      breadcrumbsH1 = await page.locator('h1.breadcrumbs').textContent().catch(() => null);
      
      if (!breadcrumbsH1 || !breadcrumbsH1.includes('Stock Status')) {
        throw new Error('Could not verify Stock Status page - breadcrumbs not found after reload');
      }
    }

    // Click "Show All" button
    const showAllButton = page.locator('button[name="show_all"]');
    const showAllExists = await showAllButton.count() > 0;
    
    if (!showAllExists) {
      throw new Error('Show All button not found');
    }

    await showAllButton.click();

    // Wait for tbody to populate
    await page.waitForSelector('.spy-container table.standardList tbody tr', { timeout: 60000 });

    // Wait for the table to stabilize by checking row count doesn't change
    let previousRowCount = 0;
    let stableCount = 0;
    
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const currentRowCount = await page.locator('.spy-container table.standardList tbody tr').count();
      
      if (currentRowCount === previousRowCount && currentRowCount > 0) {
        stableCount++;
        if (stableCount >= 3) {
          break;
        }
      } else {
        stableCount = 0;
      }
      
      previousRowCount = currentRowCount;
    }

    // Additional wait to ensure backend has processed the data
    await page.waitForTimeout(2000);

    // Parse table rows
    const rows = await page.locator('.spy-container table.standardList tbody tr').all();
    const data: SpyStockRow[] = [];

    for (const row of rows) {
      const cells = await row.locator('td').all();
      
      if (cells.length < 9) continue; // Ensure we have enough columns
      
      try {
        // Extract text content from each cell
        // Column indices based on the HTML structure provided:
        // 0: empty, 1: Style No., 2: Style Name, 3: Season, 4: Landed, 5: Invoiced, 6: empty, 7: Correction, 8: Stock, ...
        const styleNoText = await cells[1].textContent();
        const styleNameText = await cells[2].textContent();
        const stockText = await cells[8].textContent();
        
        const styleNo = styleNoText?.trim() || '';
        const styleName = styleNameText?.trim() || '';
        const stockStr = stockText?.trim().replace(/[^0-9-]/g, '') || '0';
        const stock = parseInt(stockStr, 10);
        
        if (styleNo && !isNaN(stock)) {
          data.push({
            styleNo,
            styleName,
            stock
          });
        }
      } catch (err) {
        // Skip rows that can't be parsed
        console.error('Error parsing row:', err);
        continue;
      }
    }

    return data;

  } finally {
    // Cleanup
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function POST(req: Request) {
  try {
    // Verify authentication
    const auth = req.headers.get('authorization');
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Authentication required' }), 
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Scrape SPY stock data
    const data = await scrapeSpyStock();

    return new Response(
      JSON.stringify({ success: true, data, count: data.length }), 
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    console.error('SPY stock verification error:', err);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: err?.message || 'Failed to verify SPY stock' 
      }), 
      { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      }
    );
  }
}
