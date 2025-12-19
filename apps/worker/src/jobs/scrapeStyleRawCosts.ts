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

    await log(job.id, 'info', `Found ${styles.length} styles to scrape`, { total: styles.length });

    const results: Array<{ style_id: string; style_no: string; raw_cost: number | null; success: boolean; error?: string }> = [];

    for (let i = 0; i < styles.length; i++) {
      const style = styles[i];
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

      let scrapeSuccess = false;
      let lastScrapeError: string | null = null;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries && !scrapeSuccess; attempt++) {
        try {
          await log(job.id, 'info', `Scraping style: ${style.style_no} (attempt ${attempt}/${maxRetries})`, { 
            style_no: style.style_no,
            current: i + 1,
            total: styles.length,
            attempt
          });
          
          // Navigate to style statistics page
          // URL format: controller=Style\Statistics&action=List&Spy\Model\Style\Statistics\ListReportSearch[...]
          // Backslashes need to be URL-encoded as %5C
          const baseUrl = 'https://2-biz.spysystem.dk/?controller=Style%5CStatistics&action=List';
          const searchParams = new URLSearchParams({
            'Spy\\Model\\Style\\Statistics\\ListReportSearch[bForceSearch]': 'true',
            'Spy\\Model\\Style\\Statistics\\ListReportSearch[strStyleNo]': style.style_no
          });
          const url = `${baseUrl}&${searchParams.toString()}`;
          
          await log(job.id, 'info', `Navigating to URL for ${style.style_no}`, { url, attempt });
          await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
          
          // Check page load status
          const pageTitle = await page.title().catch(() => 'Unknown');
          const pageUrl = page.url();
          await log(job.id, 'info', `Page loaded for ${style.style_no}`, { 
            pageTitle, 
            pageUrl,
            attempt 
          });
          
          // Check for error messages on the page
          const errorMessages = await page.evaluate(() => {
            const errorSelectors = [
              '.error',
              '.alert-danger',
              '[class*="error"]',
              '[class*="Error"]'
            ];
            const messages: string[] = [];
            for (const selector of errorSelectors) {
              try {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                  const text = el.textContent?.trim();
                  if (text && text.length < 200) messages.push(text);
                });
              } catch {}
            }
            return messages;
          }).catch(() => []);
          
          if (errorMessages.length > 0) {
            await log(job.id, 'error', `Error messages found on page for ${style.style_no}`, {
              errorMessages,
              attempt
            });
          }
          
          // Check if table with data rows exists
          // Note: table.standardList means the table element has class="standardList"
          const tableStatus = await page.evaluate(() => {
            const standardListTable = document.querySelector('table.standardList');
            const dataRows = document.querySelectorAll('table.standardList tbody tr');
            const searchButton = document.querySelector('button[name="search"]') as HTMLButtonElement | null;
            return {
              hasStandardListTable: !!standardListTable,
              dataRowCount: dataRows.length,
              hasSearchButton: !!searchButton
            };
          }).catch(() => ({ hasStandardListTable: false, dataRowCount: 0, hasSearchButton: false }));
          
          await log(job.id, 'info', `Table status check for ${style.style_no}`, {
            ...tableStatus,
            attempt
          });
          
          // If no data rows but search button exists, click it to trigger search
          if (tableStatus.dataRowCount === 0 && tableStatus.hasSearchButton) {
            await log(job.id, 'info', `No data rows found, clicking Search button for ${style.style_no}`, { attempt });
            try {
              await page.click('button[name="search"]');
              // Wait for network to settle after clicking search
              await page.waitForLoadState('networkidle', { timeout: 60_000 });
              await log(job.id, 'info', `Search button clicked, waiting for data for ${style.style_no}`, { attempt });
            } catch (clickError: any) {
              await log(job.id, 'error', `Failed to click search button for ${style.style_no}`, {
                error: clickError.message,
                attempt
              });
            }
          }

          // Wait for table data rows to appear
          // Selector: table.standardList means the <table> element has class="standardList"
          await log(job.id, 'info', `Waiting for table rows for ${style.style_no}`, { attempt });
          try {
            await page.waitForSelector('table.standardList tbody tr', { 
              timeout: 60_000,
              state: 'attached' as any
            });
            await log(job.id, 'info', `Table rows found for ${style.style_no}`, { attempt });
          } catch (waitError: any) {
            // Check what's actually on the page
            const pageContent = await page.evaluate(() => {
              return {
                hasStandardListTable: !!document.querySelector('table.standardList'),
                hasTbodyInStandardList: !!document.querySelector('table.standardList tbody'),
                hasTrInStandardList: !!document.querySelector('table.standardList tbody tr'),
                tbodyRowCount: document.querySelectorAll('table.standardList tbody tr').length,
                bodyText: document.body.textContent?.substring(0, 500) || '',
                htmlSnippet: document.body.innerHTML.substring(0, 1000) || ''
              };
            }).catch(() => ({}));
            
            await log(job.id, 'error', `Timeout waiting for table rows for ${style.style_no}`, {
              waitError: waitError.message,
              pageContent,
              attempt
            });
            
            if (attempt < maxRetries) {
              const delay = Math.min(2000 * attempt, 10000);
              await log(job.id, 'info', `Retrying in ${delay}ms after timeout...`, { attempt, delay });
              await page.waitForTimeout(delay);
              continue;
            }
            
            throw waitError;
          }

          // Extract data from table
          await log(job.id, 'info', `Extracting raw cost for ${style.style_no}`, { attempt });
          const tableData = await page.evaluate((targetStyleNo: string) => {
            const rows = Array.from(document.querySelectorAll('table.standardList tbody tr')) as HTMLTableRowElement[];
            
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
          
          await log(job.id, 'info', `Found ${tableData ? 1 : 0} matching rows for ${style.style_no}`, {
            attempt,
            hasData: !!tableData
          });

          if (!tableData) {
            await log(job.id, 'info', `Style ${style.style_no} not found in table`, { attempt });
            if (attempt < maxRetries) {
              const delay = Math.min(2000 * attempt, 10000);
              await log(job.id, 'info', `Retrying in ${delay}ms...`, { attempt, delay });
              await page.waitForTimeout(delay);
              continue;
            }
            throw new Error('Style not found in table after all retries');
          }

          // Parse the raw cost (remove currency, handle comma decimal)
          const rawCost = parseEuNumber(tableData.rawCostText);
          
          if (rawCost === null) {
            await log(job.id, 'info', `Could not parse raw cost for ${style.style_no}: ${tableData.rawCostText}`, { attempt });
            throw new Error(`Could not parse raw cost: ${tableData.rawCostText}`);
          }

          // Update the vendor_style with the raw cost as price_per_sample
          const { error: updateError } = await supabase
            .from('vendor_styles')
            .update({ price_per_sample: rawCost })
            .eq('id', style.id);

          if (updateError) {
            throw new Error(`Failed to update style ${style.id}: ${updateError.message}`);
          }

          await log(job.id, 'info', `Successfully updated ${style.style_no} with raw cost: ${rawCost}`, {
            style_no: style.style_no,
            raw_cost: rawCost,
            current: i + 1,
            total: styles.length,
            attempt
          });
          
          results.push({
            style_id: style.id,
            style_no: style.style_no,
            raw_cost: rawCost,
            success: true
          });
          
          scrapeSuccess = true;

        } catch (error: any) {
          lastScrapeError = error.message;
          await log(job.id, 'error', `Error on attempt ${attempt} for ${style.style_no}`, {
            error: error.message,
            stack: error.stack?.substring(0, 500),
            attempt
          });
          
          if (attempt < maxRetries) {
            const delay = Math.min(2000 * attempt, 10000);
            await log(job.id, 'info', `Retrying in ${delay}ms after error...`, { attempt, delay });
            await page.waitForTimeout(delay);
          }
        }
      }
      
      // If all retries failed, add to results
      if (!scrapeSuccess) {
        await log(job.id, 'error', `Failed to scrape ${style.style_no} after ${maxRetries} attempts`, {
          lastError: lastScrapeError
        });
        results.push({
          style_id: style.id,
          style_no: style.style_no,
          raw_cost: null,
          success: false,
          error: lastScrapeError || 'All retry attempts failed'
        });
      }

      // Small delay between requests to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 1000));
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

