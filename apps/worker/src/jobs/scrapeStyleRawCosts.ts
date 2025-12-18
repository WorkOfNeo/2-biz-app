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
  SPY_BASE_URL: string;
};

// Parse EU number format (e.g., "21,50 EUR" -> 21.50)
function parseEuNumber(raw: string | null | undefined): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Remove currency text, spaces, and thousands separators
  // Replace comma decimal with dot
  const norm = s
    .replace(/[A-Z]{3}/gi, '') // Remove currency codes like EUR, DKK, USD
    .replace(/\s+/g, '')
    .replace(/\./g, '') // Remove thousands separators
    .replace(/,([0-9]{1,2})$/, '.$1'); // Replace comma decimal with dot
  const m = norm.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Number(m[0]);
}

export async function scrapeStyleRawCosts(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:scrape_raw_costs_begin');
    
    const payload = job.payload as { vendor_row_id?: string };
    if (!payload?.vendor_row_id) {
      throw new Error('vendor_row_id is required in payload');
    }

    // Fetch styles for this vendor
    const { data: styles, error: stylesError } = await supabase
      .from('vendor_styles')
      .select('id, style_no')
      .eq('vendor_row_id', payload.vendor_row_id)
      .not('style_no', 'is', null)
      .neq('style_no', '');

    if (stylesError) throw new Error(`Failed to fetch styles: ${stylesError.message}`);
    if (!styles || styles.length === 0) {
      await log(job.id, 'info', 'No styles found for vendor');
      await saveResult(job.id, 'No styles to scrape', { updated: 0 });
      await setJobSucceeded(job.id);
      return;
    }

    await log(job.id, 'info', `Found ${styles.length} styles to scrape`);

    const results: Array<{ style_id: string; style_no: string; raw_cost: number | null; success: boolean; error?: string }> = [];

    for (const style of styles) {
      await ensureNotCancelled(job.id);
      
      if (!style.style_no) {
        results.push({
          style_id: style.id,
          style_no: style.style_no || '',
          raw_cost: null,
          success: false,
          error: 'No style_no'
        });
        continue;
      }

      try {
        await log(job.id, 'info', `Scraping style: ${style.style_no}`);
        
        // Navigate to style statistics page
        // URL format: controller=Style\Statistics&action=List&Spy\Model\Style\Statistics\ListReportSearch[...]
        // Backslashes need to be URL-encoded as %5C
        const baseUrl = 'https://2-biz.spysystem.dk/?controller=Style%5CStatistics&action=List';
        const searchParams = new URLSearchParams({
          'Spy\\Model\\Style\\Statistics\\ListReportSearch[bForceSearch]': 'true',
          'Spy\\Model\\Style\\Statistics\\ListReportSearch[strStyleNo]': style.style_no
        });
        const url = `${baseUrl}&${searchParams.toString()}`;
        
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
        await log(job.id, 'info', `Loaded page for ${style.style_no}`);

        // Wait for table to be present
        await page.waitForSelector('.standardList table tbody tr', { timeout: 30_000 });

        // Extract data from table
        const tableData = await page.evaluate((targetStyleNo: string) => {
          const rows = Array.from(document.querySelectorAll('.standardList table tbody tr')) as HTMLTableRowElement[];
          
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')) as HTMLElement[];
            if (cells.length < 5) continue;

            // Style No is in column 1 (index 1)
            const styleNoCell = cells[1];
            const styleNoLink = styleNoCell?.querySelector('a') as HTMLAnchorElement | null;
            const styleNo = (styleNoLink?.textContent || styleNoCell?.textContent || '').trim();

            // Check if this row matches our target style
            if (styleNo === targetStyleNo) {
              // Raw Cost is in column 4 (index 4, data-column_no="4")
              const rawCostCell = cells[4];
              const rawCostText = (rawCostCell?.textContent || '').trim();
              
              return {
                styleNo,
                rawCostText
              };
            }
          }
          
          return null;
        }, style.style_no);

        if (!tableData) {
          await log(job.id, 'info', `Style ${style.style_no} not found in table`);
          results.push({
            style_id: style.id,
            style_no: style.style_no,
            raw_cost: null,
            success: false,
            error: 'Style not found in table'
          });
          continue;
        }

        // Parse the raw cost (remove currency, handle comma decimal)
        const rawCost = parseEuNumber(tableData.rawCostText);
        
        if (rawCost === null) {
          await log(job.id, 'info', `Could not parse raw cost for ${style.style_no}: ${tableData.rawCostText}`);
          results.push({
            style_id: style.id,
            style_no: style.style_no,
            raw_cost: null,
            success: false,
            error: `Could not parse raw cost: ${tableData.rawCostText}`
          });
          continue;
        }

        // Update the vendor_style with the raw cost as price_per_sample
        const { error: updateError } = await supabase
          .from('vendor_styles')
          .update({ price_per_sample: rawCost })
          .eq('id', style.id);

        if (updateError) {
          throw new Error(`Failed to update style ${style.id}: ${updateError.message}`);
        }

        await log(job.id, 'info', `Updated ${style.style_no} with raw cost: ${rawCost}`);
        
        results.push({
          style_id: style.id,
          style_no: style.style_no,
          raw_cost: rawCost,
          success: true
        });

        // Small delay between requests to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error: any) {
        await log(job.id, 'error', `Error scraping ${style.style_no}: ${error.message}`);
        results.push({
          style_id: style.id,
          style_no: style.style_no,
          raw_cost: null,
          success: false,
          error: error.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    await saveResult(job.id, `Scraped ${successCount} styles, ${failCount} failed`, {
      total: results.length,
      success: successCount,
      failed: failCount,
      results
    });

    await setJobSucceeded(job.id);
    await log(job.id, 'info', 'STEP:scrape_raw_costs_complete');

  } catch (error: any) {
    await log(job.id, 'error', `Fatal error: ${error.message}`);
    await setJobFailedOrRequeue(job, error.message);
  }
}

