import type { Page } from 'playwright-core';
import type { JobRow, ScrapedCustomerData, CustomerDiff, CustomerFieldChange, CustomerRow } from '@shared/types';

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
  findFirst: (page: Page, selectors: string[]) => Promise<import('playwright-core').Locator | null>;
};

export async function scrapeCustomers(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL, findFirst } = ctx;
  await ensureNotCancelled(job.id);
  try {
    await log(job.id, 'info', 'STEP:customers_begin');
    
    // Step 1: Scrape SPY data (unchanged)
    const listUrl = new URL('?controller=Admin%5CCustomer%5CIndex&action=ActiveList', SPY_BASE_URL).toString();
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'STEP:customers_url', { url: listUrl });
    
    await log(job.id, 'info', 'STEP:clicking_show_all');
    try {
      const btn = await findFirst(page, ['button[name="show_all"]']);
      if (btn) { 
        await log(job.id, 'info', 'STEP:show_all_button_found');
        await btn.click({ timeout: 10_000 }).catch(() => {}); 
        await page.waitForTimeout(1000); 
      } else {
        await log(job.id, 'info', 'STEP:show_all_button_not_found');
      }
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:show_all_error', { error: e.message });
    }
    
    await log(job.id, 'info', 'STEP:waiting_for_table');
    await page.waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
    await log(job.id, 'info', 'STEP:table_found');
    
    const rows = await page.$$eval('table.standardList tbody tr', (trs) => {
      function tx(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
      return Array.from(trs).map(tr => {
        const tds = Array.from((tr as HTMLTableRowElement).querySelectorAll('td')) as HTMLElement[];
        const account = tx(tds[9]);      // Account number
        const company = tx(tds[1]);      // Company name
        const city = tx(tds[6]);         // City
        const country = tx(tds[7]);      // Country
        const sales_person = tx(tds[3]); // Sales Person (was tds[5] - FIXED)
        const phone = tx(tds[12]);       // Phone
        const priority = tx(tds[13]);    // Priority (was tds[14] - FIXED)
        const ordersA = (tr as HTMLTableRowElement).querySelector('a[href*="show_sales_order"], a[href*="orders"]') as HTMLAnchorElement | null;
        const orders_link = ordersA ? (ordersA.getAttribute('href') || '') : '';
        const spy_id = (tr as HTMLElement).getAttribute('data-reference') || '';
        return { account, company, city, country, sales_person, phone, priority, orders_link, spy_id };
      });
    });
    
    await log(job.id, 'info', 'STEP:customers_rows', { count: rows.length });
    
    // Step 2: Fetch existing customers
    await log(job.id, 'info', 'STEP:fetching_existing_customers');
    const { data: existingCustomers, error: fetchError } = await supabase
      .from('customers')
      .select('id, customer_id, company, city, country, phone, priority, orders_link, spy_id, salesperson_id, salespersons(name)');
    
    if (fetchError) {
      await log(job.id, 'error', 'STEP:fetch_customers_error', { error: fetchError.message });
      throw fetchError;
    }
    
    await log(job.id, 'info', 'STEP:existing_customers_fetched', { count: (existingCustomers || []).length });
    
    // Step 3: Calculate diff
    await log(job.id, 'info', 'STEP:calculating_diff');
    const diff = await calculateCustomerDiff(rows, existingCustomers || [], supabase, log, job.id);
    
    await log(job.id, 'info', 'STEP:customers_diff', {
      new_count: diff.new.length,
      updated_count: diff.updated.length,
      unchanged_count: diff.unchanged.length,
      orphaned_count: diff.orphaned.length,
      no_account_count: diff.noAccount.length
    });
    
    // Step 4: Auto-apply new + updated customers to the database
    // Get salesperson mapping for inserts/updates
    const { data: spAll } = await supabase.from('salespersons').select('id, name');
    const salespersonByName = new Map<string, string>();
    for (const sp of (spAll ?? []) as any[]) {
      const key = String(sp.name || '').trim().toLowerCase();
      if (key) salespersonByName.set(key, sp.id as string);
    }
    
    // Insert new customers
    let newInserted = 0;
    let newFailed = 0;
    const createdList: string[] = [];
    
    if (diff.new.length > 0) {
      await log(job.id, 'info', 'STEP:inserting_new_customers', { count: diff.new.length });
      
      for (const r of diff.new) {
        if (!r.account) continue;
        
        let salesperson_id: string | null = null;
        const spName = String(r.sales_person || '').trim();
        if (spName) salesperson_id = salespersonByName.get(spName.toLowerCase()) || null;
        
        const { error: insertError } = await supabase.from('customers').insert({
          customer_id: r.account,
          company: r.company,
          city: r.city,
          country: r.country,
          phone: r.phone,
          priority: r.priority,
          orders_link: r.orders_link,
          spy_id: r.spy_id,
          salesperson_id,
          inactive: false
        });
        
        if (insertError) {
          newFailed++;
          await log(job.id, 'error', 'STEP:insert_failed', { account: r.account, company: r.company, error: insertError.message });
        } else {
          newInserted++;
          createdList.push(`${r.account} — ${r.company}`);
        }
      }
      
      if (newInserted > 0) {
        await log(job.id, 'info', 'STEP:created_customers', {
          message: `✅ Created ${newInserted} new customer(s) in database:`,
          created: createdList
        });
      }
      if (newFailed > 0) {
        await log(job.id, 'error', 'STEP:insert_failures', { message: `❌ ${newFailed} insert(s) failed` });
      }
    }
    
    // Update changed customers
    let updatedOk = 0;
    let updatedFailed = 0;
    const updatedList: string[] = [];
    
    if (diff.updated.length > 0) {
      await log(job.id, 'info', 'STEP:updating_customers', { count: diff.updated.length });
      
      for (const updated of diff.updated) {
        const scrapedRow = rows.find((r: any) => r.account === updated.customer_id);
        if (!scrapedRow) continue;
        
        let salesperson_id: string | null = null;
        const spName = String(scrapedRow.sales_person || '').trim();
        if (spName) salesperson_id = salespersonByName.get(spName.toLowerCase()) || null;
        
        const { error: updateError } = await supabase.from('customers').update({
          company: scrapedRow.company,
          city: scrapedRow.city,
          country: scrapedRow.country,
          phone: scrapedRow.phone,
          priority: scrapedRow.priority,
          orders_link: scrapedRow.orders_link,
          spy_id: scrapedRow.spy_id,
          salesperson_id,
          inactive: false
        }).eq('id', updated.id);
        
        if (updateError) {
          updatedFailed++;
          await log(job.id, 'error', 'STEP:update_failed', { id: updated.id, customer_id: updated.customer_id, error: updateError.message });
        } else {
          updatedOk++;
          updatedList.push(`${updated.customer_id} — ${updated.company}`);
        }
      }
      
      if (updatedOk > 0) {
        await log(job.id, 'info', 'STEP:updated_customers', {
          message: `✅ Updated ${updatedOk} customer(s) in database:`,
          updated: updatedList
        });
      }
      if (updatedFailed > 0) {
        await log(job.id, 'error', 'STEP:update_failures', { message: `❌ ${updatedFailed} update(s) failed` });
      }
    }
    
    // Step 5: Store preview (for audit + orphaned review)
    await log(job.id, 'info', 'STEP:storing_preview');
    const { data: preview, error: previewError } = await supabase
      .from('customer_scrape_previews')
      .insert({
        job_id: job.id,
        scraped_data: rows,
        diff_data: diff,
        // Mark as applied since we just did it
        applied_at: new Date().toISOString()
      })
      .select('id')
      .single();
    
    if (previewError) {
      await log(job.id, 'error', 'STEP:preview_insert_error', { error: previewError.message });
      // Don't throw — customers are already written, preview is just for audit
    }
    
    await log(job.id, 'info', 'STEP:preview_stored', { preview_id: preview?.id });
    
    const resultData = {
      preview_id: preview?.id,
      scraped: rows.length,
      new_found: diff.new.length,
      new_created: newInserted,
      new_failed: newFailed,
      updated_found: diff.updated.length,
      updated_applied: updatedOk,
      updated_failed: updatedFailed,
      unchanged: diff.unchanged.length,
      orphaned: diff.orphaned.length,
      noAccount: diff.noAccount.length
    };
    
    await log(job.id, 'info', 'STEP:saving_result', resultData);
    await saveResult(job.id, 'scrape_customers', resultData);
    
    // Note about orphaned if any
    if (diff.orphaned.length > 0) {
      await log(job.id, 'info', 'STEP:orphaned_need_review', {
        message: `⚠️  ${diff.orphaned.length} orphaned customer(s) found (in DB but not in SPY). Review at /settings/customers/scrape to mark inactive.`,
        orphaned: diff.orphaned.slice(0, 20).map((c: any) => `${c.customer_id} — ${c.company || '(no name)'}`)
      });
    }
    
    await setJobSucceeded(job.id);
    await log(job.id, 'info', 'STEP:job_succeeded');
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:scrape_failed', { 
      error: e?.message || String(e),
      stack: e?.stack || 'no stack trace'
    });
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

async function calculateCustomerDiff(
  scrapedRows: any[],
  existingCustomers: any[],
  supabase: any,
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>,
  jobId: string
): Promise<CustomerDiff> {
  const { data: spAll } = await supabase.from('salespersons').select('id, name');
  const salespersonByName = new Map<string, string>();
  for (const sp of (spAll ?? []) as any[]) {
    const key = String(sp.name || '').trim().toLowerCase();
    if (key) salespersonByName.set(key, sp.id as string);
  }
  
  const existingByCustomerId = new Map<string, any>();
  for (const c of existingCustomers) {
    existingByCustomerId.set(c.customer_id, c);
  }
  
  const scrapedCustomerIds = new Set<string>();
  const newCustomers: ScrapedCustomerData[] = [];
  const updatedCustomers: any[] = [];
  const unchangedCustomers: any[] = [];
  const noAccountCustomers: ScrapedCustomerData[] = [];
  
  for (const r of scrapedRows) {
    // Track customers without account numbers separately
    if (!r.account || !r.account.trim()) {
      noAccountCustomers.push(r);
      continue;
    }
    scrapedCustomerIds.add(r.account);
    
    const existing = existingByCustomerId.get(r.account);
    
    if (!existing) {
      // New customer
      newCustomers.push(r);
    } else {
      // Check for changes
      const spName = String(r.sales_person || '').trim();
      const salesperson_id = spName ? (salespersonByName.get(spName.toLowerCase()) || null) : null;
      
      const changes: CustomerFieldChange[] = [];
      
      const fieldMap = [
        { field: 'company', newVal: r.company, oldVal: existing.company },
        { field: 'city', newVal: r.city, oldVal: existing.city },
        { field: 'country', newVal: r.country, oldVal: existing.country },
        { field: 'phone', newVal: r.phone, oldVal: existing.phone },
        { field: 'priority', newVal: r.priority, oldVal: String(existing.priority || '') },
        { field: 'orders_link', newVal: r.orders_link, oldVal: existing.orders_link },
        { field: 'spy_id', newVal: r.spy_id, oldVal: existing.spy_id },
        { field: 'salesperson', newVal: spName, oldVal: existing.salespersons?.name || '' }
      ];
      
      for (const { field, newVal, oldVal } of fieldMap) {
        const nv = String(newVal || '').trim();
        const ov = String(oldVal || '').trim();
        if (nv !== ov) {
          changes.push({ field, oldValue: ov, newValue: nv });
        }
      }
      
      if (changes.length > 0) {
        updatedCustomers.push({
          id: existing.id,
          customer_id: existing.customer_id,
          company: existing.company || '',
          changes
        });
      } else {
        // No changes - unchanged customer
        unchangedCustomers.push({
          id: existing.id,
          customer_id: existing.customer_id,
          company: existing.company || '',
          city: existing.city || '',
          country: existing.country || ''
        });
      }
    }
  }
  
  // Find orphaned customers
  const orphanedCustomers: CustomerRow[] = [];
  for (const existing of existingCustomers) {
    if (!scrapedCustomerIds.has(existing.customer_id)) {
      orphanedCustomers.push(existing);
    }
  }
  
  return {
    new: newCustomers,
    updated: updatedCustomers,
    unchanged: unchangedCustomers,
    orphaned: orphanedCustomers,
    noAccount: noAccountCustomers
  };
}

export async function applyCustomerScrapePreview(ctx: Omit<Ctx, 'page' | 'findFirst' | 'SPY_BASE_URL'>) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase } = ctx;
  await ensureNotCancelled(job.id);
  
  try {
    const previewId = job.payload?.previewId;
    if (!previewId) throw new Error('Missing previewId in payload');
    
    await log(job.id, 'info', 'STEP:apply_preview_begin', { previewId });
    
    // Fetch preview data
    const { data: preview } = await supabase
      .from('customer_scrape_previews')
      .select('*')
      .eq('id', previewId)
      .single();
    
    if (!preview) throw new Error('Preview not found');
    if (preview.applied_at) throw new Error('Preview already applied');
    
    const scrapedData = preview.scraped_data as any[];
    const diffData = preview.diff_data as CustomerDiff;
    
    await log(job.id, 'info', 'STEP:applying_changes', {
      new_count: diffData.new.length,
      updated_count: diffData.updated.length
    });
    
    // Get salesperson mapping
    const { data: spAll } = await supabase.from('salespersons').select('id, name');
    const salespersonByName = new Map<string, string>();
    for (const sp of (spAll ?? []) as any[]) {
      const key = String(sp.name || '').trim().toLowerCase();
      if (key) salespersonByName.set(key, sp.id as string);
    }
    
    // Apply new customers
    let newInserted = 0;
    let newFailed = 0;
    const newDetails: { account: string; company: string; status: string; error?: string }[] = [];
    
    for (const r of diffData.new) {
      if (!r.account) {
        await log(job.id, 'info', 'STEP:apply_skip_no_account', { company: r.company });
        continue;
      }
      
      let salesperson_id: string | null = null;
      const spName = String(r.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
      }
      
      const { error: insertError } = await supabase.from('customers').insert({
        customer_id: r.account,
        company: r.company,
        city: r.city,
        country: r.country,
        phone: r.phone,
        priority: r.priority,
        orders_link: r.orders_link,
        spy_id: r.spy_id,
        salesperson_id,
        inactive: false
      });
      
      if (insertError) {
        newFailed++;
        newDetails.push({ account: r.account, company: r.company || '', status: 'failed', error: insertError.message });
        await log(job.id, 'error', 'STEP:apply_insert_failed', { account: r.account, company: r.company, error: insertError.message });
      } else {
        newInserted++;
        newDetails.push({ account: r.account, company: r.company || '', status: 'ok' });
        await log(job.id, 'info', 'STEP:apply_inserted', { account: r.account, company: r.company });
      }
    }
    
    // Apply updates
    let updatedOk = 0;
    let updatedFailed = 0;
    const updateDetails: { id: string; customer_id: string; company: string; status: string; error?: string }[] = [];
    
    for (const updated of diffData.updated) {
      const scrapedRow = scrapedData.find((r: any) => r.account === updated.customer_id);
      if (!scrapedRow) {
        await log(job.id, 'info', 'STEP:apply_update_skip_no_match', { id: updated.id, customer_id: updated.customer_id });
        continue;
      }
      
      let salesperson_id: string | null = null;
      const spName = String(scrapedRow.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
      }
      
      const { error: updateError } = await supabase.from('customers').update({
        company: scrapedRow.company,
        city: scrapedRow.city,
        country: scrapedRow.country,
        phone: scrapedRow.phone,
        priority: scrapedRow.priority,
        orders_link: scrapedRow.orders_link,
        spy_id: scrapedRow.spy_id,
        salesperson_id,
        inactive: false
      }).eq('id', updated.id);
      
      if (updateError) {
        updatedFailed++;
        updateDetails.push({ id: updated.id, customer_id: updated.customer_id, company: updated.company || '', status: 'failed', error: updateError.message });
        await log(job.id, 'error', 'STEP:apply_update_failed', { id: updated.id, customer_id: updated.customer_id, error: updateError.message });
      } else {
        updatedOk++;
        updateDetails.push({ id: updated.id, customer_id: updated.customer_id, company: updated.company || '', status: 'ok' });
      }
    }
    
    await log(job.id, 'info', 'STEP:apply_updates_done', { ok: updatedOk, failed: updatedFailed });
    
    // Mark orphaned customers as inactive (instead of deleting)
    if (diffData.orphaned.length > 0) {
      const orphanedIds = diffData.orphaned.map(c => c.id);
      const { error: orphanError } = await supabase
        .from('customers')
        .update({ inactive: true })
        .in('id', orphanedIds);
      if (orphanError) {
        await log(job.id, 'error', 'STEP:orphaned_mark_failed', { count: orphanedIds.length, error: orphanError.message });
      } else {
        await log(job.id, 'info', 'STEP:orphaned_marked_inactive', { count: orphanedIds.length });
      }
    }
    
    // Mark preview as applied
    const { error: markError } = await supabase
      .from('customer_scrape_previews')
      .update({ applied_at: new Date().toISOString() })
      .eq('id', previewId);
    
    if (markError) {
      await log(job.id, 'error', 'STEP:mark_applied_failed', { error: markError.message });
    }
    
    // Summary logs
    if (newInserted > 0) {
      await log(job.id, 'info', 'STEP:created_customers', {
        message: `✅ Created ${newInserted} new customer(s) in database:`,
        created: newDetails.filter(d => d.status === 'ok').map(d => `${d.account} — ${d.company}`)
      });
    }
    if (updatedOk > 0) {
      await log(job.id, 'info', 'STEP:updated_customers', {
        message: `✅ Updated ${updatedOk} customer(s) in database:`,
        updated: updateDetails.filter(d => d.status === 'ok').map(d => `${d.customer_id} — ${d.company}`)
      });
    }
    if (newFailed > 0 || updatedFailed > 0) {
      await log(job.id, 'error', 'STEP:apply_failures', {
        message: `❌ ${newFailed} insert(s) failed, ${updatedFailed} update(s) failed`,
        failed_inserts: newDetails.filter(d => d.status === 'failed'),
        failed_updates: updateDetails.filter(d => d.status === 'failed')
      });
    }
    
    await log(job.id, 'info', 'STEP:apply_complete', {
      new_inserted: newInserted,
      new_failed: newFailed,
      updated_ok: updatedOk,
      updated_failed: updatedFailed
    });
    
    await saveResult(job.id, 'apply_customer_preview', {
      preview_id: previewId,
      new_inserted: newInserted,
      new_failed: newFailed,
      updated_ok: updatedOk,
      updated_failed: updatedFailed,
      orphaned_marked_inactive: diffData.orphaned.length,
      new_details: newDetails,
      update_details: updateDetails
    });
    
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


