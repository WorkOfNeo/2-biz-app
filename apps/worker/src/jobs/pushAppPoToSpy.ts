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
    
    // Fetch season data including spy_season_id
    const { data: seasonData, error: seasonError } = await supabase
      .from('seasons')
      .select('id, name, spy_season_id')
      .eq('id', seasonId)
      .single();
    
    if (seasonError || !seasonData) {
      throw new Error(`Failed to fetch season: ${seasonError?.message || 'not found'}`);
    }
    
    if (!seasonData.spy_season_id) {
      throw new Error(`Season "${seasonData.name}" (${seasonId}) has no spy_season_id mapping. Please set it in the database.`);
    }
    
    const spySeasonId = seasonData.spy_season_id;
    await log(job.id, 'info', 'STEP:push_po_season', { 
      season_name: seasonData.name,
      spy_season_id: spySeasonId 
    });
    
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
    
    // Validate that all items have valid style metadata with suppliers
    const itemsWithoutMeta = po.meta.items.filter(item => !styleMetaMap.get(item.style_no));
    if (itemsWithoutMeta.length > 0) {
      await log(job.id, 'error', 'STEP:push_po_missing_styles', { 
        missing_styles: itemsWithoutMeta.map(i => i.style_no) 
      });
      throw new Error(`${itemsWithoutMeta.length} items have no style metadata in database`);
    }
    
    const itemsWithoutSupplier = po.meta.items.filter(item => {
      const meta = styleMetaMap.get(item.style_no);
      return !meta || !meta.supplier;
    });
    if (itemsWithoutSupplier.length > 0) {
      await log(job.id, 'error', 'STEP:push_po_missing_suppliers', { 
        styles: itemsWithoutSupplier.map(i => i.style_no) 
      });
      throw new Error(`${itemsWithoutSupplier.length} items have no supplier in database`);
    }
    
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
      
      // Get available suppliers from SPY
      const availableSuppliers = await page.evaluate(() => {
        const select = document.querySelector('#POrder\\[iSupplierID\\]') as HTMLSelectElement;
        if (!select) return [];
        return Array.from(select.options)
          .filter(opt => opt.value !== '0')
          .map(opt => opt.text.trim());
      });
      
      await log(job.id, 'info', 'STEP:push_po_available_suppliers', { 
        looking_for: supplier,
        available: availableSuppliers
      });
      
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
        await log(job.id, 'error', 'STEP:push_po_supplier_option_not_found', { 
          supplier,
          available_suppliers: availableSuppliers
        });
        throw new Error(`Supplier "${supplier}" not found in SPY. Available: ${availableSuppliers.join(', ')}`);
      }
      
      await page.waitForTimeout(500); // Wait for any dynamic updates
      
      // Set ETD
      await page.fill('#POrder\\[strETD\\]', etd);
      
      // Set ETA
      await page.fill('#POrder\\[strETA\\]', eta);
      
      // Log available seasons for debugging
      const availableSeasons = await page.evaluate(() => {
        const select = document.querySelector('#POrder\\[iSeasonID\\]') as HTMLSelectElement;
        if (!select) return [];
        return Array.from(select.options).map(opt => ({ 
          value: opt.value, 
          text: opt.text.trim() 
        }));
      });
      await log(job.id, 'info', 'STEP:push_po_available_seasons', { 
        seasons: availableSeasons,
        looking_for_id: spySeasonId
      });
      
      // Use spy_season_id to select season
      const seasonSelected = await page.evaluate((seasonId) => {
        const select = document.querySelector('#POrder\\[iSeasonID\\]') as HTMLSelectElement;
        if (!select) return false;
        
        // SPY dropdown values are the spy_season_id integers
        const option = Array.from(select.options).find(opt => opt.value === String(seasonId));
        
        if (option) {
          select.value = String(seasonId);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, spySeasonId);
      
      if (!seasonSelected) {
        await log(job.id, 'error', 'STEP:push_po_season_not_found', { 
          spy_season_id: spySeasonId,
          available_seasons: availableSeasons
        });
        throw new Error(`Season ID ${spySeasonId} not found in SPY dropdown. Please verify spy_season_id mapping.`);
      }
      
      // Check for and dismiss any sweet alert modals first
      const sweetAlertButton = await page.$('.sweet-alert button');
      if (sweetAlertButton) {
        await log(job.id, 'info', 'STEP:dismissing_sweet_alert');
        await sweetAlertButton.click();
        await page.waitForTimeout(500);
      }
      
      // Disable "Only Net Need" checkbox
      await log(job.id, 'info', 'STEP:unchecking_net_need');
      const netNeedCheckbox = await page.$('#POrder\\[bNetNeed\\]');
      if (netNeedCheckbox) {
        const isChecked = await netNeedCheckbox.isChecked();
        if (isChecked) {
          // Use evaluate to directly uncheck via JavaScript to avoid interception issues
          await page.evaluate(() => {
            const checkbox = document.querySelector('#POrder\\[bNetNeed\\]') as HTMLInputElement;
            if (checkbox && checkbox.checked) {
              checkbox.checked = false;
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          await log(job.id, 'info', 'STEP:net_need_unchecked');
        }
      }
      
      await log(job.id, 'info', 'STEP:push_po_form_filled', { 
        supplier, 
        etd, 
        eta, 
        season_name: seasonData.name,
        spy_season_id: spySeasonId 
      });
      
      // Submit form to create PO
      await page.click('button[type="submit"][name="create"]');
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
      await page.waitForTimeout(1000);
      
      await log(job.id, 'progress', 'STAGE:po_created', { supplier });
      
      // Wait for #MainContent to load
      await page.waitForSelector('#MainContent', { timeout: 30_000 });
      
      // IMPORTANT: Set Net Need filter to "All"
      await log(job.id, 'info', 'STEP:setting_net_need_filter');
      const netNeedSelect = await page.$('select[name="Spy\\\\Model\\\\Purchase\\\\Edit\\\\Search\\\\ListReportSearch[strNetNeed]"]');
      if (netNeedSelect) {
        await page.selectOption('select[name="Spy\\\\Model\\\\Purchase\\\\Edit\\\\Search\\\\ListReportSearch[strNetNeed]"]', 'all');
        await page.waitForTimeout(1000);
        await log(job.id, 'info', 'STEP:net_need_filter_set_to_all');
      }
      
      // Group items by style_no for this supplier
      const itemsByStyle = new Map<string, OrderItem[]>();
      items.forEach(item => {
        if (!itemsByStyle.has(item.style_no)) {
          itemsByStyle.set(item.style_no, []);
        }
        itemsByStyle.get(item.style_no)!.push(item);
      });
      
      // Process each style
      for (const [styleNo, styleItems] of itemsByStyle.entries()) {
        await ensureNotCancelled(job.id);
        await log(job.id, 'progress', 'STAGE:style_adding', { 
          style_no: styleNo, 
          colors_count: styleItems.length
        });
        
        // Find style link in table
        await page.waitForSelector('#TableContainer table', { timeout: 30_000 });
        
        const styleLinkClicked = await page.evaluate((searchStyleNo) => {
          const links = document.querySelectorAll('#TableContainer table a[href*="iStyleID"]');
          for (const link of Array.from(links)) {
            if (link.textContent?.trim() === searchStyleNo) {
              (link as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, styleNo);
        
        if (!styleLinkClicked) {
          await log(job.id, 'error', 'STEP:style_not_found_in_table', { style_no: styleNo });
          continue;
        }
        
        // Wait for add section to appear
        await page.waitForSelector('[data-help_id="purchase_orders.add"]', { state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(1000);
        await log(job.id, 'info', 'STEP:style_add_section_loaded', { style_no: styleNo });
        
        // Clear all color inputs first
        await log(job.id, 'info', 'STEP:clearing_color_inputs');
        const clearButtons = await page.$$('div.clearButton');
        for (const btn of clearButtons) {
          try {
            await btn.click();
            await page.waitForTimeout(100);
          } catch (e) {
            // Button might not be clickable, continue
          }
        }
        await page.waitForTimeout(500);
        
        // Fetch sizes for this style from database to know the order
        const { data: stockData, error: stockError } = await supabase
          .from('style_stock')
          .select('style_no, color, sizes')
          .eq('style_no', styleNo)
          .eq('section', 'Stock')
          .limit(1);
        
        let sizeOrder: string[] = [];
        if (stockData && stockData.length > 0) {
          sizeOrder = stockData[0].sizes || [];
        }
        
        // Process each color for this style
        for (const colorItem of styleItems) {
          await log(job.id, 'info', 'STEP:processing_color', { 
            style_no: styleNo, 
            color: colorItem.color 
          });
          
          // Find color box by matching color name
          const colorBoxId = await page.evaluate((colorText) => {
            const spans = Array.from(document.querySelectorAll('.colorBox .color-name'));
            const matchingSpan = spans.find(s => s.textContent?.trim() === colorText);
            if (!matchingSpan) return null;
            const colorBox = matchingSpan.closest('.colorBox');
            return colorBox?.id || null;
          }, colorItem.color);
          
          if (!colorBoxId) {
            await log(job.id, 'error', 'STEP:color_box_not_found', { 
              style_no: styleNo, 
              color: colorItem.color 
            });
            continue;
          }
          
          await log(job.id, 'info', 'STEP:color_box_found', { 
            style_no: styleNo, 
            color: colorItem.color,
            box_id: colorBoxId
          });
          
          // Get size mapping from table headers
          const sizeMapping = await page.evaluate((boxId) => {
            const box = document.getElementById(boxId);
            if (!box) return [];
            const headers = box.querySelectorAll('th[data-size_master_id]');
            return Array.from(headers).map((h, idx) => ({
              position: idx,
              size: h.textContent?.trim() || '',
              sizeMasterId: h.getAttribute('data-size_master_id')
            }));
          }, colorBoxId);
          
          await log(job.id, 'info', 'STEP:size_mapping_retrieved', { 
            style_no: styleNo,
            color: colorItem.color,
            size_mapping: sizeMapping
          });
          
          // Fill inputs by position
          for (let i = 0; i < colorItem.quantities.length; i++) {
            const qty = colorItem.quantities[i];
            if (qty === undefined || qty === 0) continue;
            
            const sizeInfo = sizeMapping[i];
            if (!sizeInfo) {
              await log(job.id, 'error', 'STEP:size_info_missing', { 
                position: i, 
                quantity: qty 
              });
              continue;
            }
            
            // Fill the input
            const filled = await page.evaluate((args: { boxId: string; sizeMasterId: string | null; quantity: number }) => {
              const box = document.getElementById(args.boxId);
              if (!box || !args.sizeMasterId) return false;
              
              const input = box.querySelector(`tr.cBinputLine input[data-sizeset-size-id="${args.sizeMasterId}"]`) as HTMLInputElement;
              if (input) {
                input.value = String(args.quantity);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
              return false;
            }, { boxId: colorBoxId, sizeMasterId: sizeInfo.sizeMasterId, quantity: qty });
            
            if (filled) {
              await log(job.id, 'info', 'STEP:quantity_filled', { 
                size: sizeInfo.size, 
                quantity: qty 
              });
            }
          }
        }
        
        // Click "Add & Exit" button
        await log(job.id, 'info', 'STEP:clicking_add_exit');
        const addExitButton = await page.$('button[name="add_and_exit"]');
        if (addExitButton) {
          await addExitButton.click();
          
          // Wait for loader to disappear
          await page.waitForFunction(() => {
            const loader = document.querySelector('.spy-view-loader--show');
            return !loader;
          }, { timeout: 30000 });
          
          await page.waitForTimeout(1000);
          await log(job.id, 'info', 'STEP:style_added_successfully', { style_no: styleNo });
        } else {
          await log(job.id, 'error', 'STEP:add_exit_button_not_found', { style_no: styleNo });
        }
        
        await log(job.id, 'progress', 'STAGE:style_added', { style_no: styleNo });
      }
      
      // All styles added, click "Next" button to go to confirm page
      await log(job.id, 'info', 'STEP:clicking_next_to_confirm');
      const nextButton = await page.$('button[name="next"]');
      if (!nextButton) {
        await log(job.id, 'error', 'STEP:next_button_not_found');
        continue;
      }
      
      await nextButton.click();
      await page.waitForSelector('[data-tab-name="confirm"]', { state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1000);
      
      // Extract PO number from confirm page
      const spyPoNo = await page.evaluate(() => {
        const title = document.querySelector('.pagesTitle');
        if (!title) return null;
        const match = title.textContent?.match(/PO(\d+)/);
        return match ? `PO${match[1]}` : null;
      });
      
      if (spyPoNo) {
        spyPoNumbers.push(spyPoNo);
        await log(job.id, 'info', 'STEP:po_number_extracted', { supplier, spy_po_no: spyPoNo });
      } else {
        await log(job.id, 'error', 'STEP:po_number_not_found', { supplier });
      }
      
      // Click "Confirm" button to finalize
      await log(job.id, 'info', 'STEP:clicking_confirm');
      const confirmButton = await page.$('button[name="confirm"]');
      if (confirmButton) {
        await confirmButton.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await page.waitForTimeout(1000);
        await log(job.id, 'progress', 'STAGE:po_confirmed', { supplier, spy_po_no: spyPoNo });
      } else {
        await log(job.id, 'error', 'STEP:confirm_button_not_found');
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

