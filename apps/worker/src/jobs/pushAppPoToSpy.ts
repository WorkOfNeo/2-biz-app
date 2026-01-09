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
  etd: string | null;
  eta: string | null;
  supplier: string | null;
  meta: {
    items: OrderItem[];
  };
};

type StyleMeta = {
  style_no: string;
  style_name: string | null;
  supplier: string | null;
};

const SEL_ONLY_NET_NEED = '#POrder\\[bNetNeed\\]';
const SEL_NET_NEED_FILTER = 'select[name="Spy\\\\Model\\\\Purchase\\\\Edit\\\\Search\\\\ListReportSearch[strNetNeed]"]';

async function ensureOnlyNetNeedOff(page: Page, log?: (msg: string, data?: Record<string, any>) => Promise<void>) {
  try {
    const exists = await page.$(SEL_ONLY_NET_NEED);
    if (!exists) {
      await log?.('STEP:only_net_need_checkbox_missing');
      return;
    }
    let checked = false;
    try {
      checked = await page.isChecked(SEL_ONLY_NET_NEED);
    } catch {
      checked = await page.evaluate(() => {
        const el = document.querySelector('input[name="POrder[bNetNeed]"]') as HTMLInputElement | null;
        return !!el?.checked;
      });
    }
    if (!checked) {
      await log?.('STEP:only_net_need_already_off');
      return;
    }

    // Try standard uncheck first
    try {
      await page.uncheck(SEL_ONLY_NET_NEED, { timeout: 3000 });
    } catch {
      // Fallback: JS set + change event
      await page.evaluate(() => {
        const el = document.querySelector('input[name="POrder[bNetNeed]"]') as HTMLInputElement | null;
        if (!el) return;
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await page.waitForTimeout(250);
    await log?.('STEP:only_net_need_set_off');
  } catch (e: any) {
    await log?.('STEP:only_net_need_set_off_failed', { error: e?.message || String(e) });
  }
}

async function ensureNetNeedFilterAll(page: Page, log?: (msg: string, data?: Record<string, any>) => Promise<void>) {
  try {
    const sel = await page.$(SEL_NET_NEED_FILTER);
    if (!sel) {
      await log?.('STEP:net_need_filter_missing');
      return;
    }
    const current = await page.$eval(SEL_NET_NEED_FILTER, (el) => (el as HTMLSelectElement).value);
    if (current === 'all') {
      await log?.('STEP:net_need_filter_already_all');
      return;
    }
    await page.selectOption(SEL_NET_NEED_FILTER, 'all');
    // The SPY UI updates instantly; wait for its loader if present, then a short settle.
    try {
      await page.waitForFunction(() => !document.querySelector('.spy-view-loader--show'), { timeout: 30_000 });
    } catch {}
    await page.waitForTimeout(600);
    await log?.('STEP:net_need_filter_set_to_all');
  } catch (e: any) {
    await log?.('STEP:net_need_filter_set_failed', { error: e?.message || String(e) });
  }
}

// Format date as MM/DD/YYYY for SPY form
function formatDateForSpy(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

// Get ETD/ETA from app_pos record or calculate defaults
function getDates(
  po: AppPo,
  opts?: { lead_time_days?: number | null; travel_time_days?: number | null }
): { etdSpy: string; etaSpy: string; etdIso: string; etaIso: string; usedDefaults: boolean } {
  const lead = Number(opts?.lead_time_days || 0) || null;
  const travel = Number(opts?.travel_time_days || 0) || null;

  // If dates exist in app_pos, use those
  if (po.etd) {
    const etdDate = new Date(po.etd);
    const etaDate = po.eta ? new Date(po.eta) : new Date(etdDate);
    if (!po.eta) {
      // If no ETA, default to ETD + travel time (if known) or 4 days
      etaDate.setDate(etaDate.getDate() + (travel || 4));
    }
    const etdIso = String(po.etd).split('T')[0] || String(po.etd);
    const etaIso = po.eta ? (String(po.eta).split('T')[0] || String(po.eta)) : etaDate.toISOString().split('T')[0]!;
    return { etdSpy: formatDateForSpy(etdDate), etaSpy: formatDateForSpy(etaDate), etdIso, etaIso, usedDefaults: false };
  }

  // If missing dates: compute from supplier lead/travel time if available, otherwise fallback
  const now = new Date();
  const etd = new Date(now);
  if (lead) etd.setDate(etd.getDate() + lead);
  else etd.setDate(etd.getDate() + (7 * 7)); // fallback 7 weeks

  const eta = new Date(etd);
  eta.setDate(eta.getDate() + (travel || 4));

  // Adjust ETA to next weekday if it falls on weekend
  const dayOfWeek = eta.getDay();
  if (dayOfWeek === 0) eta.setDate(eta.getDate() + 1); // Sunday
  else if (dayOfWeek === 6) eta.setDate(eta.getDate() + 2); // Saturday

  const etdIso = etd.toISOString().split('T')[0]!;
  const etaIso = eta.toISOString().split('T')[0]!;
  return { etdSpy: formatDateForSpy(etd), etaSpy: formatDateForSpy(eta), etdIso, etaIso, usedDefaults: true };
}

/**
 * Pushes an APP PO to the SPY system by automating browser interactions
 */
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
      .from('app_pos')
      .select('*')
      .eq('id', poId)
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

    // Guard rail: if ETD/ETA are missing in app_pos, compute (prefer supplier lead/travel time) and persist
    let lead_time_days: number | null = null;
    let travel_time_days: number | null = null;
    try {
      const supplierName = po.supplier || suppliers[0] || null;
      if (supplierName) {
        const { data: supp } = await supabase
          .from('suppliers')
          .select('lead_time_days, travel_time_days')
          .eq('name', supplierName)
          .maybeSingle();
        lead_time_days = (supp as any)?.lead_time_days ?? null;
        travel_time_days = (supp as any)?.travel_time_days ?? null;
      }
    } catch {}

    const { etdSpy, etaSpy, etdIso, etaIso, usedDefaults } = getDates(po, { lead_time_days, travel_time_days });
    await log(job.id, 'info', 'STEP:push_po_dates', {
      etd: etdIso,
      eta: etaIso,
      from_record: !!po.etd,
      used_defaults: usedDefaults,
      lead_time_days,
      travel_time_days
    });

    try {
      if (!po.etd || !po.eta) {
        const updates: Record<string, any> = {};
        if (!po.etd) updates.etd = etdIso;
        if (!po.eta) updates.eta = etaIso;
        const { error: updErr } = await supabase.from('app_pos').update(updates).eq('id', po.id);
        if (updErr) {
          await log(job.id, 'error', 'STEP:push_po_dates_persist_failed', { error: updErr.message });
        } else {
          await log(job.id, 'info', 'STEP:push_po_dates_persisted', updates);
        }
      }
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:push_po_dates_persist_error', { error: e?.message || String(e) });
    }
    
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
      await page.fill('#POrder\\[strETD\\]', etdSpy);
      
      // Set ETA
      await page.fill('#POrder\\[strETA\\]', etaSpy);
      
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
      
      await log(job.id, 'info', 'STEP:push_po_form_filled', { 
        supplier, 
        etd, 
        eta, 
        season_name: seasonData.name,
        spy_season_id: spySeasonId 
      });

      // IMPORTANT: "Only Net Need" is checked by default in SPY - disable it on create.
      await log(job.id, 'info', 'STEP:ensuring_only_net_need_off');
      await ensureOnlyNetNeedOff(page, async (msg, data) => log(job.id, 'info', msg, { supplier, ...(data || {}) }));
      
      // Check for and dismiss any sweet alert modals before clicking Create
      try {
        // Wait a moment for any alerts to appear
        await page.waitForTimeout(500);
        
        const sweetAlertVisible = await page.isVisible('.sweet-alert.visible, .sweet-alert.showSweetAlert');
        if (sweetAlertVisible) {
          await log(job.id, 'info', 'STEP:dismissing_sweet_alert_before_create');
          
          // Try multiple button selectors for Sweet Alert
          const buttonSelectors = [
            '.sweet-alert.visible button.confirm',
            '.sweet-alert.showSweetAlert button',
            '.sweet-alert button',
            'button.confirm'
          ];
          
          for (const selector of buttonSelectors) {
            try {
              if (await page.isVisible(selector)) {
                await page.click(selector, { timeout: 3000 });
                await page.waitForTimeout(500);
                await log(job.id, 'info', 'STEP:sweet_alert_dismissed');
                break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {
        await log(job.id, 'info', 'STEP:no_sweet_alert_or_already_dismissed');
      }
      
      // Submit form to create PO using JavaScript to bypass any overlays.
      // Guard rail: ensure we actually reach the edit page (net-need filter present).
      await log(job.id, 'info', 'STEP:clicking_create_button');
      let createdOk = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await page.evaluate(() => {
          const createBtn = document.querySelector('button[type="submit"][name="create"]') as HTMLButtonElement;
          if (createBtn) createBtn.click();
        });
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await page.waitForTimeout(800);
        try {
          await page.waitForSelector('#MainContent', { timeout: 20_000 });
        } catch {}
        const hasFilter = await page.$(SEL_NET_NEED_FILTER);
        const hasTable = await page.$('#TableContainer table');
        if (hasFilter || hasTable) {
          createdOk = true;
          break;
        }
        await log(job.id, 'error', 'STEP:po_create_did_not_reach_edit', { supplier, attempt, url: page.url() });
        // If create didn't work, try once more after a short wait.
        await page.waitForTimeout(1200);
      }
      if (!createdOk) {
        throw new Error(`Failed to create SPY PO for supplier "${supplier}" (did not reach edit page)`);
      }
      
      await log(job.id, 'progress', 'STAGE:po_created', { supplier });
      
      // Wait for #MainContent to load
      await page.waitForSelector('#MainContent', { timeout: 30_000 });
      
      // IMPORTANT: Set Net Need filter to "All"
      await log(job.id, 'info', 'STEP:setting_net_need_filter');
      await ensureNetNeedFilterAll(page, async (msg, data) => log(job.id, 'info', msg, { supplier, ...(data || {}) }));
      
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
        
        // Find style link in table. Guard rail: if not found, re-ensure Net Need = All and retry once.
        await ensureNetNeedFilterAll(page, async (msg, data) => log(job.id, 'info', msg, { supplier, style_no: styleNo, ...(data || {}) }));
        await page.waitForSelector('#TableContainer table', { timeout: 30_000 });
        
        const clickStyleLink = async () => {
          return await page.evaluate((searchStyleNo) => {
            const links = document.querySelectorAll('#TableContainer table a[href*="iStyleID"]');
            for (const link of Array.from(links)) {
              if (link.textContent?.trim() === searchStyleNo) {
                (link as HTMLElement).click();
                return true;
              }
            }
            return false;
          }, styleNo);
        };

        let styleLinkClicked = await clickStyleLink();
        if (!styleLinkClicked) {
          await log(job.id, 'error', 'STEP:style_not_found_in_table_first_try', { supplier, style_no: styleNo });
          // If filter isn't all (or UI got stuck), set to all and retry search.
          await ensureNetNeedFilterAll(page, async (msg, data) => log(job.id, 'info', msg, { supplier, style_no: styleNo, ...(data || {}) }));
          await page.waitForTimeout(800);
          styleLinkClicked = await clickStyleLink();
        }

        if (!styleLinkClicked) {
          await log(job.id, 'error', 'STEP:style_not_found_in_table', { supplier, style_no: styleNo, url: page.url() });
          throw new Error(`Style ${styleNo} not found in SPY list for supplier "${supplier}" (Net Need filter set to All)`);
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
          
          // Get size mapping from table headers (td elements, not th)
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
            style_no: styleNo,
            color: colorItem.color,
            size_mapping: sizeMapping
          });
          
          await log(job.id, 'info', 'STEP:quantities_to_fill', { 
            style_no: styleNo,
            color: colorItem.color,
            quantities: colorItem.quantities,
            quantities_length: colorItem.quantities.length
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
            
            // Fill the input (data-sizeset-size-id is on the td, not the input)
            const filled = await page.evaluate((args: { boxId: string; sizeMasterId: string | null; quantity: number }) => {
              const box = document.getElementById(args.boxId);
              if (!box || !args.sizeMasterId) return false;
              
              // Find the td with data-sizeset-size-id, then get the input inside it
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
                quantity: qty,
                sizeMasterId: sizeInfo.sizeMasterId
              });
            } else {
              await log(job.id, 'error', 'STEP:quantity_fill_failed', { 
                size: sizeInfo.size, 
                quantity: qty,
                sizeMasterId: sizeInfo.sizeMasterId,
                boxId: colorBoxId
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
      
      // Use JavaScript click to bypass any visibility issues
      const nextBtnExists = await page.evaluate(() => {
        const nextBtn = document.querySelector('button[name="next"]') as HTMLButtonElement;
        if (nextBtn) {
          nextBtn.click();
          return true;
        }
        return false;
      });
      
      if (!nextBtnExists) {
        await log(job.id, 'error', 'STEP:next_button_not_found');
        continue;
      }
      
      await page.waitForSelector('[data-tab-name="confirm"]', { state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1000);
      
      // Extract PO number from confirm page
      const spyPoNo = await page.evaluate(() => {
        const title = document.querySelector('.pagesTitle');
        if (!title) return null;
        const match = title.textContent?.match(/PO(\d+)/);
        return match ? `PO${match[1]}` : null;
      });
      
      if (!spyPoNo) {
        await log(job.id, 'error', 'STEP:po_number_not_found', { supplier, url: page.url() });
        throw new Error(`SPY PO number not found for supplier "${supplier}" (confirm page)`);
      }
      spyPoNumbers.push(spyPoNo);
      await log(job.id, 'info', 'STEP:po_number_extracted', { supplier, spy_po_no: spyPoNo });
      
      // Click "Confirm" button to finalize (use JavaScript click)
      await log(job.id, 'info', 'STEP:clicking_confirm');
      const confirmBtnExists = await page.evaluate(() => {
        const confirmBtn = document.querySelector('button[name="confirm"]') as HTMLButtonElement;
        if (confirmBtn) {
          confirmBtn.click();
          return true;
        }
        return false;
      });
      
      if (confirmBtnExists) {
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await page.waitForTimeout(1000);
        await log(job.id, 'progress', 'STAGE:po_confirmed', { supplier, spy_po_no: spyPoNo });
      } else {
        await log(job.id, 'error', 'STEP:confirm_button_not_found');
      }
    }
    
    // Guard rail: if we never extracted any SPY PO number, treat as failure
    if (spyPoNumbers.length === 0) {
      throw new Error('Push to SPY did not produce any PO number(s) — order was not confirmed');
    }

    // Update database with SPY PO numbers
    if (spyPoNumbers.length > 0) {
      const spyPoNoCombined = spyPoNumbers.join(', ');
      
      const { error: updateError } = await supabase
        .from('app_pos')
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
    
    // Auto-enqueue sync job to fetch files and verify order
    if (spyPoNumbers.length > 0) {
      const firstSpyPoNo = spyPoNumbers[0];
      await log(job.id, 'info', 'STEP:enqueue_sync', { spy_po_no: firstSpyPoNo });
      
      const { error: syncEnqueueError } = await supabase
        .from('jobs')
        .insert({
          type: 'sync_app_po_from_spy',
          payload: { po_id: poId, spy_po_no: firstSpyPoNo },
          status: 'pending'
        });
      
      if (syncEnqueueError) {
        await log(job.id, 'error', 'STEP:sync_enqueue_failed', { error: syncEnqueueError.message });
      } else {
        await log(job.id, 'info', 'STEP:sync_enqueued', { spy_po_no: firstSpyPoNo });
      }
    }
    
    await setJobSucceeded(job.id);
    
  } catch (error: any) {
    await log(job.id, 'error', 'STEP:push_po_error', { 
      error: error?.message || String(error),
      stack: error?.stack
    });
    await setJobFailedOrRequeue(job.id, error?.message || String(error));
  }
}

