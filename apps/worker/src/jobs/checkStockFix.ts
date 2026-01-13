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
  findFirst: (page: Page, selectors: string[]) => Promise<any>;
};

// Check stock fix: Scrape SPY stock data and compare with database
// Supports autoFix mode: when payload.autoFix is true, enqueues update_style_stock for mismatched styles
export async function checkStockFix(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  // Read autoFix mode from payload (default: false for backward compatibility)
  const autoFix = (job.payload as any)?.autoFix === true;
  const requestedBy = (job.payload as any)?.requestedBy as string | undefined;
  
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
      
      // Wait for the table to stabilize by checking row count doesn't change
      await log(job.id, 'info', 'STEP:check_stock_fix_waiting_for_table_load');
      let previousRowCount = 0;
      let stableCount = 0;
      
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1000);
        const currentRowCount = await page.locator('.spy-container table.standardList tbody tr').count();
        
        if (currentRowCount === previousRowCount && currentRowCount > 0) {
          stableCount++;
          if (stableCount >= 3) {
            await log(job.id, 'info', 'STEP:check_stock_fix_table_loaded', { rowCount: currentRowCount });
            break;
          }
        } else {
          stableCount = 0;
        }
        
        previousRowCount = currentRowCount;
      }
      
      // Additional wait to ensure backend has processed the data
      await page.waitForTimeout(2000);
    }
    
    // Parse the HTML table directly (no need to download Excel)
    await log(job.id, 'info', 'STEP:check_stock_fix_parsing_table');
    const parsedRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.spy-container table.standardList tbody tr'));
      const data: Array<{ 
        style_no: string | null; 
        style_name: string | null; 
        stock: number | null;
      }> = [];
      
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 9) continue;
        
        // Column indices: 0: empty, 1: Style No., 2: Style Name, ..., 8: Stock
        const styleNoText = cells[1]?.textContent?.trim() || null;
        const styleNameText = cells[2]?.textContent?.trim() || null;
        const stockText = cells[8]?.textContent?.trim() || null;
        
        if (styleNoText) {
          const stockNum = stockText ? parseInt(stockText.replace(/[^0-9-]/g, ''), 10) : null;
          data.push({
            style_no: styleNoText,
            style_name: styleNameText,
            stock: isNaN(stockNum!) ? null : stockNum
          });
        }
      }
      
      return data;
    });
    
    await log(job.id, 'info', 'STEP:check_stock_fix_parsed', { rowCount: parsedRows.length });
    
    // Store parsed rows in job result for reference
    await log(job.id, 'info', 'STEP:check_stock_fix_storing_data', { sample: parsedRows.slice(0, 5) });
    
    // Fetch current stock data from database and compare
    const styleNos = Array.from(new Set(parsedRows.map(r => r.style_no).filter(Boolean)));
    await log(job.id, 'info', 'STEP:check_stock_fix_fetching_db_stock', { styleCount: styleNos.length });
    
    const dbStockByStyleNo = new Map<string, number>();
    let usedTotalsTable = false;
    
    // Try fast path: use style_stock_totals table (pre-aggregated totals)
    try {
      const BATCH_SIZE = 500;
      let totalsFound = 0;
      
      for (let i = 0; i < styleNos.length; i += BATCH_SIZE) {
        const batch = styleNos.slice(i, i + BATCH_SIZE);
        const { data: totalsData, error: totalsErr } = await supabase
          .from('style_stock_totals')
          .select('style_no, total_stock')
          .in('style_no', batch);
        
        if (totalsErr) {
          // Table doesn't exist or query failed - fall back to slow path
          throw new Error(totalsErr.message);
        }
        
        for (const row of (totalsData ?? [])) {
          dbStockByStyleNo.set(row.style_no, row.total_stock ?? 0);
          totalsFound++;
        }
      }
      
      if (totalsFound > 0) {
        usedTotalsTable = true;
        await log(job.id, 'info', 'STEP:check_stock_fix_used_totals_table', { 
          stylesFound: totalsFound,
          stylesMissing: styleNos.length - totalsFound
        });
      }
    } catch (e: any) {
      await log(job.id, 'info', 'STEP:check_stock_fix_totals_fallback', { 
        reason: e?.message || 'style_stock_totals not available',
        usingSlowPath: true
      });
    }
    
    // Fallback: slow path - aggregate from style_stock table
    if (!usedTotalsTable) {
      const BATCH_SIZE = 500;
      const PAGE_SIZE = 1000;
      const stockData: any[] = [];
      
      for (let i = 0; i < styleNos.length; i += BATCH_SIZE) {
        const batch = styleNos.slice(i, i + BATCH_SIZE);
        await log(job.id, 'info', 'STEP:check_stock_fix_fetching_batch', { 
          batchIndex: Math.floor(i / BATCH_SIZE) + 1,
          totalBatches: Math.ceil(styleNos.length / BATCH_SIZE),
          batchSize: batch.length
        });
        
        let from = 0;
        let hasMore = true;
        
        while (hasMore) {
          const to = from + PAGE_SIZE - 1;
          const { data: batchData, error: batchError } = await supabase
            .from('style_stock')
            .select('style_no, color, sizes, section, row_label, values, scraped_at')
            .in('style_no', batch)
            .order('scraped_at', { ascending: false })
            .range(from, to);
          
          if (batchError) {
            await log(job.id, 'error', 'STEP:check_stock_fix_db_batch_error', { 
              error: batchError.message,
              batchIndex: Math.floor(i / BATCH_SIZE) + 1
            });
            throw new Error(`Failed to fetch stock data batch: ${batchError.message}`);
          }
          
          if (batchData && batchData.length > 0) {
            stockData.push(...batchData);
          }
          
          hasMore = batchData && batchData.length === PAGE_SIZE;
          from += PAGE_SIZE;
        }
      }
      
      const foundStyleNos = new Set(stockData.map((r: any) => r.style_no));
      const missingStyleNos = styleNos.filter(sn => !foundStyleNos.has(sn));
      
      await log(job.id, 'info', 'STEP:check_stock_fix_db_rows_fetched', { 
        total_rows: stockData.length,
        unique_styles_requested: styleNos.length,
        unique_styles_found: foundStyleNos.size,
        missing_styles_count: missingStyleNos.length,
        sample_style: styleNos[0],
        sample_rows: stockData.filter((r: any) => r.style_no === styleNos[0]).length,
        sample_missing_styles: missingStyleNos.slice(0, 10)
      });
      
      // Group by style_no -> color
      const byStyle = new Map<string, Map<string, any[]>>();
      for (const r of (stockData ?? [])) {
        if (!byStyle.has(r.style_no)) byStyle.set(r.style_no, new Map());
        const byColor = byStyle.get(r.style_no)!;
        if (!byColor.has(r.color)) byColor.set(r.color, []);
        byColor.get(r.color)!.push(r);
      }
      
      // For each style, aggregate across all colors
      for (const [styleNo, byColor] of byStyle.entries()) {
        let styleTotal = 0;
        
        for (const [, rows] of byColor.entries()) {
          const latestMap = new Map<string, any>();
          let uniqueIdCounter = 0;
          
          for (const r of rows) {
            const normalizedLabel = String(r.row_label ?? '').trim();
            
            if (normalizedLabel) {
              const key = `${r.section}|${normalizedLabel}`;
              const curr = latestMap.get(key);
              if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) {
                latestMap.set(key, r);
              }
            } else {
              latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
            }
          }
          
          const latestRows = Array.from(latestMap.values());
          const stockRow = latestRows.find(r => r.section === 'Stock');
          
          if (stockRow) {
            const values = Array.isArray(stockRow.values) 
              ? stockRow.values 
              : JSON.parse(String(stockRow.values || '[]'));
            const colorTotal = Array.isArray(values) 
              ? values.reduce((sum: number, v: any) => sum + (Number(v) || 0), 0) 
              : Number(values) || 0;
            styleTotal += colorTotal;
          }
        }
        
        dbStockByStyleNo.set(styleNo, styleTotal);
      }
    }
    
    // Compare and find mismatches
    // Build complete comparison data for ALL styles (not just mismatches)
    const allComparisons: Array<{ style_no: string; style_name: string | null; spy_stock: number | null; db_stock: number; diff: number }> = [];
    const mismatches: Array<{ style_no: string; spy_stock: number | null; db_stock: number; diff: number }> = [];
    
    // Log first 10 comparisons for debugging
    const debugSample = parsedRows.slice(0, 10).map(row => {
      const spyStock = row.stock ?? 0;
      const dbStock = row.style_no ? dbStockByStyleNo.get(row.style_no) ?? 0 : 0;
      const hasDbData = row.style_no ? dbStockByStyleNo.has(row.style_no) : false;
      return {
        style_no: row.style_no,
        spy_stock: spyStock,
        db_stock: dbStock,
        has_db_data: hasDbData,
        match: spyStock === dbStock,
        usedTotalsTable
      };
    });
    
    await log(job.id, 'info', 'STEP:check_stock_fix_comparison_sample', { sample: debugSample });
    
    // Log summary of styles with no DB data
    const stylesWithNoDbData = parsedRows
      .filter(row => row.style_no && !dbStockByStyleNo.has(row.style_no))
      .map(row => row.style_no)
      .filter(Boolean) as string[];
    
    if (stylesWithNoDbData.length > 0) {
      await log(job.id, 'info', 'STEP:check_stock_fix_styles_no_db_data', {
        count: stylesWithNoDbData.length,
        sample: stylesWithNoDbData.slice(0, 20)
      });
    }
    
    // Process ALL styles from SPY and build complete comparison data
    for (const row of parsedRows) {
      if (!row.style_no) continue;
      const styleNo = row.style_no; // TypeScript narrows the type here
      const spyStock = row.stock ?? 0;
      const dbStock = dbStockByStyleNo.get(styleNo) ?? 0;
      const diff = Math.abs(spyStock - dbStock);
      
      // Add to all comparisons (for frontend to properly categorize)
      allComparisons.push({
        style_no: styleNo,
        style_name: row.style_name,
        spy_stock: spyStock,
        db_stock: dbStock,
        diff
      });
      
      // Consider it a mismatch if difference is greater than 0
      if (diff > 0) {
        mismatches.push({
          style_no: styleNo,
          spy_stock: spyStock,
          db_stock: dbStock,
          diff
        });
        
        // Log detailed info for first 5 mismatches
        if (mismatches.length <= 5) {
          await log(job.id, 'info', 'STEP:check_stock_fix_mismatch_detail', {
            style_no: styleNo,
            style_name: row.style_name,
            spy_stock: row.stock,
            db_stock: dbStock
          });
        }
      }
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_mismatches_found', { 
      totalChecked: parsedRows.length, 
      mismatchCount: mismatches.length,
      autoFix,
      sample: mismatches.slice(0, 10)
    });
    
    // Handle autoFix mode: enqueue update_style_stock for mismatched styles
    let fixJobsEnqueued = 0;
    if (autoFix && mismatches.length > 0) {
      await log(job.id, 'info', 'STEP:check_stock_fix_autofix_start', { 
        message: 'AutoFix enabled - enqueuing update_style_stock for mismatched styles',
        styleCount: mismatches.length 
      });
      
      const mismatchedStyleNos = mismatches.map(m => m.style_no);
      
      // Chunk the mismatched styles into batches of 30 (same as update_style_stock BATCH_SIZE)
      const BATCH_SIZE = 30;
      const chunks: string[][] = [];
      for (let i = 0; i < mismatchedStyleNos.length; i += BATCH_SIZE) {
        chunks.push(mismatchedStyleNos.slice(i, i + BATCH_SIZE));
      }
      
      // First, create a "root" update_style_stock job ID to link all batches
      // This allows the export_stock_list_after_update_stock waiter to track all batches
      let rootJobId: string | null = null;
      
      // Enqueue update_style_stock jobs for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        try {
          const isFirstBatch = i === 0;
          const payload: Record<string, any> = {
            styleNos: chunk,
            requestedBy: 'check_stock_fix_autofix',
            batchIndex: i + 1,
            batchTotal: chunks.length
          };
          
          // First batch is the "root", subsequent batches reference rootId
          if (!isFirstBatch && rootJobId) {
            payload.rootId = rootJobId;
          }
          
          const { data: insertedJob, error: insertErr } = await supabase
            .from('jobs')
            .insert({
              type: 'update_style_stock',
              payload,
              status: 'queued',
              max_attempts: 3,
              queue: 'stock',
              priority: 150 // Medium-high priority
            })
            .select('id')
            .single();
          
          if (!insertErr && insertedJob) {
            fixJobsEnqueued++;
            // Save the first job's ID as the root
            if (isFirstBatch) {
              rootJobId = insertedJob.id;
            }
          } else if (insertErr) {
            await log(job.id, 'error', 'STEP:check_stock_fix_autofix_enqueue_error', { 
              batchIndex: i + 1, 
              error: insertErr.message 
            });
          }
        } catch (e: any) {
          await log(job.id, 'error', 'STEP:check_stock_fix_autofix_enqueue_exception', { 
            batchIndex: i + 1, 
            error: e?.message || String(e) 
          });
        }
      }
      
      await log(job.id, 'info', 'STEP:check_stock_fix_autofix_enqueued', { 
        jobsEnqueued: fixJobsEnqueued,
        totalBatches: chunks.length,
        totalStyles: mismatchedStyleNos.length,
        rootJobId
      });
      
      // NOTE: export_stock_list will be automatically enqueued by the first update_style_stock job
      // via the export_stock_list_after_update_stock waiter pattern. No need to enqueue here.
      await log(job.id, 'info', 'STEP:check_stock_fix_export_will_follow', { 
        message: 'export_stock_list will be triggered after update_style_stock batches complete',
        rootJobId 
      });
      
    } else if (mismatches.length > 0) {
      // Manual review mode (autoFix disabled)
      await log(job.id, 'info', 'STEP:check_stock_fix_ready_for_review', { 
        message: 'Mismatches found - ready for manual review (autoFix disabled)',
        styleCount: mismatches.length 
      });
    } else {
      await log(job.id, 'info', 'STEP:check_stock_fix_no_mismatches', { message: 'All styles match!' });
    }
    
    // Save the complete result
    // Include ALL styles from SPY in details (not just mismatches) so frontend can properly categorize them
    await saveResult(job.id, 'check_stock_fix_complete', {
      totalChecked: parsedRows.length,
      mismatches: mismatches.length,
      mismatchedStyles: mismatches.map(m => m.style_no),
      autoFix,
      fixJobsEnqueued,
      details: allComparisons // Send ALL styles, not just mismatches
    });
    
    await setJobSucceeded(job.id);
    
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:check_stock_fix_error', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

