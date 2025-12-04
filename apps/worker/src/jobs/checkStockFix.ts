import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
};

export async function checkStockFix(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:check_stock_fix_begin');
    
    // Navigate to Stock Status page
    const stockStatusUrl = 'https://2-biz.spysystem.dk/?controller=Style%5CStockStatus&action=List';
    await page.goto(stockStatusUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await log(job.id, 'info', 'STEP:check_stock_fix_navigated', { url: stockStatusUrl });
    
    // Verify we're on the right page by checking breadcrumbs
    const breadcrumbsH1 = await page.locator('h1.breadcrumbs').textContent().catch(() => null);
    if (!breadcrumbsH1 || !breadcrumbsH1.includes('Stock Status')) {
      throw new Error('Could not verify Stock Status page - breadcrumbs not found');
    }
    await log(job.id, 'info', 'STEP:check_stock_fix_verified_page', { breadcrumbs: breadcrumbsH1 });
    
    // Verify table.standardList exists
    const tableExists = await page.locator('table.standardList').count() > 0;
    if (!tableExists) {
      throw new Error('table.standardList not found on page');
    }
    await log(job.id, 'info', 'STEP:check_stock_fix_table_found');
    
    // Click "Show All" button to load all data
    const showAllButton = page.locator('button[name="show_all"]');
    const showAllExists = await showAllButton.count() > 0;
    if (showAllExists) {
      await showAllButton.click();
      await log(job.id, 'info', 'STEP:check_stock_fix_show_all_clicked');
      // Wait for table to update (wait for tbody to be present)
      await page.waitForSelector('.spy-container table.standardList tbody tr', { timeout: 60_000 });
      // Give it a bit more time to ensure all rows load
      await page.waitForTimeout(2000);
    }
    
    // Parse the table rows
    await log(job.id, 'info', 'STEP:check_stock_fix_parsing_table');
    const parsedRows = await page.$$eval('.spy-container table.standardList tbody tr', (trs) => {
      const out: Array<{ 
        style_no: string | null; 
        style_name: string | null; 
        season: string | null;
        landed: number | null;
        invoiced: number | null;
        correction: number | null;
        stock: number | null;
        consignment: number | null;
        on_hold: number | null;
        total: number | null;
      }> = [];
      
      function txt(el?: Element | null): string {
        return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim();
      }
      
      function parseNumber(str: string): number | null {
        if (!str) return null;
        const norm = str.replace(/\./g, '').replace(/\s+/g, '').replace(/,([0-9]{1,2})$/, '.$1');
        const m = norm.match(/-?\d+(?:\.\d+)?/);
        return m ? Math.round(Number(m[0])) : null;
      }
      
      for (const tr of Array.from(trs) as HTMLTableRowElement[]) {
        const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
        if (!tds.length || tds.length < 12) continue;
        
        // Based on the HTML structure provided:
        // td[1] = Style No link
        // td[2] = Style Name
        // td[3] = Season
        // td[4] = Landed (price in DKK)
        // td[5] = Invoiced (price in EUR)
        // td[6] = empty
        // td[7] = Correction
        // td[8] = Stock
        // td[9] = ??? (index 9)
        // td[10] = Consignment
        // td[11] = On Hold / In Progress
        // td[12] = Total (might not exist, depends on structure)
        
        const styleNoLink = tds[1]?.querySelector('a');
        const style_no = styleNoLink ? txt(styleNoLink) : null;
        const style_name = txt(tds[2]?.querySelector('.textoverflow, div'));
        const season = txt(tds[3]?.querySelector('.textoverflow, div'));
        const correction = parseNumber(txt(tds[7]));
        const stock = parseNumber(txt(tds[8]));
        const consignment = parseNumber(txt(tds[10]));
        const on_hold = parseNumber(txt(tds[11]));
        const total = tds[12] ? parseNumber(txt(tds[12])) : null;
        
        if (style_no) {
          out.push({
            style_no,
            style_name,
            season,
            landed: null, // Not used for comparison
            invoiced: null, // Not used for comparison
            correction,
            stock,
            consignment,
            on_hold,
            total
          });
        }
      }
      
      return out;
    });
    
    await log(job.id, 'info', 'STEP:check_stock_fix_parsed', { rowCount: parsedRows.length });
    
    // Store parsed rows in job result for reference
    await log(job.id, 'info', 'STEP:check_stock_fix_storing_data', { sample: parsedRows.slice(0, 5) });
    
    // Fetch current stock data from database and compare
    // We need to aggregate stock data per style_no from style_stock table
    const styleNos = Array.from(new Set(parsedRows.map(r => r.style_no).filter(Boolean)));
    await log(job.id, 'info', 'STEP:check_stock_fix_fetching_db_stock', { styleCount: styleNos.length });
    
    const { data: stockData } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', styleNos)
      .order('scraped_at', { ascending: false })
      .limit(100000);
    
    // Aggregate stock data per style
    const dbStockByStyleNo = new Map<string, number>();
    
    for (const row of (stockData ?? [])) {
      if (row.section !== 'Stock') continue;
      const styleNo = row.style_no;
      const values = Array.isArray(row.values) ? row.values : JSON.parse(String(row.values || '[]'));
      const total = Array.isArray(values) ? values.reduce((sum: number, v: any) => sum + (Number(v) || 0), 0) : Number(values) || 0;
      
      const existing = dbStockByStyleNo.get(styleNo) || 0;
      dbStockByStyleNo.set(styleNo, existing + total);
    }
    
    // Compare and find mismatches
    const mismatches: Array<{ style_no: string; spy_stock: number | null; db_stock: number; diff: number }> = [];
    
    for (const row of parsedRows) {
      if (!row.style_no) continue;
      const spyStock = row.stock ?? 0;
      const dbStock = dbStockByStyleNo.get(row.style_no) ?? 0;
      const diff = Math.abs(spyStock - dbStock);
      
      // Consider it a mismatch if difference is greater than 0
      if (diff > 0) {
        mismatches.push({
          style_no: row.style_no,
          spy_stock: spyStock,
          db_stock: dbStock,
          diff
        });
      }
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_mismatches_found', { 
      totalChecked: parsedRows.length, 
      mismatchCount: mismatches.length,
      sample: mismatches.slice(0, 10)
    });
    
    // If there are mismatches, enqueue a scrape job for those styles
    if (mismatches.length > 0) {
      const mismatchStyleNos = mismatches.map(m => m.style_no);
      
      await log(job.id, 'info', 'STEP:check_stock_fix_enqueuing_scrape', { styleCount: mismatchStyleNos.length });
      
      // Enqueue scrape job for mismatched styles
      const { data: scrapeJob, error: enqueueError } = await supabase
        .from('jobs')
        .insert({
          type: 'update_style_stock',
          payload: { 
            styleNos: mismatchStyleNos, 
            requestedBy: 'check-stock-fix',
            checkJobId: job.id
          },
          status: 'queued',
          max_attempts: 3,
          queue: 'default',
          priority: 90 // Slightly lower priority than user-triggered scrapes
        })
        .select('id')
        .single();
      
      if (enqueueError) {
        await log(job.id, 'error', 'STEP:check_stock_fix_enqueue_failed', { error: enqueueError.message });
      } else {
        await log(job.id, 'info', 'STEP:check_stock_fix_scrape_enqueued', { 
          scrapeJobId: scrapeJob?.id,
          styleCount: mismatchStyleNos.length
        });
      }
    } else {
      await log(job.id, 'info', 'STEP:check_stock_fix_no_mismatches', { message: 'All styles match!' });
    }
    
    // Save the complete result
    await saveResult(job.id, 'check_stock_fix_complete', {
      totalChecked: parsedRows.length,
      mismatches: mismatches.length,
      mismatchedStyles: mismatches.map(m => m.style_no),
      details: mismatches
    });
    
    await setJobSucceeded(job.id);
    
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:check_stock_fix_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

