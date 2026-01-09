/**
 * Syncs an APP PO with SPY system data
 * - Navigates to running orders page
 * - Extracts data from table row (no need to open PO)
 * - Verifies quantities match
 * - Downloads and stores revised files (PDF + Excel)
 * - Saves SPY PO URL for easy access
 */

import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

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
    
    // NOTE (2026-01): ETD/ETA sync/backfill is intentionally NOT implemented yet.
    // The longer-term design is a scheduled daily sync that detects changes and pushes updates to SPY.
    // We'll revisit this later; for now, this job only syncs file links + meta.
    const ENABLE_ETD_ETA_SYNC = false;

    // Fetch APP PO from database
    const { data: appPO, error: poError } = await supabase
      .from('app_pos')
      .select('id, po_no, spy_po_no, meta')
      .eq('id', payload.po_id)
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
    
    // Extract data from the table row directly
    const poRowData = await page.evaluate((spyPoNo: string) => {
      const rows = document.querySelectorAll('.app-outlet table tbody tr');
      for (const row of Array.from(rows)) {
        const cells = row.querySelectorAll('td');
        // PO No. is in the 3rd column (index 2)
        const poNoCell = cells[2];
        const link = poNoCell?.querySelector('a');
        if (link && link.textContent?.trim() === spyPoNo) {
          // Extract data from this row
          const supplier = cells[3]?.textContent?.trim() || '';
          const styleNo = cells[5]?.textContent?.trim() || '';
          const stylesCount = cells[6]?.textContent?.trim() || '0';
          const orderedText = cells[7]?.textContent?.trim() || '0';
          const ordered = parseInt(orderedText.replace(/\D/g, ''), 10) || 0;
          
          // Get the PO edit link
          const poEditLink = link.getAttribute('href') || '';
          
          // Get PDF and Excel links from Actions column (index 20)
          const actionsCell = cells[20];
          const pdfLink = actionsCell?.querySelector('a[href*="confirmation.php"]');
          const excelLink = actionsCell?.querySelector('a img[alt="Excel Icon"]')?.closest('a');
          
          return {
            supplier,
            styleNo,
            stylesCount: parseInt(stylesCount, 10),
            ordered,
            poEditLink,
            pdfUrl: pdfLink ? (pdfLink as HTMLAnchorElement).href : null,
            excelUrl: excelLink ? (excelLink as HTMLAnchorElement).href : null
          };
        }
      }
      return null;
    }, payload.spy_po_no);
    
    if (!poRowData) {
      await log(job.id, 'error', 'STEP:sync_po_not_found', { spy_po_no: payload.spy_po_no });
      throw new Error(`PO_NOT_FOUND:${payload.spy_po_no}`);
    }
    
    await log(job.id, 'info', 'STEP:sync_po_found', { spy_po_no: payload.spy_po_no });
    await log(job.id, 'info', 'STEP:sync_data_extracted', {
      supplier: poRowData.supplier,
      styles_count: poRowData.stylesCount,
      total_ordered: poRowData.ordered
    });

    if (ENABLE_ETD_ETA_SYNC) {
      await log(job.id, 'info', 'STEP:sync_dates_not_implemented');
    }
    
    // Verify totals match APP PO
    const appPoItems = (appPO.meta as any)?.items || [];
    const appPoTotal = appPoItems.reduce((sum: number, item: any) => sum + (item.total || 0), 0);
    
    if (appPoTotal !== poRowData.ordered) {
      await log(job.id, 'error', 'STEP:sync_totals_mismatch', {
        app_po_total: appPoTotal,
        spy_total: poRowData.ordered
      });
      throw new Error(`Order totals do not match: APP PO=${appPoTotal}, SPY=${poRowData.ordered}`);
    }
    
    await log(job.id, 'info', 'STEP:sync_totals_verified', { total: appPoTotal });
    await log(job.id, 'progress', 'STAGE:downloading_files');
    
    // Prepare file list from row data
    const revisedFiles: { type: string; url: string }[] = [];
    if (poRowData.pdfUrl) {
      revisedFiles.push({ type: 'pdf', url: poRowData.pdfUrl });
    }
    if (poRowData.excelUrl) {
      revisedFiles.push({ type: 'excel', url: poRowData.excelUrl });
    }
    
    if (revisedFiles.length === 0) {
      await log(job.id, 'info', 'STEP:sync_no_files', { message: 'No files found in row' });
    } else {
      await log(job.id, 'info', 'STEP:sync_files_found', { 
        files: revisedFiles.map((f: { type: string; url: string }) => f.type) 
      });
      
      // Delete old files from storage before uploading new ones
      const existingFiles = (appPO.meta as any)?.spy_files || [];
      if (existingFiles.length > 0) {
        await log(job.id, 'info', 'STEP:sync_deleting_old_files', { count: existingFiles.length });
        
        for (const oldFile of existingFiles) {
          if (oldFile.path) {
            const { error: deleteError } = await supabase.storage
              .from('documents')
              .remove([oldFile.path]);
            
            if (deleteError) {
              await log(job.id, 'error', 'STEP:sync_delete_file_failed', { 
                path: oldFile.path, 
                error: deleteError.message 
              });
            } else {
              await log(job.id, 'info', 'STEP:sync_file_deleted', { path: oldFile.path });
            }
          }
        }
      }
      
      // Download files and store in Supabase storage
      const downloadedFiles: any[] = [];
      
      for (const file of revisedFiles) {
        try {
          await log(job.id, 'info', 'STEP:sync_file_downloading', { type: file.type, url: file.url });
          
          let fileBuffer: Buffer;
          
          // For Excel files, trigger the download via click and capture it
          if (file.type === 'excel') {
            // Set up download listener before clicking
            const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
            
            // Click the Excel link to trigger download
            await page.evaluate((excelUrl: string) => {
              const link = document.querySelector(`a[href="${excelUrl}"]`) as HTMLAnchorElement;
              if (link) link.click();
            }, file.url);
            
            try {
              const download = await downloadPromise;
              const downloadPath = await download.path();
              if (downloadPath) {
                const fs = await import('fs');
                fileBuffer = fs.readFileSync(downloadPath);
                await log(job.id, 'info', 'STEP:sync_excel_captured', { size: fileBuffer.length });
              } else {
                throw new Error('Download path not available');
              }
            } catch (downloadErr: any) {
              // Fallback to direct request if download event fails
              await log(job.id, 'info', 'STEP:sync_excel_fallback', { reason: downloadErr.message });
              const fileContext = await page.context();
              const fileResponse = await fileContext.request.get(file.url);
              fileBuffer = await fileResponse.body();
            }
          } else {
            // For PDF, use direct request (usually works)
            const fileContext = await page.context();
            const fileResponse = await fileContext.request.get(file.url);
            fileBuffer = await fileResponse.body();
          }
          
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
              path: filePath,
              size: fileBuffer.length
            });
          }
        } catch (fileError: any) {
          await log(job.id, 'error', 'STEP:sync_file_download_failed', { 
            type: file.type, 
            error: fileError.message 
          });
        }
      }
      
      // Update APP PO meta with file references and SPY link
      if (downloadedFiles.length > 0) {
        const updatedMeta = {
          ...appPO.meta,
          spy_files: downloadedFiles,
          spy_po_url: `${SPY_BASE_URL}${poRowData.poEditLink}`,
          synced_at: new Date().toISOString()
        };
        
        const { error: updateError } = await supabase
          .from('app_pos')
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
      } else {
        // Even if files were found but failed to download, still save the SPY PO URL
        const updatedMeta = {
          ...appPO.meta,
          spy_po_url: `${SPY_BASE_URL}${poRowData.poEditLink}`,
          synced_at: new Date().toISOString()
        };
        
        const { error: updateError } = await supabase
          .from('app_pos')
          .update({ meta: updatedMeta })
          .eq('id', payload.po_id);
          
        if (updateError) {
          await log(job.id, 'error', 'STEP:sync_meta_update_failed', { 
            error: updateError.message 
          });
        } else {
          await log(job.id, 'info', 'STEP:sync_url_saved');
        }
      }
    }
    
    await log(job.id, 'progress', 'STAGE:sync_complete');
    await saveResult(job.id, 'Sync from SPY completed', { 
      status: 'success',
      spy_po_no: payload.spy_po_no,
      total_qty: poRowData.ordered,
      files: revisedFiles?.length || 0,
      spy_url: `${SPY_BASE_URL}${poRowData.poEditLink}`
    });
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:sync_error', { 
      error: error.message,
      stack: error.stack
    });
    await setJobFailedOrRequeue(job.id, error?.message || String(error));
  }
}

