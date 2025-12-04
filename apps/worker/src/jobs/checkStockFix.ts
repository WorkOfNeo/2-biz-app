import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import * as XLSX from 'xlsx';

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

export async function checkStockFix(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
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
    
    // Extract collection UUID for Excel download
    await log(job.id, 'info', 'STEP:check_stock_fix_extracting_uuid');
    const collectionUUID = await page.evaluate(() => {
      const downloadLink = document.querySelector('a[href*="DownloadExcel"]') as HTMLAnchorElement;
      if (downloadLink) {
        const url = new URL(downloadLink.href, window.location.href);
        return url.searchParams.get('strCollectionUUID');
      }
      
      const allLinks = Array.from(document.querySelectorAll('a[href*="strCollectionUUID"]'));
      for (const link of allLinks) {
        const url = new URL((link as HTMLAnchorElement).href, window.location.href);
        const uuid = url.searchParams.get('strCollectionUUID');
        if (uuid) return uuid;
      }
      
      return null;
    });
    
    if (!collectionUUID) {
      await log(job.id, 'error', 'STEP:check_stock_fix_no_uuid');
      throw new Error('Collection UUID not found');
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_uuid_found', { uuid: collectionUUID });
    
    // Download Excel file with only essential columns: Style No, Style Name, Stock
    await log(job.id, 'info', 'STEP:check_stock_fix_downloading_excel');
    const excelUrl = `${SPY_BASE_URL}/?controller=Shared%5CTable&action=DownloadExcel&strRendererClass=Spy%5CView%5CStyle%5CStockStatus%5CListTableRenderer&strCollectionUUID=${encodeURIComponent(collectionUUID)}&type=xls&options=${encodeURIComponent(JSON.stringify({
      columns: { 
        "1": true,  // Style No
        "2": true,  // Style Name
        "8": true   // Stock
      },
      check_all: false
    }))}`;
    
    // Trigger download by creating a temporary link and clicking it
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = 'stock_status.xls';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, excelUrl);
    
    await log(job.id, 'info', 'STEP:check_stock_fix_download_triggered');
    const download = await downloadPromise;
    await log(job.id, 'info', 'STEP:check_stock_fix_download_received', { 
      filename: download.suggestedFilename() 
    });
    
    const buffer = await download.createReadStream().then(stream => {
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
    
    await log(job.id, 'info', 'STEP:check_stock_fix_excel_downloaded', { size: buffer.length });
    
    // Parse Excel
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Excel workbook has no sheets');
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      throw new Error(`Sheet ${sheetName} not found in workbook`);
    }
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    
    await log(job.id, 'info', 'STEP:check_stock_fix_excel_parsed', { 
      rows: rawData.length,
      headers: rawData[0],
      sample: rawData.slice(1, 5)
    });
    
    // Parse Excel data into structured format
    await log(job.id, 'info', 'STEP:check_stock_fix_parsing_excel_data');
    const parsedRows: Array<{ 
      style_no: string | null; 
      style_name: string | null; 
      stock: number | null;
    }> = [];
    
    function parseExcelNumber(val: any): number | null {
      if (val === null || val === undefined || val === '') return null;
      const num = Number(val);
      return isNaN(num) ? null : Math.round(num);
    }
    
    function parseExcelString(val: any): string | null {
      if (val === null || val === undefined) return null;
      return String(val).trim() || null;
    }
    
    // Parse Excel rows (skip header row at index 0)
    // Columns: Style No (0), Style Name (1), Stock (2)
    for (const row of rawData.slice(1)) {
      const style_no = parseExcelString(row[0]);
      const style_name = parseExcelString(row[1]);
      const stock = parseExcelNumber(row[2]);
      
      if (style_no) {
        parsedRows.push({
          style_no,
          style_name,
          stock
        });
      }
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_parsed', { rowCount: parsedRows.length });
    
    // Store parsed rows in job result for reference
    await log(job.id, 'info', 'STEP:check_stock_fix_storing_data', { sample: parsedRows.slice(0, 5) });
    
    // Fetch current stock data from database and compare
    // We need to aggregate stock data per style_no from style_stock table
    const styleNos = Array.from(new Set(parsedRows.map(r => r.style_no).filter(Boolean)));
    await log(job.id, 'info', 'STEP:check_stock_fix_fetching_db_stock', { styleCount: styleNos.length });
    
    const { data: stockData, error: stockError } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', styleNos)
      .order('scraped_at', { ascending: false })
      .limit(100000);
    
    if (stockError) {
      await log(job.id, 'error', 'STEP:check_stock_fix_db_error', { error: stockError.message });
      throw new Error(`Failed to fetch stock data: ${stockError.message}`);
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_db_rows_fetched', { 
      total_rows: stockData?.length || 0,
      unique_styles: styleNos.length,
      sample_style: styleNos[0],
      sample_rows: stockData?.filter((r: any) => r.style_no === styleNos[0]).length || 0
    });
    
    // Aggregate stock data per style using same logic as stock-list page
    // Need to deduplicate by (style_no, color, section, row_label) keeping only latest
    const dbStockByStyleNo = new Map<string, number>();
    
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
      
      for (const [color, rows] of byColor.entries()) {
        // Deduplicate: keep latest per (section, row_label)
        const latestMap = new Map<string, any>();
        let uniqueIdCounter = 0;
        
        for (const r of rows) {
          const normalizedLabel = String(r.row_label ?? '').trim();
          
          if (normalizedLabel) {
            // Has a PO number: deduplicate by keeping only latest scraped_at for this PO
            const key = `${r.section}|${normalizedLabel}`;
            const curr = latestMap.get(key);
            if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) {
              latestMap.set(key, r);
            }
          } else {
            // No PO number (NULL/empty): treat each row as a unique unnamed PO
            latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
          }
        }
        
        // Get the Stock section row for this color
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
    
    // Compare and find mismatches
    const mismatches: Array<{ style_no: string; spy_stock: number | null; db_stock: number; diff: number }> = [];
    
    // Log first 10 comparisons for debugging
    const debugSample = parsedRows.slice(0, 10).map(row => {
      const spyStock = row.stock ?? 0;
      const dbStock = row.style_no ? dbStockByStyleNo.get(row.style_no) ?? 0 : 0;
      return {
        style_no: row.style_no,
        spy_stock: spyStock,
        db_stock: dbStock,
        match: spyStock === dbStock
      };
    });
    
    await log(job.id, 'info', 'STEP:check_stock_fix_comparison_sample', { sample: debugSample });
    
    for (const row of parsedRows) {
      if (!row.style_no) continue;
      const styleNo = row.style_no; // TypeScript narrows the type here
      const spyStock = row.stock ?? 0;
      const dbStock = dbStockByStyleNo.get(styleNo) ?? 0;
      const diff = Math.abs(spyStock - dbStock);
      
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
            db_stock: dbStock,
            colors_in_db: byStyle.get(styleNo)?.size || 0
          });
        }
      }
    }
    
    await log(job.id, 'info', 'STEP:check_stock_fix_mismatches_found', { 
      totalChecked: parsedRows.length, 
      mismatchCount: mismatches.length,
      sample: mismatches.slice(0, 10)
    });
    
    // Store mismatches for manual review - DO NOT auto-scrape
    if (mismatches.length > 0) {
      await log(job.id, 'info', 'STEP:check_stock_fix_ready_for_review', { 
        message: 'Mismatches found - ready for manual review',
        styleCount: mismatches.length 
      });
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

