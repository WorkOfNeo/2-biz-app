/**
 * Scrapes XLSX sales orders from SPY system
 * - Navigates to sales/running page
 * - Extracts customer IDs from table rows
 * - Downloads Excel files for each customer
 * - Parses Excel files to extract style/color/size/quantity data
 * - Aggregates totals per style/color/size across all customers
 * - Stores aggregated data in stock_sales_data table
 * - Deletes temporary Excel files after processing
 */

import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import * as XLSX from 'xlsx';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (jobId: string, error: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
  SPY_BASE_URL: string;
};

interface ParsedRow {
  style_no: string;
  color: string;
  size: string;
  qty: number;
}

export async function scrapeXlsxSalesOrders(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:scrape_xlsx_sales_orders_begin');
    
    // Navigate to sales/running page
    const salesUrl = `${SPY_BASE_URL}/app/sales/running?oReportSearch=%7B%7D`;
    await page.goto(salesUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'STEP:navigated_to_sales_running', { url: salesUrl });
    
    // Wait for table to load
    await log(job.id, 'info', 'STEP:waiting_for_table');
    await page.waitForSelector('.app-outlet table tbody tr', { timeout: 60_000 });
    await page.waitForTimeout(2000); // Wait for hydration
    
    await log(job.id, 'info', 'STEP:table_loaded');
    
    // Click "Show All" button to load all customers (not just first page)
    try {
      const showAllBtn = page.locator('button:has-text("Show all"), a:has-text("Show all"), button:has-text("Vis alle"), a:has-text("Vis alle")').first();
      if (await showAllBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await showAllBtn.click();
        await page.waitForTimeout(3000); // Wait for table to update
        await log(job.id, 'info', 'STEP:show_all_clicked');
      } else {
        await log(job.id, 'info', 'STEP:show_all_not_found', { message: 'No Show All button found, continuing with visible rows' });
      }
    } catch (e: any) {
      await log(job.id, 'info', 'STEP:show_all_skipped', { reason: e?.message || 'Button not clickable' });
    }
    
    // Wait for table to stabilize after Show All
    await page.waitForTimeout(2000);
    
    // Get row count after Show All
    const rowCount = await page.evaluate(() => document.querySelectorAll('.app-outlet table tbody tr').length);
    await log(job.id, 'info', 'STEP:table_row_count', { count: rowCount });
    
    // Extract customer IDs from table rows (with deduplication)
    const customerIds = await page.evaluate(() => {
      const rows = document.querySelectorAll('.app-outlet table tbody tr');
      const idSet = new Set<string>(); // Use Set for deduplication
      
      for (const row of Array.from(rows)) {
        // Find any <a> tag in this row that contains customer_id= in its href
        const links = row.querySelectorAll('a');
        let foundForRow = false;
        
        for (const link of Array.from(links)) {
          if (foundForRow) break; // Only get ONE ID per row
          
          const href = link.getAttribute('href') || '';
          
          // Look for customer_id= in the href (case insensitive, can be iCustomerID or customer_id)
          // Try multiple patterns: customer_id=, iCustomerID=, customerId=, etc.
          const patterns = [
            /customer_id[=](\d+)/i,
            /iCustomerID[=](\d+)/i,
            /customerId[=](\d+)/i,
            /\[iCustomerID\][=](\d+)/i
          ];
          
          for (const pattern of patterns) {
            const match = href.match(pattern);
            if (match && match[1]) {
              idSet.add(match[1]); // Add to Set (auto-dedupes)
              foundForRow = true;
              break; // Found it, move to next link check
            }
          }
        }
      }
      
      return Array.from(idSet); // Convert Set back to Array
    });
    
    await log(job.id, 'info', 'STEP:customer_ids_extracted', { count: customerIds.length });
    
    if (customerIds.length === 0) {
      await log(job.id, 'error', 'STEP:no_customer_ids_found', { 
        message: 'No customer IDs found in table. This may indicate the table is empty or the page structure has changed.' 
      });
      await saveResult(job.id, 'No customer IDs found - job completed with no data', {
        total_customers: 0,
        processed: 0,
        success: 0,
        failure: 0,
        aggregated_rows: 0,
        total_qty: 0,
        reason: 'no_customer_ids_found'
      });
      await setJobSucceeded(job.id);
      return; // Exit early - don't retry for this case
    }
    
    // Apply row limit if specified (for testing)
    const payload = job.payload as any;
    const rowLimit = payload?.rowLimit ? parseInt(String(payload.rowLimit), 10) : null;
    let customersToProcess = customerIds;
    if (rowLimit && rowLimit > 0 && rowLimit < customerIds.length) {
      customersToProcess = customerIds.slice(0, rowLimit);
      await log(job.id, 'info', 'STEP:row_limit_applied', { 
        original_count: customerIds.length, 
        limited_count: customersToProcess.length,
        limit: rowLimit
      });
    }
    
    // Aggregate data across all customers
    const aggregatedData = new Map<string, ParsedRow>(); // key: style_no|color|size
    
    let processedCount = 0;
    let successCount = 0;
    let failureCount = 0;
    
    // Process each customer sequentially
    for (let idx = 0; idx < customersToProcess.length; idx++) {
      const customerId = customersToProcess[idx];
      await ensureNotCancelled(job.id);
      
      processedCount++;
      const percent = Math.round((processedCount / customersToProcess.length) * 100);
      
      // Log progress every customer (frontend polls this)
      await log(job.id, 'progress', 'STEP:processing_customer', { 
        customer_id: customerId, 
        current: processedCount, 
        total: customersToProcess.length,
        percent,
        success_so_far: successCount,
        failure_so_far: failureCount,
        aggregated_keys_so_far: aggregatedData.size
      });
      
      let tempFilePath: string | null = null;
      
      try {
        // Download Excel file using direct HTTP request (more reliable than page.waitForEvent)
        const excelUrl = `${SPY_BASE_URL}/modules/s_orders.add/download_styles_details.php?type=excel&customer_id=${customerId}&customer_ids=${customerId}&season_id=0&delivery_id=0`;
        
        await log(job.id, 'info', 'STEP:downloading_excel', { customer_id: customerId, url: excelUrl });
        
        // Use direct request from browser context (inherits session cookies)
        const fileContext = page.context();
        let fileResponse;
        let fileBuffer: Buffer;
        
        try {
          fileResponse = await fileContext.request.get(excelUrl, { timeout: 30_000 });
          
          if (!fileResponse.ok()) {
            throw new Error(`Download failed with status: ${fileResponse.status()}`);
          }
          
          fileBuffer = Buffer.from(await fileResponse.body());
        } catch (downloadErr: any) {
          await log(job.id, 'error', 'STEP:download_failed', { 
            customer_id: customerId, 
            error: downloadErr?.message || String(downloadErr),
            url: excelUrl
          });
          failureCount++;
          continue; // Skip to next customer
        }
        
        if (!fileBuffer || fileBuffer.length === 0) {
          await log(job.id, 'error', 'STEP:download_empty', { customer_id: customerId });
          failureCount++;
          continue; // Skip to next customer
        }
        
        // Save to temporary file
        tempFilePath = join(tmpdir(), `sales_order_${customerId}_${Date.now()}.xlsx`);
        writeFileSync(tempFilePath, fileBuffer);
        
        await log(job.id, 'info', 'STEP:excel_downloaded', { customer_id: customerId, size: fileBuffer.length });
        
        // Parse Excel file
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          throw new Error('No sheet found in Excel file');
        }
        
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) {
          throw new Error('Worksheet is undefined');
        }
        
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];
        
        if (data.length < 2) {
          await log(job.id, 'info', 'STEP:excel_empty', { customer_id: customerId });
          continue;
        }
        
        // Find header row (usually first row)
        const headerRow = data[0] || [];
        const headerMap: Record<string, number> = {};
        
        // Try to find columns by common names
        for (let i = 0; i < headerRow.length; i++) {
          const header = String(headerRow[i] || '').toLowerCase().trim();
          if (header.includes('style') && !header.includes('name') && !headerMap.style_no) {
            headerMap.style_no = i;
          } else if ((header.includes('color') || header.includes('colour')) && !headerMap.color) {
            headerMap.color = i;
          } else if (header.includes('size') && !headerMap.size) {
            headerMap.size = i;
          } else if ((header.includes('qty') || header.includes('quantity') || header.includes('amount')) && !headerMap.qty) {
            headerMap.qty = i;
          }
        }
        
        // If headers not found, try common column positions (A=style, B=color, C=size, D=qty)
        const styleNoCol = headerMap.style_no ?? 0;
        const colorCol = headerMap.color ?? 1;
        const sizeCol = headerMap.size ?? 2;
        const qtyCol = headerMap.qty ?? 3;
        
        await log(job.id, 'info', 'STEP:excel_headers', { 
          customer_id: customerId, 
          headers: { style_no: styleNoCol, color: colorCol, size: sizeCol, qty: qtyCol },
          total_rows: data.length - 1
        });
        
        // Parse data rows
        let parsedRows = 0;
        for (let i = 1; i < data.length; i++) {
          const row = data[i] || [];
          const style_no = String(row[styleNoCol] || '').trim();
          const color = String(row[colorCol] || '').trim();
          const size = String(row[sizeCol] || '').trim();
          const qtyStr = String(row[qtyCol] || '0').replace(/[^0-9.\-]/g, '');
          const qty = parseFloat(qtyStr) || 0;
          
          // Skip rows with missing essential data
          if (!style_no || !color || !size || qty === 0) {
            continue;
          }
          
          const key = `${style_no}|${color}|${size}`;
          const existing = aggregatedData.get(key);
          
          if (existing) {
            existing.qty += qty;
          } else {
            aggregatedData.set(key, { style_no, color, size, qty });
          }
          
          parsedRows++;
        }
        
        await log(job.id, 'info', 'STEP:excel_parsed', { 
          customer_id: customerId, 
          parsed_rows: parsedRows 
        });
        
        successCount++;
        
      } catch (error: any) {
        failureCount++;
        await log(job.id, 'error', 'STEP:customer_error', { 
          customer_id: customerId, 
          error: error.message || String(error) 
        });
        // Continue with next customer
      } finally {
        // Clean up temporary file
        if (tempFilePath) {
          try {
            unlinkSync(tempFilePath);
            await log(job.id, 'info', 'STEP:temp_file_deleted', { customer_id: customerId });
          } catch (cleanupError: any) {
            await log(job.id, 'error', 'STEP:cleanup_error', { 
              customer_id: customerId, 
              error: cleanupError.message 
            });
          }
        }
      }
    }
    
    await log(job.id, 'info', 'STEP:all_customers_processed', { 
      total: customersToProcess.length,
      original_total: customerIds.length,
      success: successCount,
      failure: failureCount,
      aggregated_keys: aggregatedData.size
    });
    
    // Batch upsert aggregated data to database
    if (aggregatedData.size > 0) {
      await log(job.id, 'info', 'STEP:upserting_to_database', { total_rows: aggregatedData.size });
      
      const rowsToUpsert = Array.from(aggregatedData.values()).map(row => ({
        style_no: row.style_no,
        color: row.color,
        size: row.size,
        total_qty: row.qty,
        scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));
      
      // Batch upsert (1000 at a time)
      for (let i = 0; i < rowsToUpsert.length; i += 1000) {
        const batch = rowsToUpsert.slice(i, i + 1000);
        
        // Use upsert with ON CONFLICT
        const { error: upsertError } = await supabase
          .from('stock_sales_data')
          .upsert(batch, {
            onConflict: 'style_no,color,size',
            ignoreDuplicates: false
          });
        
        if (upsertError) {
          await log(job.id, 'error', 'STEP:upsert_error', { 
            error: upsertError.message, 
            batch_start: i 
          });
        } else {
          await log(job.id, 'info', 'STEP:upsert_batch_success', { 
            batch_start: i, 
            batch_size: batch.length 
          });
        }
      }
      
      // Update updated_at for all rows (since upsert might not trigger the trigger properly)
      const { error: updateError } = await supabase
        .from('stock_sales_data')
        .update({ updated_at: new Date().toISOString() })
        .in('style_no', rowsToUpsert.map(r => r.style_no));
      
      if (updateError) {
        await log(job.id, 'error', 'STEP:update_timestamp_error', { error: updateError.message });
      }
    }
    
    await log(job.id, 'info', 'STEP:scrape_complete');
    await saveResult(job.id, 'Scrape XLSX Sales Orders completed', {
      total_customers: customersToProcess.length,
      original_total_customers: customerIds.length,
      row_limit_applied: rowLimit || null,
      processed: processedCount,
      success: successCount,
      failure: failureCount,
      aggregated_rows: aggregatedData.size,
      total_qty: Array.from(aggregatedData.values()).reduce((sum, row) => sum + row.qty, 0)
    });
    
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:scrape_error', { 
      error: error.message || String(error),
      stack: error.stack
    });
    await setJobFailedOrRequeue(job.id, error?.message || String(error));
  }
}
