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

type OrderItem = {
  style_no: string;
  color: string;
  sizes: string[];
  qtyBySize: Record<string, number>;
};

/**
 * Creates a SpySystem Stock order for a customer
 */
export async function createSpyStockOrder(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:create_stock_order_begin');
    
    // Extract payload
    const payload = job.payload as any;
    const seasonId = payload?.season_id ?? 0;
    const customerId = payload?.customer_id;
    const spyCustomerIdOverride = payload?.spy_customer_id_override;
    const items: OrderItem[] = payload?.items || [];
    const dryRun = payload?.dryRun ?? false;
    
    if (!customerId && !spyCustomerIdOverride) {
      throw new Error('Missing customer_id and spy_customer_id_override in job payload');
    }
    
    if (!items || items.length === 0) {
      throw new Error('No items in job payload');
    }
    
    await log(job.id, 'info', 'STEP:payload_validated', { 
      customer_id: customerId,
      spy_customer_id_override: spyCustomerIdOverride,
      season_id: seasonId,
      items_count: items.length,
      dry_run: dryRun
    });
    
    // Resolve spy_id
    let spyId: string | number | null = null;
    
    if (spyCustomerIdOverride) {
      spyId = spyCustomerIdOverride;
      await log(job.id, 'info', 'STEP:using_override_spy_id', { spy_id: spyId });
    } else if (customerId) {
      const { data: customer, error: customerError } = await supabase
        .from('customers')
        .select('spy_id, company')
        .eq('customer_id', customerId)
        .maybeSingle();
      
      if (customerError || !customer) {
        throw new Error(`Failed to fetch customer ${customerId}: ${customerError?.message || 'not found'}`);
      }
      
      if (!customer.spy_id) {
        throw new Error(`Customer ${customerId} (${customer.company}) has no spy_id`);
      }
      
      spyId = customer.spy_id;
      await log(job.id, 'info', 'STEP:resolved_spy_id', { 
        customer_id: customerId,
        company: customer.company,
        spy_id: spyId 
      });
    }
    
    if (!spyId) {
      throw new Error('Could not resolve spy_id');
    }
    
    if (dryRun) {
      await log(job.id, 'info', 'STEP:dry_run_complete', { spy_id: spyId, items_count: items.length });
      await saveResult(job.id, 'Dry run completed', { spy_id: spyId, items_count: items.length });
      await setJobSucceeded(job.id);
      return;
    }
    
    // Navigate to customer edit page
    const customerEditUrl = `${SPY_BASE_URL}/?controller=Admin%5CCustomer%5CEdit&action=Edit&customer_id=${spyId}&uuid=66b8df503d#tab=basic`;
    await page.goto(customerEditUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'STEP:customer_page_loaded', { url: customerEditUrl });
    
    await ensureNotCancelled(job.id);
    await page.waitForTimeout(1000);
    
    // Click "Create Order" button
    await log(job.id, 'info', 'STEP:clicking_create_order');
    const createOrderBtn = await page.$('button[name="create_b2b_order"]');
    if (!createOrderBtn) {
      throw new Error('Create Order button not found');
    }
    
    await createOrderBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await log(job.id, 'info', 'STEP:create_order_clicked');
    
    await ensureNotCancelled(job.id);
    
    // Wait for season selector
    await page.waitForSelector('select#season_id', { timeout: 30_000 });
    await log(job.id, 'info', 'STEP:season_selector_found');
    
    // Set season_id
    await page.selectOption('select#season_id', String(seasonId));
    await log(job.id, 'info', 'STEP:season_selected', { season_id: seasonId });
    
    await page.waitForTimeout(500);
    
    // Click continue button
    await log(job.id, 'info', 'STEP:clicking_continue');
    const continueBtn = await page.$('button[name="btnCreate"]');
    if (!continueBtn) {
      throw new Error('Continue button not found');
    }
    
    await continueBtn.click();
    await page.waitForTimeout(1500);
    await log(job.id, 'info', 'STEP:continue_clicked');
    
    await ensureNotCancelled(job.id);
    
    // Wait for order type dialog
    await page.waitForSelector('#orderTypeConfirm, .ui-dialog', { timeout: 30_000 });
    await log(job.id, 'info', 'STEP:order_type_dialog_found');
    
    await page.waitForTimeout(500);
    
    // Click Stock button
    await log(job.id, 'info', 'STEP:clicking_stock_button');
    const stockBtn = await page.$('input.SubmitButton[data-order_type="1"], input[value="Stock"]');
    if (!stockBtn) {
      throw new Error('Stock button not found');
    }
    
    await stockBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await page.waitForTimeout(2000);
    await log(job.id, 'info', 'STEP:stock_selected');
    
    await ensureNotCancelled(job.id);
    
    // Wait for style search input
    await page.waitForSelector('input#style_search', { timeout: 30_000 });
    await log(job.id, 'info', 'STEP:order_page_loaded');
    
    // Process each style
    let processedCount = 0;
    
    for (const item of items) {
      await ensureNotCancelled(job.id);
      await log(job.id, 'progress', 'STAGE:processing_item', { 
        style_no: item.style_no,
        color: item.color,
        current: processedCount + 1,
        total: items.length
      });
      
      // Search for style
      await log(job.id, 'info', 'STEP:searching_style', { style_no: item.style_no });
      const searchInput = await page.$('input#style_search');
      if (!searchInput) {
        throw new Error('Style search input not found');
      }
      
      // Clear search first
      await searchInput.fill('');
      await page.waitForTimeout(300);
      
      // Search for style
      await searchInput.fill(item.style_no);
      await searchInput.press('Enter');
      await page.waitForTimeout(1500);
      
      // Wait for edit container to update
      await page.waitForSelector('#edit_container', { state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1000);
      await log(job.id, 'info', 'STEP:style_loaded', { style_no: item.style_no });
      
      // Wait for form#addStyle
      await page.waitForSelector('form#addStyle', { timeout: 30_000 });
      await page.waitForTimeout(500);
      
      // Find color box by matching .color-name text
      await log(job.id, 'info', 'STEP:finding_color_box', { color: item.color });
      const colorBoxId = await page.evaluate((colorText) => {
        const spans = Array.from(document.querySelectorAll('.colorBox .color-name'));
        const matchingSpan = spans.find(s => s.textContent?.trim() === colorText);
        if (!matchingSpan) return null;
        const colorBox = matchingSpan.closest('.colorBox');
        return colorBox?.id || null;
      }, item.color);
      
      if (!colorBoxId) {
        await log(job.id, 'error', 'STEP:color_box_not_found', { 
          style_no: item.style_no,
          color: item.color
        });
        throw new Error(`Color box not found for ${item.style_no} - ${item.color}`);
      }
      
      await log(job.id, 'info', 'STEP:color_box_found', { 
        style_no: item.style_no,
        color: item.color,
        box_id: colorBoxId
      });
      
      // Get size mapping from table headers
      const sizeMapping = await page.evaluate((boxId) => {
        const box = document.getElementById(boxId);
        if (!box) return [];
        const headers = box.querySelectorAll('td[data-size_master_id]');
        return Array.from(headers).map((h, idx) => ({
          position: idx,
          size: h.textContent?.trim() || '',
          sizeMasterId: h.getAttribute('data-size_master_id')
        }));
      }, colorBoxId);
      
      await log(job.id, 'info', 'STEP:size_mapping_retrieved', { 
        style_no: item.style_no,
        color: item.color,
        size_mapping: sizeMapping
      });
      
      // Fill quantities
      for (const [size, qty] of Object.entries(item.qtyBySize)) {
        if (!qty || qty === 0) continue;
        
        const sizeInfo = sizeMapping.find(s => s.size.toLowerCase() === size.toLowerCase());
        if (!sizeInfo) {
          await log(job.id, 'error', 'STEP:size_not_found_in_mapping', { 
            size,
            available_sizes: sizeMapping.map(s => s.size)
          });
          continue;
        }
        
        // Fill the input
        const filled = await page.evaluate((args: { boxId: string; sizeMasterId: string | null; quantity: number }) => {
          const box = document.getElementById(args.boxId);
          if (!box || !args.sizeMasterId) return false;
          
          const td = box.querySelector(`tr.cBinputLine td[data-sizeset-size-id="${args.sizeMasterId}"]`);
          if (td) {
            const input = td.querySelector('input[data-type="assortQty"]') as HTMLInputElement;
            if (input) {
              input.value = String(args.quantity);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }, { boxId: colorBoxId, sizeMasterId: sizeInfo.sizeMasterId, quantity: qty });
        
        if (filled) {
          await log(job.id, 'info', 'STEP:quantity_filled', { 
            size: sizeInfo.size,
            quantity: qty
          });
        } else {
          await log(job.id, 'error', 'STEP:quantity_fill_failed', { 
            size: sizeInfo.size,
            quantity: qty
          });
        }
        
        await page.waitForTimeout(200);
      }
      
      // Submit this style (look for "Add" or "Add & Exit" or similar button)
      await log(job.id, 'info', 'STEP:submitting_style');
      
      // Try multiple possible button selectors
      const buttonClicked = await page.evaluate(() => {
        const buttonSelectors = [
          'button[name="add_and_exit"]',
          'button[name="add"]',
          'button.addButton',
          'form#addStyle button[type="submit"]'
        ];
        
        for (const selector of buttonSelectors) {
          const btn = document.querySelector(selector) as HTMLButtonElement;
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return selector;
          }
        }
        return null;
      });
      
      if (buttonClicked) {
        await log(job.id, 'info', 'STEP:style_submitted', { button: buttonClicked });
        await page.waitForTimeout(2000);
      } else {
        await log(job.id, 'error', 'STEP:submit_button_not_found');
        throw new Error('Could not find submit button for style');
      }
      
      processedCount++;
      await log(job.id, 'progress', 'STAGE:item_complete', { 
        style_no: item.style_no,
        color: item.color,
        completed: processedCount,
        total: items.length
      });
    }
    
    await log(job.id, 'progress', 'STAGE:all_items_complete');
    await saveResult(job.id, 'Stock order created successfully', { 
      spy_id: spyId,
      season_id: seasonId,
      items_processed: processedCount
    });
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:create_stock_order_error', { 
      error: error?.message || String(error),
      stack: error?.stack
    });
    await setJobFailedOrRequeue(job.id, error?.message || String(error));
  }
}

