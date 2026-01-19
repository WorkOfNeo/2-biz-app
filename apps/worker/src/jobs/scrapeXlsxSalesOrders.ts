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
    
    // Extract customer IDs from table rows
    const customerIds = await page.evaluate(() => {
      const rows = document.querySelectorAll('.app-outlet table tbody tr');
      const ids: string[] = [];
      
      for (const row of Array.from(rows)) {
        const cells = row.querySelectorAll('td');
        // Second td (index 1) contains the customer link
        const secondCell = cells[1];
        if (!secondCell) continue;
        
        const link = secondCell.querySelector('a');
        if (!link) continue;
        
        const href = link.getAttribute('href') || '';
        // Extract customer_id from URL parameter
        // Example: href="/?Spy\Model\Sale\Customer\RunningSeason\ListReportSearch[bForceSearch]=1&Spy\Model\Sale\Customer\RunningSeason\ListReportSearch[iCustomerID]=878&..."
        const match = href.match(/iCustomerID[=](\d+)/);
        if (match && match[1]) {
          ids.push(match[1]);
        }
      }
      
      return ids;
    });
    
    await log(job.id, 'info', 'STEP:customer_ids_extracted', { count: customerIds.length });
    
    if (customerIds.length === 0) {
      throw new Error('No customer IDs found in table');
    }
    
    // Aggregate data across all customers
    const aggregatedData = new Map<string, ParsedRow>(); // key: style_no|color|size
    
    let processedCount = 0;
    let successCount = 0;
    let failureCount = 0;
    
    // Process each customer sequentially
    for (const customerId of customerIds) {
      await ensureNotCancelled(job.id);
      
      processedCount++;
      await log(job.id, 'progress', 'STEP:processing_customer', { 
        customer_id: customerId, 
        current: processedCount, 
        total: customerIds.length 
      });
      
      let tempFilePath: string | null = null;
      
      try {
        // Download Excel file
        const excelUrl = `${SPY_BASE_URL}/modules/s_orders.add/download_styles_details.php?type=excel&customer_id=${customerId}&customer_ids=${customerId}&season_id=0&delivery_id=0`;
        
        await log(job.id, 'info', 'STEP:downloading_excel', { customer_id: customerId, url: excelUrl });
        
        // Set up download listener
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        
        // Navigate to download URL or use direct request
        const fileContext = page.context();
        const fileResponse = await fileContext.request.get(excelUrl);
        
        if (!fileResponse.ok()) {
          throw new Error(`Download failed: ${fileResponse.status()}`);
        }
        
        const fileBuffer = await fileResponse.body();
        
        // Save to temporary file
        tempFilePath = join(tmpdir(), `sales_order_${customerId}_${Date.now()}.xlsx`);
        writeFileSync(tempFilePath, Buffer.from(fileBuffer));
        
        await log(job.id, 'info', 'STEP:excel_downloaded', { customer_id: customerId, size: fileBuffer.length });
        
        // Parse Excel file
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          throw new Error('No sheet found in Excel file');
        }
        
        const worksheet = workbook.Sheets[sheetName];
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
        if (Object.keys(headerMap).length < 4) {
          headerMap.style_no = headerMap.style_no ?? 0;
          headerMap.color = headerMap.color ?? 1;
          headerMap.size = headerMap.size ?? 2;
          headerMap.qty = headerMap.qty ?? 3;
        }
        
        await log(job.id, 'info', 'STEP:excel_headers', { 
          customer_id: customerId, 
          headers: headerMap,
          total_rows: data.length - 1
        });
        
        // Parse data rows
        let parsedRows = 0;
        for (let i = 1; i < data.length; i++) {
          const row = data[i] || [];
          const style_no = String(row[headerMap.style_no] || '').trim();
          const color = String(row[headerMap.color] || '').trim();
          const size = String(row[headerMap.size] || '').trim();
          const qtyStr = String(row[headerMap.qty] || '0').replace(/[^0-9.\-]/g, '');
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
      total: customerIds.length,
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
      total_customers: customerIds.length,
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
