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
  quantities: number[];
  total: number;
};

type AppPo = {
  id: number;
  po_no: string;
  meta: {
    items: OrderItem[];
  };
};

type StyleMeta = {
  style_no: string;
  style_name: string | null;
  supplier: string | null;
};

// Calculate ETD (7 weeks from now) and ETA (4 days after ETD, next weekday)
function calculateDates(): { etd: string; eta: string } {
  const now = new Date();
  
  // ETD = 7 weeks from now
  const etd = new Date(now);
  etd.setDate(etd.getDate() + (7 * 7));
  
  // ETA = 4 days after ETD
  const eta = new Date(etd);
  eta.setDate(eta.getDate() + 4);
  
  // Adjust ETA to next weekday if it falls on weekend
  const dayOfWeek = eta.getDay();
  if (dayOfWeek === 0) { // Sunday
    eta.setDate(eta.getDate() + 1);
  } else if (dayOfWeek === 6) { // Saturday
    eta.setDate(eta.getDate() + 2);
  }
  
  // Format as MM/DD/YYYY
  const formatDate = (d: Date) => {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    return `${month}/${day}/${year}`;
  };
  
  return {
    etd: formatDate(etd),
    eta: formatDate(eta)
  };
}

export async function pushAppPoToSpy(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:push_po_begin');
    
    // Extract payload
    const payload = job.payload as any;
    const poId = payload?.po_id;
    const seasonId = payload?.season_id;
    
    if (!poId || !seasonId) {
      throw new Error('Missing po_id or season_id in job payload');
    }
    
    await log(job.id, 'info', 'STEP:push_po_payload', { po_id: poId, season_id: seasonId });
    
    // Fetch APP PO data
    const { data: appPo, error: poError } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', poId)
      .eq('category', 'app')
      .single();
    
    if (poError || !appPo) {
      throw new Error(`Failed to fetch APP PO: ${poError?.message || 'not found'}`);
    }
    
    const po = appPo as AppPo;
    await log(job.id, 'info', 'STEP:push_po_fetched', { po_no: po.po_no, items_count: po.meta?.items?.length || 0 });
    
    if (!po.meta?.items || po.meta.items.length === 0) {
      throw new Error('APP PO has no items');
    }
    
    // Fetch season name
    const { data: seasonData, error: seasonError } = await supabase
      .from('seasons')
      .select('name')
      .eq('id', seasonId)
      .single();
    
    if (seasonError || !seasonData) {
      throw new Error(`Failed to fetch season: ${seasonError?.message || 'not found'}`);
    }
    
    const seasonName = seasonData.name;
    await log(job.id, 'info', 'STEP:push_po_season', { season_name: seasonName });
    
    // Get unique style numbers to fetch metadata
    const styleNos = Array.from(new Set(po.meta.items.map(item => item.style_no)));
    
    // Fetch style metadata
    const { data: styleMetaData, error: styleError } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier')
      .in('style_no', styleNos);
    
    if (styleError) {
      throw new Error(`Failed to fetch style metadata: ${styleError.message}`);
    }
    
    const styleMetaMap = new Map<string, StyleMeta>();
    (styleMetaData || []).forEach((meta: any) => {
      styleMetaMap.set(meta.style_no, meta as StyleMeta);
    });
    
    // Group items by supplier
    const itemsBySupplier = new Map<string, OrderItem[]>();
    po.meta.items.forEach(item => {
      const meta = styleMetaMap.get(item.style_no);
      const supplier = meta?.supplier || 'Unknown Supplier';
      
      if (!itemsBySupplier.has(supplier)) {
        itemsBySupplier.set(supplier, []);
      }
      itemsBySupplier.get(supplier)!.push(item);
    });
    
    const suppliers = Array.from(itemsBySupplier.keys());
    await log(job.id, 'progress', 'STAGE:init', { total_suppliers: suppliers.length });
    
    // Calculate dates
    const { etd, eta } = calculateDates();
    await log(job.id, 'info', 'STEP:push_po_dates', { etd, eta });
    
    const spyPoNumbers: string[] = [];
    
    // Process each supplier
    for (let supplierIdx = 0; supplierIdx < suppliers.length; supplierIdx++) {
      const supplier = suppliers[supplierIdx];
      if (!supplier) continue;
      const items = itemsBySupplier.get(supplier);
      if (!items || items.length === 0) continue;
      
      await ensureNotCancelled(job.id);
      await log(job.id, 'progress', 'STAGE:supplier_start', { 
        supplier, 
        current: supplierIdx + 1, 
        total: suppliers.length,
        items_count: items.length
      });
      
      // Navigate to create PO page
      const createPoUrl = `${SPY_BASE_URL}/?controller=Purchase%5CCreate&action=Show`;
      await page.goto(createPoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await log(job.id, 'info', 'STEP:push_po_create_page', { supplier });
      
      // Wait for form to load
      await page.waitForSelector('#POrder\\[iSupplierID\\]', { timeout: 30_000 });
      
      // Select supplier
      const supplierSelect = await page.$('#POrder\\[iSupplierID\\]');
      if (!supplierSelect) {
        await log(job.id, 'error', 'STEP:push_po_supplier_not_found', { supplier });
        continue;
      }
      
      // Find supplier option by text
      const supplierSelected = await page.evaluate((supplierName) => {
        const select = document.querySelector('#POrder\\[iSupplierID\\]') as HTMLSelectElement;
        if (!select) return false;
        
        const options = Array.from(select.options);
        const option = options.find(opt => opt.text.trim() === supplierName);
        
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, supplier);
      
      if (!supplierSelected) {
        await log(job.id, 'error', 'STEP:push_po_supplier_option_not_found', { supplier });
        continue;
      }
      
      await page.waitForTimeout(500); // Wait for any dynamic updates
      
      // Set ETD
      await page.fill('#POrder\\[strETD\\]', etd);
      
      // Set ETA
      await page.fill('#POrder\\[strETA\\]', eta);
      
      // Select season
      const seasonSelected = await page.evaluate((season) => {
        const select = document.querySelector('#POrder\\[iSeasonID\\]') as HTMLSelectElement;
        if (!select) return false;
        
        const options = Array.from(select.options);
        const option = options.find(opt => opt.text.trim() === season);
        
        if (option) {
          select.value = option.value;
          return true;
        }
        return false;
      }, seasonName);
      
      if (!seasonSelected) {
        await log(job.id, 'error', 'STEP:push_po_season_not_found', { season: seasonName });
        throw new Error(`Season "${seasonName}" not found in SPY dropdown`);
      }
      
      // Disable "Only Net Need" checkbox
      const netNeedCheckbox = await page.$('#POrder\\[bNetNeed\\]');
      if (netNeedCheckbox) {
        const isChecked = await netNeedCheckbox.isChecked();
        if (isChecked) {
          await netNeedCheckbox.uncheck();
        }
      }
      
      await log(job.id, 'info', 'STEP:push_po_form_filled', { supplier, etd, eta, season: seasonName });
      
      // Submit form to create PO
      await page.click('button[type="submit"][name="create"]');
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
      await page.waitForTimeout(1000);
      
      await log(job.id, 'progress', 'STAGE:po_created', { supplier });
      
      // Now we should be on the PO edit page - add styles
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        if (!item) continue;
        
        await ensureNotCancelled(job.id);
        await log(job.id, 'progress', 'STAGE:style_adding', { 
          style_no: item.style_no, 
          color: item.color,
          current: itemIdx + 1, 
          total: items.length 
        });
        
        // Wait for the page to be ready
        await page.waitForSelector('[data-tab-name="search"]', { timeout: 30_000 });
        
        // Click on "Add Styles" tab if not already active
        await page.click('[data-tab-name="search"]');
        await page.waitForTimeout(500);
        
        // Search for style by style number
        const searchInput = await page.$('input[name="Spy\\\\Model\\\\Purchase\\\\Edit\\\\Search\\\\ListReportSearch[strStyleNo]"]');
        if (!searchInput) {
          await log(job.id, 'error', 'STEP:push_po_search_input_not_found', { style_no: item.style_no });
          continue;
        }
        
        await searchInput.fill(item.style_no);
        
        // Click search button
        const searchButton = await page.$('button[name="search"]');
        if (searchButton) {
          await searchButton.click();
          await page.waitForTimeout(1000);
        }
        
        // Click on the style in the results table
        const styleClicked = await page.evaluate((styleNo: string) => {
          const rows = document.querySelectorAll('table.standardList tbody tr');
          for (const row of Array.from(rows)) {
            const cells = row.querySelectorAll('td');
            if (cells.length > 0 && cells[0] && cells[0].textContent?.trim() === styleNo) {
              (row as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, item.style_no);
        
        if (!styleClicked) {
          await log(job.id, 'error', 'STEP:push_po_style_not_found', { style_no: item.style_no });
          continue;
        }
        
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await page.waitForTimeout(1000);
        
        // Now on the add style page with color selection
        // Find the color table and locate the specific color
        await log(job.id, 'info', 'STEP:push_po_adding_color', { style_no: item.style_no, color: item.color });
        
        // Find FREE STOCK row for this color
        const quantitiesSet = await page.evaluate((color: string, quantities: number[]) => {
          // Find all tables on the page
          const tables = document.querySelectorAll('table');
          
          for (const table of Array.from(tables)) {
            const rows = table.querySelectorAll('tr');
            
            for (const row of Array.from(rows)) {
              // Check if this row contains the color name
              const colorCell = row.querySelector('td');
              if (colorCell && colorCell.textContent?.trim().includes(color)) {
                // Found the color, now find FREE STOCK row in the same table
                for (const checkRow of Array.from(rows)) {
                  const cells = checkRow.querySelectorAll('td');
                  if (cells.length > 0 && cells[0] && cells[0].textContent?.trim() === 'FREE STOCK') {
                    // Found FREE STOCK row, fill in quantities
                    const inputs = checkRow.querySelectorAll('input[type="number"], input[type="text"]');
                    
                    for (let i = 0; i < Math.min(inputs.length, quantities.length); i++) {
                      const input = inputs[i] as HTMLInputElement;
                      if (input && quantities[i] > 0) {
                        input.value = String(quantities[i]);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    }
                    
                    return true;
                  }
                }
              }
            }
          }
          
          return false;
        }, item.color, item.quantities);
        
        if (!quantitiesSet) {
          await log(job.id, 'error', 'STEP:push_po_color_not_found', { 
            style_no: item.style_no, 
            color: item.color 
          });
          continue;
        }
        
        await log(job.id, 'info', 'STEP:push_po_quantities_set', { 
          style_no: item.style_no, 
          color: item.color,
          quantities: item.quantities
        });
        
        // Click "Add & Exit" button
        const addExitButton = await page.$('button:has-text("Add & Exit")');
        if (addExitButton) {
          await addExitButton.click();
          await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
          await page.waitForTimeout(1000);
        }
        
        await log(job.id, 'progress', 'STAGE:style_added', { style_no: item.style_no, color: item.color });
      }
      
      // All styles added, click "Next" button
      await page.click('[data-tab-name="confirm"]');
      await page.waitForTimeout(1000);
      
      // Capture SPY PO number from the page
      const spyPoNo = await page.evaluate(() => {
        // Look for PO number in the title or page content
        const titleMatch = document.body.textContent?.match(/PO(\d+)/);
        return titleMatch ? `PO${titleMatch[1]}` : null;
      });
      
      if (spyPoNo) {
        spyPoNumbers.push(spyPoNo);
        await log(job.id, 'progress', 'STAGE:po_confirmed', { supplier, spy_po_no: spyPoNo });
      } else {
        await log(job.id, 'error', 'STEP:push_po_no_not_captured', { supplier });
      }
      
      // Click "Confirm" button
      const confirmButton = await page.$('button[name="confirm"]');
      if (confirmButton) {
        await confirmButton.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await page.waitForTimeout(1000);
      }
    }
    
    // Update database with SPY PO numbers
    if (spyPoNumbers.length > 0) {
      const spyPoNoCombined = spyPoNumbers.join(', ');
      
      const { error: updateError } = await supabase
        .from('purchase_orders')
        .update({ spy_po_no: spyPoNoCombined })
        .eq('id', poId);
      
      if (updateError) {
        await log(job.id, 'error', 'STEP:push_po_update_failed', { error: updateError.message });
      } else {
        await log(job.id, 'info', 'STEP:push_po_updated', { spy_po_no: spyPoNoCombined });
      }
    }
    
    await log(job.id, 'progress', 'STAGE:complete');
    await saveResult(job.id, 'Push to SPY completed', { 
      spy_po_numbers: spyPoNumbers,
      suppliers_processed: suppliers.length
    });
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:push_po_error', { 
      error: error?.message || String(error),
      stack: error?.stack
    });
    await setJobFailedOrRequeue(job.id, error?.message || String(error));
  }
}

