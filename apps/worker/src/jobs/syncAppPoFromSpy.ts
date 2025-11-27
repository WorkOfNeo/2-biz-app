/**
 * Syncs an APP PO with SPY system data
 * - Navigates to running orders page
 * - Finds and opens the PO
 * - Verifies quantities match
 * - Downloads and stores revised files (PDF + Excel)
 */

import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (jobId: string, error?: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
  SPY_BASE_URL: string;
};

interface SyncPayload {
  po_id: number;
  spy_po_no: string;
}

export async function syncAppPoFromSpy(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:sync_begin');
    
    const payload = job.payload as SyncPayload;
    if (!payload || !payload.po_id || !payload.spy_po_no) {
      throw new Error('Invalid job payload: missing po_id or spy_po_no');
    }
    
    await log(job.id, 'info', 'STEP:sync_payload', { 
      po_id: payload.po_id, 
      spy_po_no: payload.spy_po_no 
    });
    
    // Fetch APP PO from database
    const { data: appPO, error: poError } = await supabase
      .from('purchase_orders')
      .select('id, po_no, spy_po_no, meta')
      .eq('id', payload.po_id)
      .eq('category', 'app')
      .single();
      
    if (poError || !appPO) {
      throw new Error(`Failed to fetch APP PO: ${poError?.message || 'Not found'}`);
    }
    
    await log(job.id, 'info', 'STEP:sync_po_fetched', { 
      po_no: appPO.po_no,
      spy_po_no: appPO.spy_po_no
    });
    
    await log(job.id, 'progress', 'STAGE:navigating_to_running_orders');
    
    // Navigate to running orders page
    await page.goto(`${SPY_BASE_URL}/app/purchase/running`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    
    // Wait for table to load
    await page.waitForSelector('.app-outlet table', { timeout: 30_000 });
    await page.waitForTimeout(2000);
    
    await log(job.id, 'info', 'STEP:sync_table_loaded');
    
    // Find the PO row by SPY PO number
    const poLinkHref = await page.evaluate((spyPoNo: string) => {
      const rows = document.querySelectorAll('.app-outlet table tbody tr');
      for (const row of Array.from(rows)) {
        const cells = row.querySelectorAll('td');
        // PO No. is in the 3rd column (index 2)
        const poNoCell = cells[2];
        const link = poNoCell?.querySelector('a');
        if (link && link.textContent?.trim() === spyPoNo) {
          return link.getAttribute('href');
        }
      }
      return null;
    }, payload.spy_po_no);
    
    if (!poLinkHref) {
      throw new Error(`PO ${payload.spy_po_no} not found in running orders table`);
    }
    
    await log(job.id, 'info', 'STEP:sync_po_found', { spy_po_no: payload.spy_po_no });
    await log(job.id, 'progress', 'STAGE:opening_po_details');
    
    // Navigate to PO details page
    await page.goto(`${SPY_BASE_URL}${poLinkHref}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-help_id="purchase_order.edit"]', { timeout: 30_000 });
    await page.waitForTimeout(2000);
    
    await log(job.id, 'info', 'STEP:sync_po_details_loaded');
    
    // Extract data from "Added styles" table
    const spyOrderData = await page.evaluate(() => {
      const table = document.querySelector('[data-help_id="purchase_order.edit"] table.standardList');
      if (!table) return null;
      
      const rows = table.querySelectorAll('tbody tr');
      const styles: any[] = [];
      
      for (const row of Array.from(rows)) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 12) continue;
        
        const styleNo = cells[1]?.textContent?.trim() || '';
        const color = cells[4]?.textContent?.trim() || '';
        const qtyText = cells[8]?.textContent?.trim() || '0';
        const qty = parseInt(qtyText.replace(/\D/g, ''), 10) || 0;
        
        if (styleNo) {
          styles.push({ styleNo, color, qty });
        }
      }
      
      // Get total from tfoot
      const tfoot = table.querySelector('tfoot tr');
      const totalCell = tfoot?.querySelectorAll('td')[1]; // 2nd cell has the total qty
      const totalText = totalCell?.textContent?.trim() || '0';
      const total = parseInt(totalText.replace(/\D/g, ''), 10) || 0;
      
      return { styles, total };
    });
    
    if (!spyOrderData) {
      throw new Error('Failed to extract order data from SPY');
    }
    
    await log(job.id, 'info', 'STEP:sync_data_extracted', spyOrderData);
    
    // Verify totals match APP PO
    const appPoItems = (appPO.meta as any)?.items || [];
    const appPoTotal = appPoItems.reduce((sum: number, item: any) => sum + (item.total || 0), 0);
    
    if (appPoTotal !== spyOrderData.total) {
      await log(job.id, 'error', 'STEP:sync_totals_mismatch', {
        app_po_total: appPoTotal,
        spy_total: spyOrderData.total
      });
      throw new Error(`Order totals do not match: APP PO=${appPoTotal}, SPY=${spyOrderData.total}`);
    }
    
    await log(job.id, 'info', 'STEP:sync_totals_verified', { total: appPoTotal });
    await log(job.id, 'progress', 'STAGE:downloading_files');
    
    // Extract revised files
    const revisedFiles = await page.evaluate(() => {
      const fileSection = document.querySelector('#revisedFiles');
      if (!fileSection) return null;
      
      const links = fileSection.querySelectorAll('a[href]');
      const files: { type: string; url: string }[] = [];
      
      for (const link of Array.from(links)) {
        const href = (link as HTMLAnchorElement).href;
        if (href.includes('.pdf')) {
          files.push({ type: 'pdf', url: href });
        } else if (href.includes('.xlsx') || href.includes('.xls')) {
          files.push({ type: 'excel', url: href });
        }
      }
      
      return files;
    });
    
    if (!revisedFiles || revisedFiles.length === 0) {
      await log(job.id, 'info', 'STEP:sync_no_files', { message: 'No revised files found' });
    } else {
      await log(job.id, 'info', 'STEP:sync_files_found', { 
        files: revisedFiles.map((f: { type: string; url: string }) => f.type) 
      });
      
      // Download files and store in Supabase storage
      const downloadedFiles: any[] = [];
      
      for (const file of revisedFiles) {
        try {
          // Download file
          const fileContext = await page.context();
          const fileResponse = await fileContext.request.get(file.url);
          const fileBuffer = await fileResponse.body();
          
          // Generate filename
          const extension = file.type === 'pdf' ? 'pdf' : 'xlsx';
          const fileName = `${payload.spy_po_no}_${file.type}_${Date.now()}.${extension}`;
          const filePath = `app-pos/${payload.po_id}/${fileName}`;
          
          // Upload to Supabase storage
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('documents')
            .upload(filePath, fileBuffer, {
              contentType: file.type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              upsert: false
            });
            
          if (uploadError) {
            await log(job.id, 'error', 'STEP:sync_file_upload_failed', { 
              type: file.type, 
              error: uploadError.message 
            });
          } else {
            downloadedFiles.push({
              type: file.type,
              path: filePath,
              url: file.url
            });
            await log(job.id, 'info', 'STEP:sync_file_uploaded', { 
              type: file.type, 
              path: filePath 
            });
          }
        } catch (fileError: any) {
          await log(job.id, 'error', 'STEP:sync_file_download_failed', { 
            type: file.type, 
            error: fileError.message 
          });
        }
      }
      
      // Update APP PO meta with file references
      if (downloadedFiles.length > 0) {
        const updatedMeta = {
          ...appPO.meta,
          spy_files: downloadedFiles,
          synced_at: new Date().toISOString()
        };
        
        const { error: updateError } = await supabase
          .from('purchase_orders')
          .update({ meta: updatedMeta })
          .eq('id', payload.po_id);
          
        if (updateError) {
          await log(job.id, 'error', 'STEP:sync_meta_update_failed', { 
            error: updateError.message 
          });
        } else {
          await log(job.id, 'info', 'STEP:sync_meta_updated', { 
            files_count: downloadedFiles.length 
          });
        }
      }
    }
    
    await log(job.id, 'progress', 'STAGE:sync_complete');
    await saveResult(job.id, { 
      status: 'success',
      spy_po_no: payload.spy_po_no,
      total_qty: spyOrderData.total,
      files: revisedFiles?.length || 0
    });
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:sync_error', { 
      error: error.message,
      stack: error.stack
    });
    await setJobFailedOrRequeue(job.id);
  }
}

